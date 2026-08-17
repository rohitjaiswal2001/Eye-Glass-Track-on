/**
 * autoFitModel.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   A catalog frame ships a hand-authored sidecar JSON, so its axes and scale
 *   are known before it loads. An uploaded GLB has nothing: it may be metres or
 *   centimetres or Blender units, centred on the world origin or 1.7m up on an
 *   avatar's head, facing any of six directions. Dropped in raw it lands
 *   off-screen, and the user has no way to find it — the fit sliders tune
 *   millimetres, not 90° rotations.
 *
 *   So this module derives what the sidecar JSON would have said, from the
 *   geometry itself. Eyewear has an unusually strong shape signature and that
 *   is what makes this tractable: it is far wider than it is tall, its temple
 *   arms make it nearly as deep as it is wide, and — the useful part — its
 *   FRONT spans the full width continuously (lens, lens, bridge between them)
 *   while its BACK is two thin arms with a head-sized gap in the middle.
 *
 * WHAT IT DOES
 *   `deriveAutoFit(root, targetWidthMm)` samples the model's vertices once and
 *   returns the `ModelPreTransform` + `defaultScale` that put it on the
 *   renderer's convention (X lateral and centred, Y up with the lens centre at
 *   0, temples into -Z from a front plane at Z = 0):
 *     1. The SHORTEST axis is "up" — eyewear is never taller than it is wide
 *        or deep.
 *     2. Of the remaining two, which is lateral and which is depth (and which
 *        end of depth is the front) is decided by scoring all four
 *        possibilities with the centre-gap signature above, rather than
 *        assuming the wider one is lateral — for a wrap frame those two
 *        extents come within 2% of each other.
 *     3. "Up" is disambiguated by the hinges: temple arms attach at the brow
 *        line, so their vertical centre sits ABOVE the front's. If it doesn't,
 *        the model is upside down.
 *     4. Vertical centring uses the FRONT slab only — including the temples
 *        would drag eye level toward the arms.
 *
 * LIMITS
 *   Only the three coordinate axes are considered as candidates, which covers
 *   every export convention in practice (they differ by 90° rotations). A model
 *   saved at an arbitrary tilt gets its bounding box, not its true axes; the
 *   returned `confidence` drops in that case, and `TryOnApp` surfaces a warning
 *   plus a manual ⇅ Flip so the user is never stuck with a bad guess. Verified
 *   against both catalog frames in all six axis-aligned re-orientations, where
 *   it reproduces their hand-authored sidecars to within 0.02mm.
 *
 * HOW IT COMMUNICATES
 *   - `UploadedModelLoader` calls this on a freshly parsed upload, and the
 *     result goes into the synthesized `CalibrationData` that
 *     `hooks/useCustomGlbFrame` hands to the rest of the pipeline — so an
 *     upload flows through exactly the same `modelPreTransform` path as a
 *     catalog frame, and `CalibrationPanel`'s "Copy JSON" emits a sidecar that
 *     can be committed as-is to make the upload a permanent catalog entry.
 *   - `scripts/derive-model-pretransform.mjs` is the offline equivalent, for
 *     frames being added to the catalog by hand.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import type { ModelPreTransform } from '../../core/types/calibration.types';

/** Total vertex samples across the whole model — plenty for bounds/signature work, bounded for big meshes. */
const MAX_SAMPLES = 20000;
/** Fraction of the depth range at each end used as the "front" / "back" slab. */
const END_SLAB_FRACTION = 0.25;
/** Bins an axis is divided into when measuring where geometry is present. */
const OCCUPANCY_BINS = 24;
/** A bin counts as "central" if its centre is within this fraction of the half-extent. */
const CENTRAL_BAND_FRACTION = 0.3;
/** Narrower column used to find the nose gap, which is a small feature. */
const NOSE_COLUMN_FRACTION = 0.15;

export interface AutoFitResult {
  preTransform: ModelPreTransform;
  /** Model-units → scene-metre multiplier that makes the frame `targetWidthMm` wide. */
  defaultScale: number;
  /** Measured extents in model units, after orientation, as {width, height, depth}. */
  measured: { width: number; height: number; depth: number };
  /** How clearly the front end was identified (0 = ambiguous, 1 = textbook). Low values mean the guess may be wrong. */
  confidence: number;
}

