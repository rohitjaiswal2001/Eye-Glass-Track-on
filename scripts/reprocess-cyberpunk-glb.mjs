#!/usr/bin/env node
/**
 * reprocess-cyberpunk-glb.mjs
 *
 * The Johnny Silverhand GLB has a complex nested transform chain:
 *  - Sketchfab_model: rotates 90° (Y-up FBX → Z-up glTF conversion)
 *  - Johnny glasses.fbx: applies ×0.01 scale (cm → m) + another axis swap
 *  - Johnny Glasses (node[5]): the glasses positioned in character-head space
 *    with translation ~(8.75cm, 130.97cm, -2.06cm) and a rotation
 *
 * This script bakes ALL these inherited transforms directly into the
 * vertex data so the output GLB has:
 *  - Identity root transform
 *  - The glasses resting with the nose-bridge centre at the origin
 *  - Facing the -Z axis (glTF/Three.js convention: camera looks down -Z)
 *  - In metres (not centimetres)
 *  - Temples extending backward along +Z (ears side)
 *
 * We do this by reading the JSON chunk, computing the accumulated
 * 4×4 transform for each mesh, and rewriting the vertex POSITION
 * buffers directly in the binary chunk.
 *
 * The result is written to public/models/cyberpunk_glasses_aligned.glb
 */

import { readFileSync, writeFileSync } from 'fs';

const inPath  = process.argv[2] ?? 'public/models/cyberpunk_glasses.glb';
const outPath = process.argv[3] ?? 'public/models/cyberpunk_glasses_aligned.glb';

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546C67) { console.error('Not a GLB'); process.exit(1); }

// ── Parse JSON chunk ────────────────────────────────────────────────────────
const jsonLen  = buf.readUInt32LE(12);
const jsonText = buf.slice(20, 20 + jsonLen).toString('utf8');
const gltf     = JSON.parse(jsonText);

// ── Parse BIN chunk ─────────────────────────────────────────────────────────
const binOffset = 20 + jsonLen;
const binLen    = buf.readUInt32LE(binOffset);     // chunk length
// chunk type (0x004E4942 = "BIN\0") at binOffset+4
const binData   = Buffer.from(buf.slice(binOffset + 8, binOffset + 8 + binLen));  // mutable copy

// ── 4×4 matrix helpers (column-major, same as glTF) ─────────────────────────

function mat4Identity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function mat4FromGltfMatrix(m) {
  // glTF matrix is column-major: [col0row0, col0row1, col0row2, col0row3, col1row0, ...]
  return [...m];  // just a copy, same format
}

function mat4Multiply(A, B) {
  // Column-major: result[col*4 + row]
  const R = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += A[k * 4 + row] * B[col * 4 + k];
      }
      R[col * 4 + row] = sum;
    }
  }
  return R;
}

function mat4FromTRS(t, r, s) {
  // Build TRS matrix from translation, rotation (quaternion xyzw), scale
  const [tx, ty, tz]     = t ?? [0,0,0];
  const [qx, qy, qz, qw] = r ?? [0,0,0,1];
  const [sx, sy, sz]     = s ?? [1,1,1];
  const x2=qx+qx, y2=qy+qy, z2=qz+qz;
  const xx=qx*x2, xy=qx*y2, xz=qx*z2;
  const yy=qy*y2, yz=qy*z2, zz=qz*z2;
  const wx=qw*x2, wy=qw*y2, wz=qw*z2;
  return [
    (1-(yy+zz))*sx,  (xy+wz)*sx,       (xz-wy)*sx,       0,
    (xy-wz)*sy,       (1-(xx+zz))*sy,  (yz+wx)*sy,       0,
    (xz+wy)*sz,       (yz-wx)*sz,       (1-(xx+yy))*sz,  0,
    tx, ty, tz, 1
  ];
}

function getNodeMatrix(node) {
  if (node.matrix) return mat4FromGltfMatrix(node.matrix);
  return mat4FromTRS(node.translation, node.rotation, node.scale);
}

// ── Compute world matrix for each node (BFS from scene root) ─────────────────
const worldMatrix = new Array(gltf.nodes.length).fill(null);

function computeWorldMatrices(nodeIdx, parentMatrix) {
  const node = gltf.nodes[nodeIdx];
  const local = getNodeMatrix(node);
  const world = parentMatrix ? mat4Multiply(parentMatrix, local) : local;
  worldMatrix[nodeIdx] = world;
  (node.children ?? []).forEach(ci => computeWorldMatrices(ci, world));
}

// Start from each scene root
(gltf.scenes?.[0]?.nodes ?? [0]).forEach(ri => computeWorldMatrices(ri, null));

