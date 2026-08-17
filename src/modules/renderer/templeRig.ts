/**
 * templeRig.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Scaling the whole model in Z to fit a user's nose-to-ear depth stretches
 *   the lenses and bridge along with the temple arms, visibly warping the
 *   frame's front. Real glasses don't work that way: the front is rigid, and
 *   each temple arm pivots at its hinge — it can splay outward a few degrees
 *   to clear a wider head, drop slightly to rest ON the ear, and its
 *   effective length varies per user. This module reproduces exactly those
 *   degrees of freedom, and nothing else.
 *
 *   Well-authored eyewear GLBs (including every frame `scripts/generate-sample-frames.ts`
 *   produces) follow the same convention: the front (rims/lenses/bridge/nose pads) sits near
 *   Z=0, hinges sit almost exactly at Z=0, and each temple is 1-2 meshes
 *   extending backward (increasingly negative Z) from there — a straight
 *   "arm" segment attached at the hinge, optionally followed by a curved
 *   "tip" segment (the part that hooks behind the ear). This module finds
 *   those meshes generically (by geometry, not by name — names like
 *   "mesh_9" aren't semantic) so the fix works across the whole catalog
 *   without re-authoring every asset.
 *
 * WHAT IT DOES
 *   `buildTempleRig(root)`: walks the model's meshes once (on load), splits
 *   them into "front" (untouched) vs. "temple" (any mesh reaching more than
 *   `TEMPLE_DEPTH_THRESHOLD_M` behind the front plane) per side, and builds
 *   a two-level rig per side, all reparented under `root` so every transform
 *   below is expressed in one consistent (root-local) space:
 *
 *        pivot (at the hinge point; ROTATES → splay/drop)
 *        ├── lengthGroup (SCALES in Z → arm length, stretching away from
 *        │   ├── arm mesh          the hinge, never from the model origin)
 *        │   └── decoration riding on the arm (logo plates, branding text)
 *        └── tip/hook meshes (translated along the arm, never scaled,
 *                             preserving their curved shape)
 *
 *   `updateTempleSide(side, earTargetLocal, fallbackLengthRatio, trust)`:
 *   called once per rendered frame per side. When given a trusted ear target
 *   (the user's tracked ear point, converted by the caller into root-local
 *   space), it aims the arm from the hinge at that point — yaw (outward
 *   splay), pitch (drop onto the ear), and length all follow the REAL
 *   tracked ear instead of a population-average guess. Angles/length are
 *   clamped to anatomically sane ranges and folded in through a slow EMA
 *   (this is a per-user physical constant; it should converge over ~a
 *   second, not jitter per frame). Without a trusted target it falls back
 *   to the caller-provided plain length ratio, straight back.
 *
 * HOW IT COMMUNICATES
 *   - `components/GlassesScene.tsx` calls `buildTempleRig` once when
 *     `modelGroup` changes, converts the tracked ear landmarks into the
 *     model's local space every `useFrame` tick, and calls
 *     `updateTempleSide` for each side.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';

/** Meshes whose local bounding box reaches at least this far behind the front plane (meters) are temple parts, not front parts. */
const TEMPLE_DEPTH_THRESHOLD_M = 0.02;

/**
 * A temple segment must sit (almost) entirely on one side of the model's center plane.
 * This excludes single-mesh models where one mesh's geometry spans both temples at once
 * (e.g. a mesh grouped by material rather than by part, as in the catalog's "hero" GLB) —
 * classifying those would reparent/scale a chunk that isn't actually one temple arm.
 */
const CENTER_STRADDLE_TOLERANCE_M = 0.01;

/**
 * A temple side often ships more than two meshes: besides the arm and its
 * curved ear tip, models carry DECORATION that sits alongside the arm — a logo
 * plate, extruded branding text, a colour inlay. The two kinds must be handled
 * oppositely when the arm resizes: a tip hangs off the END of the arm and must
 * be translated (never scaled, or its hook deforms), while decoration is glued
 * to the arm's flank and must ride WITH it (translating it slides the logo off
 * the arm and onto the lens).
 *
 * They're told apart by overlap: a segment counts as trailing only if it lies
 * essentially behind the arm's far edge, allowing an overlap of this fraction
 * of the segment's own depth (real tips butt up against the arm end, sometimes
 * a hair inside it). Everything else overlaps the arm's length and is treated
 * as decoration. Ratio, not an absolute distance, because model units vary per
 * asset — the catalog is authored in metres, vendor GLBs rarely are.
 */
const TRAILING_OVERLAP_RATIO = 0.25;

/** Max outward/inward splay (yaw at the hinge), radians. Real hinges open a few degrees past straight; ±20° is generous. */
const MAX_SPLAY_RAD = 0.35;
/** Max downward/upward drop (pitch at the hinge), radians (~20°). The temple must reach the ear top, which sits a bit below hinge level. */
const MAX_DROP_RAD = 0.35;
/** Arm-length bounds as a ratio of the authored length. */
const LENGTH_RATIO_MIN = 0.75;
const LENGTH_RATIO_MAX = 1.4;
/**
 * The arm should reach slightly PAST the ear-top target so the curved tip
 * hooks behind the ear rather than the arm ending exactly on top of it.
 */