/** Collects up to `MAX_SAMPLES` vertex positions, expressed in `root`'s local space. */
function sampleVertices(root: THREE.Object3D): THREE.Vector3[] {
  const meshes: THREE.Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes?.position) meshes.push(mesh);
  });

  const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));

  // Root-local, not world: the caller may already have the model parented under
  // a tracked anchor, and this must describe the MODEL, not where it is aimed.
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const toRoot = new THREE.Matrix4();
  const samples: THREE.Vector3[] = [];

  for (const mesh of meshes) {
    toRoot.multiplyMatrices(rootInverse, mesh.matrixWorld);
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i += stride) {
      samples.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(toRoot));
    }
  }
  return samples;
}

interface Span {
  centre: number;
  half: number;
}

function spanOf(values: number[]): Span {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { centre: (min + max) / 2, half: (max - min) / 2 };
}

/**
 * Which bins along an axis contain any geometry at all.
 *
 * Deliberately OCCUPANCY, not vertex counts: mesh density has nothing to do
 * with shape. The wrap-shield frame carries 21k vertices of extruded branding
 * text on one temple and 1.5k on the other, and a counting metric reads that
 * as "this side is where the model is", which is how an early version of this
 * module confidently mounted the frame sideways.
 */
function occupiedBins(values: number[], span: Span): boolean[] {
  const bins = new Array<boolean>(OCCUPANCY_BINS).fill(false);
  if (span.half <= 0) return bins;
  for (const value of values) {
    const normalised = (value - span.centre) / span.half; // -1 … 1
    const index = Math.min(OCCUPANCY_BINS - 1, Math.max(0, Math.floor(((normalised + 1) / 2) * OCCUPANCY_BINS)));
    bins[index] = true;
  }
  return bins;
}

/** Fraction of the bins within `bandFraction` of centre that contain geometry. */
function centralOccupancy(values: number[], span: Span, bandFraction: number): number {
  const bins = occupiedBins(values, span);
  let considered = 0;
  let filled = 0;
  for (let index = 0; index < OCCUPANCY_BINS; index++) {
    const binCentre = ((index + 0.5) / OCCUPANCY_BINS) * 2 - 1;
    if (Math.abs(binCentre) > bandFraction) continue;
    considered++;
    if (bins[index]) filled++;
  }
  return considered === 0 ? 0 : filled / considered;
}

/** Indices of the samples lying in the near or far `END_SLAB_FRACTION` of the depth range. */
function endSlab(depthValues: number[], wantFar: boolean): number[] {
  const min = Math.min(...depthValues);
  const max = Math.max(...depthValues);
  const thickness = (max - min) * END_SLAB_FRACTION;
  const indices: number[] = [];
  depthValues.forEach((value, index) => {
    if (wantFar ? value >= max - thickness : value <= min + thickness) indices.push(index);
  });
  return indices;
}

/**
 * Scores one candidate orientation: how much more "continuous across the
 * centre" the chosen front end is than the back end. A real frame front scores
 * near 1 (lens, bridge, lens — geometry all the way across); the temple end
 * scores ~0 (two arms with a head-sized gap between them).
 *
 * Lateral position is measured from the MODEL's lateral midpoint, not from the
 * origin — an eyewear model authored with its origin at a temple tip, or on an
 * avatar's head, is not centred on anything in particular.
 */
function scoreFrontEnd(samples: THREE.Vector3[], lateral: THREE.Vector3, depth: THREE.Vector3): number {
  const lateralValues = samples.map((sample) => sample.dot(lateral));
  const depthValues = samples.map((sample) => sample.dot(depth));
  const lateralSpan = spanOf(lateralValues);

  const coverage = (wantFar: boolean): number =>
    centralOccupancy(
      endSlab(depthValues, wantFar).map((index) => lateralValues[index]),
      lateralSpan,
      CENTRAL_BAND_FRACTION,
    );

  return coverage(true) - coverage(false);
}

