#!/usr/bin/env node
/**
 * derive-model-pretransform.mjs
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Vendor/marketplace eyewear GLBs almost never arrive in the convention the
 *   renderer needs (X = lateral and centred, Y = up with the lens centre at 0,
 *   temples extending into -Z from a front plane at Z = 0). The old fix was to
 *   rewrite the GLB's vertex buffers (see `reprocess-cyberpunk-glb-*.mjs`),
 *   which forks the asset from what the vendor shipped. The alternative — and
 *   what this script supports — is leaving the GLB byte-identical and putting
 *   the correction in its sidecar calibration JSON as a `modelPreTransform`,
 *   applied once at load time (`modules/modelLoader/modelPreTransform.ts`).
 *
 * WHAT IT DOES
 *   Reads a GLB, bakes each node's world matrix, applies the axis remap you
 *   pass in, and reports the exact `modelPreTransform` + `defaultScale` values
 *   that land the model on the renderer's convention.
 *
 * USAGE
 *   node scripts/derive-model-pretransform.mjs <file.glb> \
 *        [--map=z,y,-x] [--front=nodeName] [--width-mm=142]
 *
 *   --map        Where the model's axes go: the new (X,Y,Z) expressed in the
 *                model's own axes. Default `z,y,-x` (model +X points backwards
 *                along the temples, model +Z is lateral).
 *   --front      Name of the node holding the lens/front geometry. Its centre
 *                sets vertical eye level and its front-most point sets Z = 0.
 *                Defaults to the widest node in the remapped X axis.
 *   --width-mm   Real temple-tip-to-temple-tip width, for `defaultScale`.
 * ---------------------------------------------------------------------------
 */

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

if (!filePath) {
  console.error('Usage: node scripts/derive-model-pretransform.mjs <file.glb> [--map=z,y,-x] [--front=node] [--width-mm=142]');
  process.exit(1);
}

const axisMap = flag('map', 'z,y,-x').split(',');
const frontNodeName = flag('front', null);
const targetWidthMm = Number(flag('width-mm', '142'));

// ── Parse the GLB container ────────────────────────────────────────────────
const buf = readFileSync(filePath);
if (buf.readUInt32LE(0) !== 0x46546c67) {
  console.error(`${filePath} is not a GLB.`);
  process.exit(1);
}
const jsonLength = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + jsonLength).toString('utf8'));
const binOffset = 20 + jsonLength;
const binData = buf.slice(binOffset + 8, binOffset + 8 + buf.readUInt32LE(binOffset));

// ── Node world matrices (column-major, glTF order) ─────────────────────────
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function fromTRS(translation, rotation, scale) {
  const [tx, ty, tz] = translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const worldMatrices = new Array(gltf.nodes.length).fill(null);
const visit = (index, parent) => {
  const node = gltf.nodes[index];
  const local = node.matrix ? [...node.matrix] : fromTRS(node.translation, node.rotation, node.scale);
  const world = parent ? multiply(parent, local) : local;
  worldMatrices[index] = world;
  (node.children ?? []).forEach((child) => visit(child, world));
};
(gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? [0]).forEach((root) => visit(root, null));

// ── Remapped world-space bounds, per mesh-bearing node ─────────────────────
const pick = (axis, x, y, z) => {
  const sign = axis.startsWith('-') ? -1 : 1;
  const key = axis.replace('-', '');
  return sign * (key === 'x' ? x : key === 'y' ? y : z);
};

const nodeBounds = [];
gltf.nodes.forEach((node, nodeIndex) => {
  if (node.mesh === undefined) return;
  const matrix = worldMatrices[nodeIndex];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const primitive of gltf.meshes[node.mesh].primitives ?? []) {
    const accessorIndex = primitive.attributes?.POSITION;
    if (accessorIndex === undefined) continue;
    const accessor = gltf.accessors[accessorIndex];
    const view = gltf.bufferViews[accessor.bufferView];
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? 12;

    for (let i = 0; i < accessor.count; i++) {
      const offset = base + i * stride;
      const px = binData.readFloatLE(offset);
      const py = binData.readFloatLE(offset + 4);
      const pz = binData.readFloatLE(offset + 8);
      const wx = matrix[0] * px + matrix[4] * py + matrix[8] * pz + matrix[12];
      const wy = matrix[1] * px + matrix[5] * py + matrix[9] * pz + matrix[13];
      const wz = matrix[2] * px + matrix[6] * py + matrix[10] * pz + matrix[14];
      const remapped = [pick(axisMap[0], wx, wy, wz), pick(axisMap[1], wx, wy, wz), pick(axisMap[2], wx, wy, wz)];
      for (let axis = 0; axis < 3; axis++) {
        if (remapped[axis] < min[axis]) min[axis] = remapped[axis];
        if (remapped[axis] > max[axis]) max[axis] = remapped[axis];
      }
    }
  }

  nodeBounds.push({ name: node.name ?? `node${nodeIndex}`, mesh: gltf.meshes[node.mesh].name, min, max });
});

