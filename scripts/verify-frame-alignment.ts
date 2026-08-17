/**
 * verify-frame-alignment.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   A newly added catalog frame can be wrong in ways that only show up on a
 *   live face: the model rotated 90° off, the lens sitting on the forehead, or
 *   — the subtle one — `templeRig` mistaking the lens for a temple arm and
 *   rotating it away every frame. Finding that out by staring at a webcam is
 *   slow and imprecise. This script runs the REAL alignment modules over a
 *   frame's actual GLB geometry, headlessly, and prints millimetre numbers you
 *   can sanity-check against real eyewear.
 *
 * WHAT IT DOES
 *   For the given catalog frameId:
 *     1. Validates the sidecar JSON with the real `calibrationSchema`.
 *     2. Reads the GLB and stands every mesh-bearing node in for its mesh with
 *        a box of identical world bounds (`buildTempleRig` only ever reads mesh
 *        bounding boxes, so this exercises the genuine classification path).
 *     3. Runs `applyModelPreTransform`, then `buildTempleRig`, and reports how
 *        each mesh was classified — arm, arm-riding decoration, or trailing tip.
 *     4. Places the result on a reference face and prints where the geometry
 *        lands, before and after the ear-fit rig converges.
 *
 * USAGE
 *   npx tsx scripts/verify-frame-alignment.ts [frameId]     (default: sunglasses)
 * ---------------------------------------------------------------------------
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as THREE from 'three';
import { applyModelPreTransform } from '../src/modules/modelLoader/modelPreTransform';
import { buildTempleRig, updateTempleSide } from '../src/modules/renderer/templeRig';
import { deriveAutoFit } from '../src/modules/modelLoader/autoFitModel';
import { validateCalibrationData } from '../src/modules/calibration/calibrationSchema';
import type { FrameManifestEntry } from '../src/core/types/calibration.types';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const frameId = process.argv[2] ?? 'sunglasses';

/** Reference face used for the millimetre report — matches CalibrationEngine's own reference constants. */
const REFERENCE_FACE_WIDTH_MM = 140;
const REFERENCE_EAR_HALF_WIDTH_MM = 72;
const REFERENCE_EAR_DEPTH_MM = -103;

const manifest: FrameManifestEntry[] = JSON.parse(readFileSync(`${publicDir}/models/manifest.json`, 'utf8'));
const entry = manifest.find((e) => e.frameId === frameId);
if (!entry) {
  console.error(`No "${frameId}" in manifest.json. Available: ${manifest.map((e) => e.frameId).join(', ')}`);
  process.exit(1);
}

// ── 1. sidecar JSON against the real schema ───────────────────────────────
const validation = validateCalibrationData(JSON.parse(readFileSync(`${publicDir}${entry.jsonUrl}`, 'utf8')));
if (!validation.valid) {
  console.error(`${entry.jsonUrl} FAILED validation:\n  ${validation.errors.join('\n  ')}`);
  process.exit(1);
}
const calibration = validation.data;
console.log(`${entry.jsonUrl}: valid ✓`);
console.log(`  defaultScale ${calibration.defaultScale}   offsets (${calibration.offsetX}, ${calibration.offsetY}, ${calibration.offsetZ}) mm`);
console.log(`  modelPreTransform ${JSON.stringify(calibration.modelPreTransform ?? null)}`);

// ── 2. GLB → one box mesh per node, at the node's world bounds ─────────────
const buf = readFileSync(`${publicDir}${entry.glbUrl}`);
const jsonLength = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + jsonLength).toString('utf8'));
const binOffset = 20 + jsonLength;
const bin = buf.slice(binOffset + 8, binOffset + 8 + buf.readUInt32LE(binOffset));

const worldMatrices: THREE.Matrix4[] = [];
const visit = (index: number, parent: THREE.Matrix4) => {
  const node = gltf.nodes[index];
  const local = new THREE.Matrix4();
  if (node.matrix) {
    local.fromArray(node.matrix);
  } else {
    local.compose(
      new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
      new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
      new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]),
    );
  }
  worldMatrices[index] = new THREE.Matrix4().multiplyMatrices(parent, local);
  (node.children ?? []).forEach((child: number) => visit(child, worldMatrices[index]));
};
(gltf.scenes[gltf.scene ?? 0].nodes as number[]).forEach((rootIndex) => visit(rootIndex, new THREE.Matrix4()));

