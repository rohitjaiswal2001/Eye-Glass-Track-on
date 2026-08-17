/**
 * modelPreTransform.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Vendor eyewear GLBs arrive on whatever axis convention their artist used.
 *   The rest of the pipeline assumes one convention (X lateral and centred,
 *   Y up with the lens centre at eye level, temples running into -Z from a
 *   front plane at Z = 0), and one module in particular — `renderer/templeRig`
 *   — DEPENDS on it: it classifies front vs. temple geometry by reading each
 *   mesh's model-local Z and X. Hand a sideways-authored model to that and it
 *   will happily rig the lens as a temple arm.
 *
 *   The previous fix was to rewrite the GLB's vertex buffers offline (see
 *   `scripts/reprocess-cyberpunk-glb-*.mjs`), which forks the asset from what
 *   the vendor shipped and has to be redone on every asset update. This module
 *   is the alternative: the GLB stays byte-identical on disk and the
 *   correction lives in its sidecar JSON as `modelPreTransform`.
 *
 * WHAT IT DOES
 *   `applyModelPreTransform(group, preTransform)` inserts ONE group between
 *   the loaded scene root and its children, carrying the authored rotation and
 *   translation:
 *
 *        modelGroup                 ← what the renderer positions/scales
 *        └── "ModelPreTransform"    ← the authoring fix lives HERE
 *            └── …the GLB's own scene graph, untouched
 *
 *   Putting it INSIDE `modelGroup` (rather than on `modelGroup` itself, or on
 *   the tracked anchor above it) is the whole point: a node's own transform is
 *   invisible to anything measuring geometry relative to it, so only an inner
 *   group makes `templeRig`'s model-local bounds — and the ear targets
 *   `GlassesScene` converts with `modelGroup.worldToLocal` — land in corrected
 *   space.
 *
 * HOW IT COMMUNICATES
 *   - `hooks/useGlassesModel.ts` calls this on each freshly cloned model
 *     instance, once both the GLB clone and its validated calibration have
 *     resolved, before the group is handed to the scene.
 *   - `scripts/derive-model-pretransform.mjs` computes the values to author.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import type { ModelPreTransform } from '../../core/types/calibration.types';
import { degToRad, radToDeg } from '../../core/math/scalar';

/** Name given to the inserted group — handy when reading the scene graph in devtools. */
export const MODEL_PRE_TRANSFORM_NODE_NAME = 'ModelPreTransform';

interface TaggedGroup extends THREE.Group {
  /** Set once this group has been through `applyModelPreTransform`. */
  __modelPreTransformApplied?: boolean;
}

/**
 * Applies a frame's authored `modelPreTransform` to a freshly loaded model
 * instance. Idempotent — a second call on the same group is a no-op, so React
 * StrictMode's double-invoked effects can't stack two nested corrections.
 *
 * @param group        The cloned GLB scene root, as returned by `ModelLoader`.
 * @param preTransform The frame's authored correction, or `undefined` for
 *                     models already on the renderer's convention.
 * @returns The same `group`, for call-site convenience.
 */
export function applyModelPreTransform(
  group: THREE.Group,
  preTransform: ModelPreTransform | undefined,
): THREE.Group {
  const tagged = group as TaggedGroup;
  if (tagged.__modelPreTransformApplied) return group;
  tagged.__modelPreTransformApplied = true;

  if (!preTransform) return group;

  const pivot = new THREE.Group();
  pivot.name = MODEL_PRE_TRANSFORM_NODE_NAME;

  // Snapshot the children first: `Object3D.add` mutates `group.children` as it
  // re-parents, so iterating it live would skip half the scene graph.
  for (const child of [...group.children]) {
    pivot.add(child);
  }

  // Three.js applies a node's rotation before its position, so `translate*`
  // is expressed in ROTATED model space — which is what
  // `derive-model-pretransform.mjs` reports.
  pivot.rotation.set(
    degToRad(preTransform.rotationX),
    degToRad(preTransform.rotationY),
    degToRad(preTransform.rotationZ),
  );
  pivot.position.set(preTransform.translateX, preTransform.translateY, preTransform.translateZ);

  group.add(pivot);
  return group;
}

/**
 * Returns the pre-transform that renders a model upside down relative to the
 * given one — the manual override for when `autoFitModel`'s shape-based
 * up-detection guesses wrong on an unusual frame.
 *
 * A vertical flip is a 180° roll about the depth axis, applied AFTER the
 * existing correction: `p → F·(R·p + t)`, i.e. rotation becomes `F·R` and
 * translation becomes `F·t`. Since F maps (x, y, z) → (-x, -y, z), that's just
 * negating the two lateral/vertical translations. Rolling (rather than
 * pitching) is what keeps the temples pointing backwards, and eyewear is
 * near-symmetric laterally, so the accompanying left/right mirror is invisible.
 */
export function flipPreTransformVertically(preTransform: ModelPreTransform): ModelPreTransform {
  const rotation = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      degToRad(preTransform.rotationX),
      degToRad(preTransform.rotationY),
      degToRad(preTransform.rotationZ),
      'XYZ',
    ),
  );
  rotation.premultiply(new THREE.Matrix4().makeRotationZ(Math.PI));
  const euler = new THREE.Euler().setFromRotationMatrix(rotation, 'XYZ');

  return {
    rotationX: radToDeg(euler.x),
    rotationY: radToDeg(euler.y),
    rotationZ: radToDeg(euler.z),
    translateX: -preTransform.translateX,
    translateY: -preTransform.translateY,
    translateZ: preTransform.translateZ,
  };
}