const EAR_OVERSHOOT = 1.04;
/**
 * Per-update EMA factor for angles/length. Nose-to-ear geometry is a per-user
 * physical constant — converge over ~1s of good tracking instead of chasing
 * per-frame landmark noise.
 */
const SMOOTHING_ALPHA = 0.12;

interface TrailingSegment {
  mesh: THREE.Mesh;
  /** Pivot-local Z of the segment at build time (unstretched arm). */
  originalZ: number;
}

export interface TempleSide {
  /** Positioned at the hinge; its ROTATION aims the whole arm (splay + drop). */
  pivot: THREE.Group;
  /** Child of `pivot`; its `scale.z` stretches the arm away from the hinge. */
  lengthGroup: THREE.Group;
  /** The arm's original (unstretched) length in root-local units. */
  armLength: number;
  /** Hinge position in root-local space (== pivot.position, cached as a plain copy). */
  hinge: THREE.Vector3;
  /** +1 if this temple lives on the model's +X side, -1 for -X — used by callers to match tracked left/right ear targets. */
  sideSign: 1 | -1;
  /** Tip/hook segments further back than the arm — translated, never scaled, to keep their curved shape intact. */
  trailing: TrailingSegment[];
  /** Smoothed fit state (EMA targets). */
  smoothedYaw: number;
  smoothedPitch: number;
  smoothedLengthRatio: number;
  /** True once at least one trusted ear-target update has been folded in. */
  hasEarFix: boolean;
}

export interface TempleRig {
  left: TempleSide | null;
  right: TempleSide | null;
}

/** Computes a mesh's bounding box in `root`'s local space, regardless of `root`'s current position in a live scene. */
function boundsRelativeToRoot(mesh: THREE.Mesh, root: THREE.Object3D): THREE.Box3 {
  const matrix = new THREE.Matrix4();
  const chain: THREE.Object3D[] = [];
  for (let node: THREE.Object3D | null = mesh; node && node !== root; node = node.parent) {
    chain.push(node);
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateMatrix();
    matrix.multiply(chain[i].matrix);
  }
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(matrix);
}

/**
 * Classifies a loaded (cloned) glasses model's meshes into front/temple
 * parts and builds the per-side pivot rig. Returns `null` sides for any
 * model that doesn't have separable temple geometry on that side (e.g. a
 * flat PNG placeholder, or an unusually authored frame) — callers should
 * treat that as "no temple correction available", not an error.
 */
export function buildTempleRig(root: THREE.Group): TempleRig {
  // Guards against double-building (e.g. React StrictMode's dev-mode double effect
  // invocation) reparenting an already-rigged mesh under a second, redundant pivot —
  // return the cached rig instead of re-classifying an already-rigged tree.
  const tagged = root as THREE.Group & { __templeRig?: TempleRig };
  if (tagged.__templeRig) return tagged.__templeRig;

  const candidates: { mesh: THREE.Mesh; box: THREE.Box3 }[] = [];

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as THREE.Object3D & { isMesh?: boolean }).isMesh || !mesh.geometry) return;
    const box = boundsRelativeToRoot(mesh, root);
    if (box.min.z < -TEMPLE_DEPTH_THRESHOLD_M) {
      candidates.push({ mesh, box });
    }
  });

  const leftCandidates = candidates.filter((c) => c.box.max.x <= CENTER_STRADDLE_TOLERANCE_M);
  const rightCandidates = candidates.filter((c) => c.box.min.x >= -CENTER_STRADDLE_TOLERANCE_M);

  const rig: TempleRig = {
    left: buildSide(leftCandidates, root),
    right: buildSide(rightCandidates, root),
  };
  tagged.__templeRig = rig;
  return rig;
}