/** Derives the pre-transform + scale that place an arbitrary eyewear model on the renderer's convention. */
export function deriveAutoFit(root: THREE.Object3D, targetWidthMm: number): AutoFitResult {
  const samples = sampleVertices(root);
  if (samples.length === 0) {
    throw new Error('The uploaded model contains no mesh geometry.');
  }

  const box = new THREE.Box3().setFromPoints(samples);
  const size = box.getSize(new THREE.Vector3());
  const axes = [
    { unit: new THREE.Vector3(1, 0, 0), extent: size.x },
    { unit: new THREE.Vector3(0, 1, 0), extent: size.y },
    { unit: new THREE.Vector3(0, 0, 1), extent: size.z },
  ].sort((a, b) => b.extent - a.extent);

  // Shortest axis is height; the two longer ones are lateral/depth in some order.
  const up = axes[2].unit.clone();
  const [first, second] = [axes[0].unit, axes[1].unit];

  // Score all four lateral/depth-sign combinations and keep the best.
  let best = { lateral: first.clone(), depth: second.clone(), score: -Infinity };
  for (const [lateralUnit, depthUnit] of [
    [first, second],
    [second, first],
  ]) {
    for (const sign of [1, -1]) {
      const depth = depthUnit.clone().multiplyScalar(sign);
      const score = scoreFrontEnd(samples, lateralUnit, depth);
      if (score > best.score) best = { lateral: lateralUnit.clone(), depth, score };
    }
  }

  let { lateral, depth } = best;

  // Which way is up: every pair of glasses has a nose gap. Down the centre
  // column of the frame front, the bridge occupies the TOP and the cutout the
  // face sits in leaves the BOTTOM empty. So the half of that column with more
  // geometry is up. (The alternative signature — hinges sit at the brow line,
  // so the arms are above the lens centre — is weaker: temple tips hook
  // downward behind the ear, which can outweigh the rise at the hinge.)
  const depthValues = samples.map((sample) => sample.dot(depth));
  const lateralValues = samples.map((sample) => sample.dot(lateral));
  const lateralSpan = spanOf(lateralValues);
  const frontIndices = endSlab(depthValues, true);
  const noseColumn = frontIndices.filter(
    (index) => Math.abs(lateralValues[index] - lateralSpan.centre) <= lateralSpan.half * NOSE_COLUMN_FRACTION,
  );
  const columnUpValues = noseColumn.map((index) => samples[index].dot(up));
  if (columnUpValues.length > 0) {
    // Binned against the span of the WHOLE front (lens top to lens bottom), not
    // the column's own span: the nose gap is a REGION WITH NO GEOMETRY, and a
    // span derived from the column's own samples starts at its lowest vertex —
    // normalising the gap out of existence. Measured against the full front, the
    // gap shows up as the empty lower bins it is.
    const frontUpSpan = spanOf(frontIndices.map((index) => samples[index].dot(up)));
    const bins = occupiedBins(columnUpValues, frontUpSpan);
    const half = OCCUPANCY_BINS / 2;
    const upperFilled = bins.slice(half).filter(Boolean).length;
    const lowerFilled = bins.slice(0, half).filter(Boolean).length;
    if (lowerFilled > upperFilled) up.negate();
  }

  // Keep the basis right-handed, or the model comes out mirrored. Eyewear is
  // near-symmetric laterally, so flipping lateral is the harmless correction.
  if (new THREE.Vector3().crossVectors(lateral, up).dot(depth) < 0) lateral = lateral.negate();

  // Rows = the target basis, so the matrix maps model axes onto (X, Y, Z).
  const rotation = new THREE.Matrix4().makeBasis(lateral, up, depth).transpose();
  const euler = new THREE.Euler().setFromRotationMatrix(rotation, 'XYZ');

  // Re-measure in the corrected frame: centre laterally on the whole model,
  // vertically on the FRONT slab only (eye level), and put the front plane at 0.
  const rotated = samples.map((sample) => sample.clone().applyMatrix4(rotation));
  const rotatedBox = new THREE.Box3().setFromPoints(rotated);
  const frontThreshold = rotatedBox.max.z - (rotatedBox.max.z - rotatedBox.min.z) * END_SLAB_FRACTION;
  const front = rotated.filter((sample) => sample.z >= frontThreshold);
  const frontBox = new THREE.Box3().setFromPoints(front);

  const width = rotatedBox.max.x - rotatedBox.min.x;
  const radians = 180 / Math.PI;

  return {
    preTransform: {
      rotationX: euler.x * radians,
      rotationY: euler.y * radians,
      rotationZ: euler.z * radians,
      translateX: -(rotatedBox.min.x + rotatedBox.max.x) / 2,
      translateY: -(frontBox.min.y + frontBox.max.y) / 2,
      translateZ: -rotatedBox.max.z,
    },
    defaultScale: (targetWidthMm / 1000) / width,
    measured: {
      width,
      height: frontBox.max.y - frontBox.min.y,
      depth: rotatedBox.max.z - rotatedBox.min.z,
    },
    confidence: Math.max(0, Math.min(1, best.score)),
  };
}