const root = new THREE.Group();
const meshesByName = new Map<string, THREE.Mesh>();

gltf.nodes.forEach((node: { name?: string; mesh?: number }, index: number) => {
  if (node.mesh === undefined) return;
  const point = new THREE.Vector3();
  const positions: number[] = [];

  for (const primitive of gltf.meshes[node.mesh].primitives) {
    const accessor = gltf.accessors[primitive.attributes.POSITION];
    const view = gltf.bufferViews[accessor.bufferView];
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? 12;
    for (let i = 0; i < accessor.count; i++) {
      const offset = base + i * stride;
      point.set(bin.readFloatLE(offset), bin.readFloatLE(offset + 4), bin.readFloatLE(offset + 8));
      // Baked to world space so one flat mesh per node reproduces exactly what
      // the loader would render, without rebuilding the node hierarchy here.
      point.applyMatrix4(worldMatrices[index]);
      positions.push(point.x, point.y, point.z);
    }
  }

  // Real vertex positions, not a proxy box: `buildTempleRig` only needs bounds,
  // but `deriveAutoFit` reads the actual point cloud (its front/back detection
  // depends on where geometry ISN'T — a box would have no centre gap to find).
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const mesh = new THREE.Mesh(geometry);
  mesh.name = node.name ?? `node${index}`;
  meshesByName.set(mesh.name, mesh);
  root.add(mesh);
});

console.log(`\n${entry.glbUrl}: ${meshesByName.size} mesh nodes`);

// ── 2b. asset traits that break rendering without breaking the load ────────
// Neither of these shows up in the geometry report below: a rigged model can be
// perfectly aligned and still never appear, and a missing texture only surfaces
// as a console warning in the browser. Both have bitten this catalog.
const skinCount = (gltf.skins ?? []).length;
if (skinCount > 0) {
  console.log(
    `  ⚠ rigged: ${skinCount} skin(s), ${gltf.skins[0].joints.length} joints. Instances MUST be cloned with\n` +
      '    SkeletonUtils.clone (ModelLoader.cloneTemplate does this) — a plain Object3D.clone shares the\n' +
      "    template's skeleton and the model renders at its raw authored coordinates, i.e. invisibly.",
  );
}
const externalImages: string[] = (gltf.images ?? []).filter((image: { uri?: string }) => image.uri).map((image: { uri: string }) => image.uri);
if (externalImages.length > 0) {
  const modelDir = `${publicDir}${entry.glbUrl}`.replace(/\/[^/]+$/, '');
  for (const uri of externalImages) {
    const path = `${modelDir}/${decodeURIComponent(uri)}`;
    const present = existsSync(path);
    console.log(`  ${present ? '✓' : '⚠'} external texture "${uri}" — ${present ? 'present' : `MISSING, expected at ${path}`}`);
  }
}

// ── 2c. what the upload path's auto-fit would derive, unaided ──────────────
// Cross-check: the catalog's values were derived deliberately, so if geometric
// auto-detection lands on the same place, the "Upload 3D Model" button can be
// trusted with a frame nobody has hand-tuned.
const auto = deriveAutoFit(root, calibration.frameWidth);
const authored = calibration.modelPreTransform;
const round = (v: number) => Number(v.toFixed(4));
console.log('\nauto-fit (what an upload of this same file would derive on its own):');
console.log(`  rotation  (${[auto.preTransform.rotationX, auto.preTransform.rotationY, auto.preTransform.rotationZ].map((v) => round(v)).join(', ')})°` +
  `${authored ? `   authored: (${[authored.rotationX, authored.rotationY, authored.rotationZ].join(', ')})°` : ''}`);
console.log(`  translate (${[auto.preTransform.translateX, auto.preTransform.translateY, auto.preTransform.translateZ].map((v) => round(v)).join(', ')})` +
  `${authored ? `   authored: (${[authored.translateX, authored.translateY, authored.translateZ].join(', ')})` : ''}`);