function buildSide(candidates: { mesh: THREE.Mesh; box: THREE.Box3 }[], root: THREE.Group): TempleSide | null {
  if (candidates.length === 0) return null;

  // Hinge-nearest segment first (largest/least-negative max.z = closest to the front).
  const sorted = [...candidates].sort((a, b) => b.box.max.z - a.box.max.z);
  const [armEntry, ...rest] = sorted;

  const nearEdgeZ = armEntry.box.max.z;
  const farEdgeZ = armEntry.box.min.z;
  const armLength = nearEdgeZ - farEdgeZ;
  if (armLength <= 0) return null;

  // Hinge point: the arm's near (front) edge, at the arm's lateral/vertical center.
  const hinge = new THREE.Vector3(
    (armEntry.box.min.x + armEntry.box.max.x) / 2,
    (armEntry.box.min.y + armEntry.box.max.y) / 2,
    nearEdgeZ,
  );

  // The whole rig lives directly under `root` so hinge position, aim angles and
  // the caller's ear targets are all expressed in ONE space (root-local) — the
  // per-mesh `attach` calls below absorb whatever intermediate node transforms
  // the GLB authored (matrix nodes, nested groups) without changing world pose.
  const pivot = new THREE.Group();
  pivot.name = 'TempleHingePivot';
  pivot.position.copy(hinge);
  root.add(pivot);

  const lengthGroup = new THREE.Group();
  lengthGroup.name = 'TempleArmLength';
  pivot.add(lengthGroup);
  // `attach` preserves the mesh's world transform while reparenting. Since the
  // pivot sits exactly at the hinge, the arm's near edge lands at local z≈0
  // under `lengthGroup`, so scaling `lengthGroup.scale.z` stretches the arm
  // away from the hinge instead of from the model's shared origin.
  lengthGroup.attach(armEntry.mesh);

  const trailing: TrailingSegment[] = [];
  for (const entry of rest) {
    const segmentDepth = entry.box.max.z - entry.box.min.z;
    const isBehindArm = entry.box.max.z <= farEdgeZ + segmentDepth * TRAILING_OVERLAP_RATIO;

    if (isBehindArm) {
      // Tips hang off the pivot (NOT lengthGroup) so they rotate with the arm's
      // aim but are translated — never stretched — when the arm lengthens.
      pivot.attach(entry.mesh);
      trailing.push({ mesh: entry.mesh, originalZ: entry.mesh.position.z });
    } else {
      // Decoration alongside the arm — same group as the arm itself, so it
      // stays glued to the flank it was authored on. See TRAILING_OVERLAP_RATIO.
      lengthGroup.attach(entry.mesh);
    }
  }

  return {
    pivot,
    lengthGroup,
    armLength,
    hinge,
    sideSign: hinge.x >= 0 ? 1 : -1,
    trailing,
    smoothedYaw: 0,
    smoothedPitch: 0,
    smoothedLengthRatio: 1,
    hasEarFix: false,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Per-frame fit update for one temple side.
 *
 * @param side                One side of the rig (no-op when `null`).
 * @param earTargetLocal      The user's tracked ear-top point in ROOT-LOCAL
 *                            space (same space as `side.hinge`), or `null`
 *                            when no usable target exists this frame.
 * @param fallbackLengthRatio Plain depth-based length ratio (from
 *                            `CalibrationEngine`) used until the first
 *                            trusted ear fix arrives.
 * @param trust               Whether this frame's ear target is reliable
 *                            (near-frontal head, good tracking). Untrusted
 *                            frames HOLD the last smoothed fit instead of
 *                            chasing noisy landmarks mid-head-turn.
 */
export function updateTempleSide(
  side: TempleSide | null,
  earTargetLocal: THREE.Vector3 | null,
  fallbackLengthRatio: number,
  trust: boolean,
): void {
  if (!side) return;

  if (trust && earTargetLocal) {
    const dx = earTargetLocal.x - side.hinge.x;
    const dy = earTargetLocal.y - side.hinge.y;
    const dz = earTargetLocal.z - side.hinge.z;

    // Only aim at targets meaningfully BEHIND the hinge — a target beside or in
    // front of it means the landmark→local conversion is degenerate this frame.
    if (dz < -side.armLength * 0.3) {
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Arm rest direction is (0,0,-1). Euler 'YXZ': yaw about Y then pitch about X.
      const targetYaw = clamp(Math.atan2(-dx, -dz), -MAX_SPLAY_RAD, MAX_SPLAY_RAD);
      const targetPitch = clamp(Math.asin(clamp(dy / length, -1, 1)), -MAX_DROP_RAD, MAX_DROP_RAD);
      const targetRatio = clamp((length / side.armLength) * EAR_OVERSHOOT, LENGTH_RATIO_MIN, LENGTH_RATIO_MAX);

      side.smoothedYaw += SMOOTHING_ALPHA * (targetYaw - side.smoothedYaw);
      side.smoothedPitch += SMOOTHING_ALPHA * (targetPitch - side.smoothedPitch);
      side.smoothedLengthRatio += SMOOTHING_ALPHA * (targetRatio - side.smoothedLengthRatio);
      side.hasEarFix = true;
    }
  } else if (!side.hasEarFix) {
    // No ear fix yet — track the plain depth-ratio fallback, arm straight back.
    const targetRatio = clamp(fallbackLengthRatio, LENGTH_RATIO_MIN, LENGTH_RATIO_MAX);
    side.smoothedLengthRatio += SMOOTHING_ALPHA * (targetRatio - side.smoothedLengthRatio);
  }
  // Untrusted frame after an ear fix: hold the last smoothed state (write it anyway below).

  side.pivot.rotation.set(side.smoothedPitch, side.smoothedYaw, 0, 'YXZ');
  side.lengthGroup.scale.z = side.smoothedLengthRatio;

  const shift = side.armLength * (side.smoothedLengthRatio - 1);
  for (const segment of side.trailing) {
    segment.mesh.position.z = segment.originalZ - shift;
  }
}

/**
 * Legacy whole-rig length-only update (no ear targets). Kept for callers that
 * have no landmark data — equivalent to `updateTempleSide(side, null, ratio, false)`.
 */
export function applyTempleLengthRatio(rig: TempleRig, ratio: number): void {
  updateTempleSide(rig.left, null, ratio, false);
  updateTempleSide(rig.right, null, ratio, false);
}