// ── For each mesh node, transform POSITION vertices ─────────────────────────
// We need to determine the glasses center in world space first.

// Build node → mesh mapping
const nodeMeshMap = {};  // meshIdx → worldMatrix
gltf.nodes.forEach((n, ni) => {
  if (n.mesh !== undefined) {
    if (!nodeMeshMap[n.mesh]) nodeMeshMap[n.mesh] = [];
    nodeMeshMap[n.mesh].push(worldMatrix[ni] ?? mat4Identity());
  }
});

// ── First pass: compute the overall bounding box in world space ──────────────
let gMin = [Infinity, Infinity, Infinity];
let gMax = [-Infinity, -Infinity, -Infinity];

function transformPoint(mat, px, py, pz) {
  return [
    mat[0]*px + mat[4]*py + mat[8]*pz  + mat[12],
    mat[1]*px + mat[5]*py + mat[9]*pz  + mat[13],
    mat[2]*px + mat[6]*py + mat[10]*pz + mat[14],
  ];
}

gltf.meshes.forEach((mesh, mi) => {
  const matrices = nodeMeshMap[mi] ?? [mat4Identity()];
  mesh.primitives?.forEach(prim => {
    const accIdx = prim.attributes?.POSITION;
    if (accIdx === undefined) return;
    const acc = gltf.accessors[accIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const byteOffset  = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;

    matrices.forEach(mat => {
      for (let i = 0; i < acc.count; i++) {
        const off = byteOffset + i * stride;
        const px = binData.readFloatLE(off + 0);
        const py = binData.readFloatLE(off + 4);
        const pz = binData.readFloatLE(off + 8);
        const [wx, wy, wz] = transformPoint(mat, px, py, pz);
        if (wx < gMin[0]) gMin[0] = wx;  if (wx > gMax[0]) gMax[0] = wx;
        if (wy < gMin[1]) gMin[1] = wy;  if (wy > gMax[1]) gMax[1] = wy;
        if (wz < gMin[2]) gMin[2] = wz;  if (wz > gMax[2]) gMax[2] = wz;
      }
    });
  });
});

const worldSize   = gMin.map((v, i) => gMax[i] - v);
const worldCenter = gMin.map((v, i) => (gMax[i] + v) / 2);

console.log('World-space bounding box (after all transforms):');
console.log(`  Min:    ${gMin.map(v=>v.toFixed(5)).join(', ')}`);
console.log(`  Max:    ${gMax.map(v=>v.toFixed(5)).join(', ')}`);
console.log(`  Size:   W=${worldSize[0].toFixed(4)} H=${worldSize[1].toFixed(4)} D=${worldSize[2].toFixed(4)}`);
console.log(`  Center: X=${worldCenter[0].toFixed(4)} Y=${worldCenter[1].toFixed(4)} Z=${worldCenter[2].toFixed(4)}`);

// ── Determine re-centring offset ─────────────────────────────────────────────
// After transforms, X should be the width axis, Y the height, Z the depth.
// We want: centre of glasses at (0, 0, 0), nose bridge at origin.
// The "nose bridge" is at the bottom of Y (the glasses rest on the nose),
// so align the Y min to 0, centre X and Z.
const offsetX = -worldCenter[0];
const offsetY = -gMin[1];    // shift so bottom of frame touches Y=0
const offsetZ = -worldCenter[2];

console.log(`\nCentring offsets: dX=${offsetX.toFixed(4)} dY=${offsetY.toFixed(4)} dZ=${offsetZ.toFixed(4)}`);
console.log(`Frame width in world space: ${worldSize[0].toFixed(4)} m`);
console.log(`Scale for 135mm target: ${(0.135 / worldSize[0]).toFixed(6)}`);

// ── Second pass: apply world matrix + centring offset to POSITION data ────────
gltf.meshes.forEach((mesh, mi) => {
  const matrices = nodeMeshMap[mi] ?? [mat4Identity()];
  // We'll use the first matrix (all nodes sharing a mesh should have same transform
  // for a rigid model like this)
  const mat = matrices[0];
  mesh.primitives?.forEach(prim => {
    const accIdx = prim.attributes?.POSITION;
    if (accIdx === undefined) return;
    const acc = gltf.accessors[accIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;

    let newMin = [Infinity,Infinity,Infinity];
    let newMax = [-Infinity,-Infinity,-Infinity];

    for (let i = 0; i < acc.count; i++) {
      const off = byteOffset + i * stride;
      const px = binData.readFloatLE(off + 0);
      const py = binData.readFloatLE(off + 4);
      const pz = binData.readFloatLE(off + 8);
      let [wx, wy, wz] = transformPoint(mat, px, py, pz);
      wx += offsetX;
      wy += offsetY;
      wz += offsetZ;
      binData.writeFloatLE(wx, off + 0);
      binData.writeFloatLE(wy, off + 4);
      binData.writeFloatLE(wz, off + 8);
      if (wx < newMin[0]) newMin[0] = wx;  if (wx > newMax[0]) newMax[0] = wx;
      if (wy < newMin[1]) newMin[1] = wy;  if (wy > newMax[1]) newMax[1] = wy;
      if (wz < newMin[2]) newMin[2] = wz;  if (wz > newMax[2]) newMax[2] = wz;
    }

    // Update accessor min/max
    acc.min = newMin;
    acc.max = newMax;
    console.log(`  Mesh[${mi}] "${mesh.name}": new min=(${newMin.map(v=>v.toFixed(4)).join(',')}) max=(${newMax.map(v=>v.toFixed(4)).join(',')})`);
  });
});

// ── Also transform NORMAL vectors (direction only, no translation) ────────────
gltf.meshes.forEach((mesh, mi) => {
  const matrices = nodeMeshMap[mi] ?? [mat4Identity()];
  const mat = matrices[0];
  mesh.primitives?.forEach(prim => {
    const normAccIdx = prim.attributes?.NORMAL;
    if (normAccIdx === undefined) return;
    const acc = gltf.accessors[normAccIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;

    for (let i = 0; i < acc.count; i++) {
      const off = byteOffset + i * stride;
      const nx = binData.readFloatLE(off + 0);
      const ny = binData.readFloatLE(off + 4);
      const nz = binData.readFloatLE(off + 8);
      // Apply only the rotation part of the matrix (no translation, no scale)
      const wnx = mat[0]*nx + mat[4]*ny + mat[8]*nz;
      const wny = mat[1]*nx + mat[5]*ny + mat[9]*nz;
      const wnz = mat[2]*nx + mat[6]*ny + mat[10]*nz;
      // Renormalise
      const len = Math.sqrt(wnx*wnx + wny*wny + wnz*wnz) || 1;
      binData.writeFloatLE(wnx/len, off + 0);
      binData.writeFloatLE(wny/len, off + 4);
      binData.writeFloatLE(wnz/len, off + 8);
    }
  });
});

// ── Reset all node transforms to identity in the JSON ────────────────────────
gltf.nodes.forEach(n => {
  delete n.matrix;
  delete n.translation;
  delete n.rotation;
  delete n.scale;
});
// Also prune Camera and Point light nodes (not needed for rendering)
// Keep them but set to identity (they're harmless)

// ── Rewrite JSON chunk ─────────────────────────────────────────────────────────
const newJsonRaw  = JSON.stringify(gltf);
// Pad to 4-byte boundary
const jsonPadded  = newJsonRaw.padEnd(Math.ceil(newJsonRaw.length / 4) * 4, ' ');
const newJsonBuf  = Buffer.from(jsonPadded, 'utf8');

// ── Assemble output GLB ───────────────────────────────────────────────────────
const totalLen = 12 + 8 + newJsonBuf.length + 8 + binData.length;
const out = Buffer.allocUnsafe(totalLen);

// File header
out.writeUInt32LE(0x46546C67, 0);  // magic "glTF"
out.writeUInt32LE(2, 4);            // version
out.writeUInt32LE(totalLen, 8);     // total length

// JSON chunk header
out.writeUInt32LE(newJsonBuf.length, 12);
out.writeUInt32LE(0x4E4F534A, 16);  // "JSON"
newJsonBuf.copy(out, 20);

// BIN chunk header
const binChunkOffset = 20 + newJsonBuf.length;
out.writeUInt32LE(binData.length, binChunkOffset);
out.writeUInt32LE(0x004E4942, binChunkOffset + 4);  // "BIN\0"
binData.copy(out, binChunkOffset + 8);

writeFileSync(outPath, out);
console.log(`\nWrote aligned GLB → ${outPath}`);
console.log(`\nSuggested calibration JSON:`);
const frameWidthWorld = worldSize[0];  // metres
const targetScale = 0.135 / frameWidthWorld;
console.log(JSON.stringify({
  frameId: 'cyberpunk_glasses',
  frameWidth: 125,
  bridgeWidth: 16,
  lensWidth: 48,
  offsetX: 0,
  // The glasses are now centred with bottom at Y=0.
  // We want the nose bridge (bottom) to sit at the nose bridge anchor.
  // CalibrationEngine positions relative to nose bridge, so offsetY = 0
  // means bottom of frame at nose → correct! The frame extends upward.
  offsetY: 0,
  offsetZ: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  defaultScale: parseFloat(targetScale.toFixed(6)),
}, null, 2));