console.log(`  defaultScale ${auto.defaultScale.toPrecision(6)}   authored: ${calibration.defaultScale}`);
console.log(`  measured ${(auto.measured.width * 1000).toFixed(1)} × ${(auto.measured.height * 1000).toFixed(1)} × ${(auto.measured.depth * 1000).toFixed(1)} model units` +
  `   front-detection confidence ${(auto.confidence * 100).toFixed(0)}%`);

// ── 3. the modules under test ─────────────────────────────────────────────
applyModelPreTransform(root, calibration.modelPreTransform);
console.log(`applyModelPreTransform → root children: [${root.children.map((c) => c.name).join(', ')}]`);

const rig = buildTempleRig(root);
const unit = 1000 * calibration.defaultScale; // model units → mm on the reference face
const nameOf = (object: THREE.Object3D) => object.name || '(unnamed)';

for (const [label, side] of [['left', rig.left], ['right', rig.right]] as const) {
  if (!side) {
    console.log(`\nrig.${label}: null — no separable temple geometry on this side`);
    continue;
  }
  console.log(
    `\nrig.${label}: sideSign ${side.sideSign}  hinge (${side.hinge.toArray().map((v) => (v * unit).toFixed(1)).join(', ')}) mm` +
      `  armLength ${(side.armLength * unit).toFixed(1)} mm`,
  );
  console.log(`  arm + decoration (scales with the arm): ${side.lengthGroup.children.map(nameOf).join(', ')}`);
  console.log(`  trailing tips (translated only):        ${side.trailing.map((t) => nameOf(t.mesh)).join(', ') || '—'}`);
}

// ── 4. placement on a reference face ──────────────────────────────────────
// Mirrors CalibrationEngine: anchor at the tracked nose bridge, plus authored
// offsets (mm → m), scaled by defaultScale (IPD/face-width correction = 1 here).
const anchor = new THREE.Group();
anchor.add(root);
anchor.position.set(calibration.offsetX / 1000, calibration.offsetY / 1000, calibration.offsetZ / 1000);
anchor.scale.setScalar(calibration.defaultScale);

const reportPlacement = (heading: string) => {
  anchor.updateMatrixWorld(true);
  console.log(`\n${heading} (mm, relative to the tracked nose bridge):`);
  for (const [name, mesh] of meshesByName) {
    const box = new THREE.Box3().setFromObject(mesh);
    const format = (v: THREE.Vector3) => v.toArray().map((n) => (n * 1000).toFixed(1).padStart(7)).join(' ');
    console.log(`  ${name.padEnd(12)} min (${format(box.min)} )  max (${format(box.max)} )`);
  }
};
reportPlacement(`placed on a ${REFERENCE_FACE_WIDTH_MM}mm reference face`);

// The ear-fit rig, driven as GlassesScene drives it, until its EMA converges.
const earTarget = (xMm: number) =>
  root.worldToLocal(new THREE.Vector3(xMm / 1000, 7 / 1000, REFERENCE_EAR_DEPTH_MM / 1000));
for (let i = 0; i < 300; i++) {
  updateTempleSide(rig.left, earTarget(-REFERENCE_EAR_HALF_WIDTH_MM), 1, true);
  updateTempleSide(rig.right, earTarget(REFERENCE_EAR_HALF_WIDTH_MM), 1, true);
}

console.log(`\near-fit rig converged on ears at x = ±${REFERENCE_EAR_HALF_WIDTH_MM}mm, z = ${REFERENCE_EAR_DEPTH_MM}mm:`);
for (const [label, side] of [['left', rig.left], ['right', rig.right]] as const) {
  if (!side) continue;
  console.log(
    `  rig.${label}: splay ${THREE.MathUtils.radToDeg(side.smoothedYaw).toFixed(1)}°` +
      `  drop ${THREE.MathUtils.radToDeg(side.smoothedPitch).toFixed(1)}°` +
      `  arm length ${(side.smoothedLengthRatio * 100).toFixed(0)}% → ${(side.armLength * side.smoothedLengthRatio * unit).toFixed(1)} mm`,
  );
}
reportPlacement('after the ear fit');