const fixed = (values) => `[${values.map((v) => v.toFixed(4)).join(', ')}]`;
console.log(`Axis map: new X = ${axisMap[0]}, new Y = ${axisMap[1]}, new Z = ${axisMap[2]} (of the model's own axes)\n`);
console.log('═══ REMAPPED WORLD BOUNDS PER NODE ═══');
for (const entry of nodeBounds) {
  console.log(`  ${entry.name.padEnd(12)} (mesh "${entry.mesh}")  min=${fixed(entry.min)}  max=${fixed(entry.max)}`);
}

const overall = {
  min: [0, 1, 2].map((axis) => Math.min(...nodeBounds.map((entry) => entry.min[axis]))),
  max: [0, 1, 2].map((axis) => Math.max(...nodeBounds.map((entry) => entry.max[axis]))),
};

// The front node drives vertical eye level (its centre) and the Z origin (its
// front-most point) — the temples must NOT influence either.
const front =
  nodeBounds.find((entry) => entry.name === frontNodeName) ??
  [...nodeBounds].sort((a, b) => b.max[0] - b.min[0] - (a.max[0] - a.min[0]))[0];

if (frontNodeName && front.name !== frontNodeName) {
  console.error(`\nNo node named "${frontNodeName}" — falling back to the widest node.`);
}

const widthUnits = overall.max[0] - overall.min[0];
const preTransform = {
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  translateX: -(front.min[0] + front.max[0]) / 2,
  translateY: -(front.min[1] + front.max[1]) / 2,
  translateZ: -front.max[2],
};

// Report the rotation as the single Y rotation that realises common remaps, so
// the value can be dropped straight into the sidecar JSON.
const KNOWN_ROTATIONS = { 'x,y,z': 0, 'z,y,-x': 90, '-x,y,-z': 180, '-z,y,x': -90 };
const mapKey = axisMap.join(',');
if (mapKey in KNOWN_ROTATIONS) {
  preTransform.rotationY = KNOWN_ROTATIONS[mapKey];
} else {
  console.error(`\nAxis map "${mapKey}" is not a plain Y rotation — set rotationX/Y/Z by hand.`);
}

console.log('\n═══ ALIGNMENT ═══');
console.log(`  Overall:      min=${fixed(overall.min)}  max=${fixed(overall.max)}`);
console.log(`  Front node:   "${front.name}"  min=${fixed(front.min)}  max=${fixed(front.max)}`);
console.log(`  Width:        ${widthUnits.toFixed(4)} model units  →  ${targetWidthMm} mm`);
console.log('\n═══ SIDECAR JSON ═══');
console.log(`  "defaultScale": ${(targetWidthMm / 1000 / widthUnits).toPrecision(6)},`);
console.log(`  "modelPreTransform": ${JSON.stringify(
  Object.fromEntries(Object.entries(preTransform).map(([key, value]) => [key, Number(value.toFixed(4))])),
  null,
  2,
).replace(/\n/g, '\n  ')}`);

// Where the aligned model ends up — sanity-check these against real eyewear.
const mmPerUnit = targetWidthMm / widthUnits;
const alignedZ = (v) => ((v + preTransform.translateZ) * mmPerUnit).toFixed(1);
const alignedY = (v) => ((v + preTransform.translateY) * mmPerUnit).toFixed(1);
console.log('\n═══ ALIGNED DIMENSIONS (mm, relative to the nose-bridge anchor) ═══');
console.log(`  Front height:  ${((front.max[1] - front.min[1]) * mmPerUnit).toFixed(1)} (top ${alignedY(front.max[1])}, bottom ${alignedY(front.min[1])})`);
console.log(`  Front depth:   ${alignedZ(front.max[2])} at the front plane, back to ${alignedZ(front.min[2])}`);
console.log(`  Temple reach:  ${alignedZ(overall.min[2])}`);
