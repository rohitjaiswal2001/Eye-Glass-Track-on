#!/usr/bin/env node
/**
 * reprocess-cyberpunk-glb-v2.mjs
 *
 * Fixed version: after analysing the world-space bounds, the glasses need:
 *  1. All node transforms baked into vertex data (already done in v1)
 *  2. The frame front face should be at Z ≈ 0 (nose bridge) and the temples
 *     extend in the -Z direction (backward, toward ears).
 *  3. In the v1 output, the lens surface is at Z~1.2m and temples extend
 *     toward Z~-1.2m — meaning Z is inverted relative to what Three.js/glTF
 *     expects. We need to NEGATE Z (mirror on Z axis) to flip the model.
 *  4. After Z-flip, also re-centre X and Z, and align Y bottom to 0.
 *
 * The Sketchfab→FBX→glTF conversion chain swaps axes multiple times,
 * resulting in the glasses facing +Z when they should face -Z.
 */

import { readFileSync, writeFileSync } from 'fs';

const inPath  = process.argv[2] ?? 'public/models/cyberpunk_glasses.glb';
const outPath = process.argv[3] ?? 'public/models/cyberpunk_glasses_aligned.glb';

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546C67) { console.error('Not a GLB'); process.exit(1); }

const jsonLen  = buf.readUInt32LE(12);
const jsonText = buf.slice(20, 20 + jsonLen).toString('utf8');
const gltf     = JSON.parse(jsonText);

const binOffset = 20 + jsonLen;
const binLen    = buf.readUInt32LE(binOffset);
const binData   = Buffer.from(buf.slice(binOffset + 8, binOffset + 8 + binLen));

// ── Matrix helpers (column-major) ──────────────────────────────────────────

function mat4FromGltfMatrix(m) { return [...m]; }

function mat4Multiply(A, B) {
  const R = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += A[k*4+row] * B[col*4+k];
      R[col*4+row] = sum;
    }
  return R;
}

function mat4FromTRS(t, r, s) {
  const [tx, ty, tz] = t ?? [0,0,0];
  const [qx,qy,qz,qw] = r ?? [0,0,0,1];
  const [sx,sy,sz] = s ?? [1,1,1];
  const x2=qx+qx,y2=qy+qy,z2=qz+qz;
  const xx=qx*x2,xy=qx*y2,xz=qx*z2,yy=qy*y2,yz=qy*z2,zz=qz*z2,wx=qw*x2,wy=qw*y2,wz=qw*z2;
  return [
    (1-(yy+zz))*sx, (xy+wz)*sx,       (xz-wy)*sx,      0,
    (xy-wz)*sy,     (1-(xx+zz))*sy,   (yz+wx)*sy,      0,
    (xz+wy)*sz,     (yz-wx)*sz,       (1-(xx+yy))*sz,  0,
    tx, ty, tz, 1
  ];
}

function getNodeMatrix(n) {
  if (n.matrix) return mat4FromGltfMatrix(n.matrix);
  return mat4FromTRS(n.translation, n.rotation, n.scale);
}

function transformPoint(mat, px, py, pz) {
  return [
    mat[0]*px + mat[4]*py + mat[8]*pz  + mat[12],
    mat[1]*px + mat[5]*py + mat[9]*pz  + mat[13],
    mat[2]*px + mat[6]*py + mat[10]*pz + mat[14],
  ];
}

function transformNormal(mat, nx, ny, nz) {
  const wx = mat[0]*nx + mat[4]*ny + mat[8]*nz;
  const wy = mat[1]*nx + mat[5]*ny + mat[9]*nz;
  const wz = mat[2]*nx + mat[6]*ny + mat[10]*nz;
  const l = Math.sqrt(wx*wx+wy*wy+wz*wz)||1;
  return [wx/l, wy/l, wz/l];
}

// ── Compute world matrices ──────────────────────────────────────────────────
const worldMatrix = new Array(gltf.nodes.length).fill(null);

function computeWorldMatrices(ni, parentMat) {
  const n = gltf.nodes[ni];
  const local = getNodeMatrix(n);
  const world = parentMat ? mat4Multiply(parentMat, local) : local;
  worldMatrix[ni] = world;
  (n.children ?? []).forEach(ci => computeWorldMatrices(ci, world));
}
(gltf.scenes?.[0]?.nodes ?? [0]).forEach(ri => computeWorldMatrices(ri, null));

const nodeMeshMap = {};
gltf.nodes.forEach((n, ni) => {
  if (n.mesh !== undefined) {
    if (!nodeMeshMap[n.mesh]) nodeMeshMap[n.mesh] = [];
    nodeMeshMap[n.mesh].push(worldMatrix[ni] ?? [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  }
});

// ── First pass: compute world bounding box ──────────────────────────────────
let gMin = [Infinity,Infinity,Infinity];
let gMax = [-Infinity,-Infinity,-Infinity];

gltf.meshes.forEach((mesh, mi) => {
  const mat = (nodeMeshMap[mi] ?? [[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]])[0];
  mesh.primitives?.forEach(prim => {
    const accIdx = prim.attributes?.POSITION;
    if (accIdx === undefined) return;
    const acc = gltf.accessors[accIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;
    for (let i = 0; i < acc.count; i++) {
      const off = byteOffset + i * stride;
      const [wx,wy,wz] = transformPoint(mat,
        binData.readFloatLE(off+0), binData.readFloatLE(off+4), binData.readFloatLE(off+8));
      if(wx<gMin[0])gMin[0]=wx; if(wx>gMax[0])gMax[0]=wx;
      if(wy<gMin[1])gMin[1]=wy; if(wy>gMax[1])gMax[1]=wy;
      if(wz<gMin[2])gMin[2]=wz; if(wz>gMax[2])gMax[2]=wz;
    }
  });
});

const wSize   = gMin.map((v,i)=>gMax[i]-v);
const wCenter = gMin.map((v,i)=>(gMax[i]+v)/2);

console.log('=== World bounding box before recentering ===');
console.log(`  Min: ${gMin.map(v=>v.toFixed(4)).join(', ')}`);
console.log(`  Max: ${gMax.map(v=>v.toFixed(4)).join(', ')}`);
console.log(`  Size: W=${wSize[0].toFixed(4)} H=${wSize[1].toFixed(4)} D=${wSize[2].toFixed(4)}`);

// The glasses width is along X (2.75m wide after ×0.01 scale).
// After Sketchfab Y-up→Z-up conversion and FBX→glTF, the glasses
// face the +Z direction (frame front at max-Z, temples extend toward min-Z).
// We need to NEGATE Z so the front faces -Z (glTF: camera looks down -Z).
// Also centre on X, Z. Align Y so bottom of frame (= nose bridge contact) is at Y=0.

// Step 1: negate Z (mirror on Z=0 plane)
// Step 2: re-compute center after Z flip: zCenter becomes -wCenter[2]
const cx = -wCenter[0];   // shift X center to 0
const cy = -gMin[1];       // shift Y min (bottom) to 0
const cz = wCenter[2];     // after Z-negate, world center moves to -wCenter[2], then shift to 0

console.log(`\nApplying: flip-Z, then centring offsets dX=${cx.toFixed(4)} dY=${cy.toFixed(4)} dZ=${cz.toFixed(4)}`);

// ── Second pass: transform & re-centre vertices ─────────────────────────────
gltf.meshes.forEach((mesh, mi) => {
  const mat = (nodeMeshMap[mi] ?? [[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]])[0];
  mesh.primitives?.forEach(prim => {
    // --- POSITION ---
    const posIdx = prim.attributes?.POSITION;
    if (posIdx !== undefined) {
      const acc = gltf.accessors[posIdx];
      const bv  = gltf.bufferViews[acc.bufferView];
      const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const stride = bv.byteStride ?? 12;
      let newMin=[Infinity,Infinity,Infinity], newMax=[-Infinity,-Infinity,-Infinity];
      for (let i = 0; i < acc.count; i++) {
        const off = byteOffset + i * stride;
        let [wx,wy,wz] = transformPoint(mat,
          binData.readFloatLE(off+0), binData.readFloatLE(off+4), binData.readFloatLE(off+8));
        // Flip Z
        wz = -wz;
        // Centre
        wx += cx; wy += cy; wz += cz;
        binData.writeFloatLE(wx, off+0);
        binData.writeFloatLE(wy, off+4);
        binData.writeFloatLE(wz, off+8);
        if(wx<newMin[0])newMin[0]=wx; if(wx>newMax[0])newMax[0]=wx;
        if(wy<newMin[1])newMin[1]=wy; if(wy>newMax[1])newMax[1]=wy;
        if(wz<newMin[2])newMin[2]=wz; if(wz>newMax[2])newMax[2]=wz;
      }
      acc.min = newMin;
      acc.max = newMax;
      console.log(`  Mesh[${mi}] pos: min=(${newMin.map(v=>v.toFixed(3)).join(',')}) max=(${newMax.map(v=>v.toFixed(3)).join(',')})`);
    }
    // --- NORMAL ---
    const normIdx = prim.attributes?.NORMAL;
    if (normIdx !== undefined) {
      const acc = gltf.accessors[normIdx];
      const bv  = gltf.bufferViews[acc.bufferView];
      const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const stride = bv.byteStride ?? 12;
      for (let i = 0; i < acc.count; i++) {
        const off = byteOffset + i * stride;
        let [wx,wy,wz] = transformNormal(mat,
          binData.readFloatLE(off+0), binData.readFloatLE(off+4), binData.readFloatLE(off+8));
        wz = -wz;  // flip Z component of normal too
        const l = Math.sqrt(wx*wx+wy*wy+wz*wz)||1;
        binData.writeFloatLE(wx/l, off+0);
        binData.writeFloatLE(wy/l, off+4);
        binData.writeFloatLE(wz/l, off+8);
      }
    }
  });
});

// ── Reset all node transforms ──────────────────────────────────────────────
gltf.nodes.forEach(n => { delete n.matrix; delete n.translation; delete n.rotation; delete n.scale; });

// ── Reassemble GLB ─────────────────────────────────────────────────────────
const newJsonRaw = JSON.stringify(gltf);
const jsonPadded = newJsonRaw.padEnd(Math.ceil(newJsonRaw.length/4)*4, ' ');
const newJsonBuf = Buffer.from(jsonPadded, 'utf8');
const totalLen = 12 + 8 + newJsonBuf.length + 8 + binData.length;
const out = Buffer.allocUnsafe(totalLen);

out.writeUInt32LE(0x46546C67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(totalLen, 8);
out.writeUInt32LE(newJsonBuf.length, 12);
out.writeUInt32LE(0x4E4F534A, 16);
newJsonBuf.copy(out, 20);
const bco = 20 + newJsonBuf.length;
out.writeUInt32LE(binData.length, bco);
out.writeUInt32LE(0x004E4942, bco+4);
binData.copy(out, bco+8);

writeFileSync(outPath, out);

// Report final bounds and calibration
const fw = wSize[0];  // frame width in metres (before scale)
const scale = 0.135 / fw;

console.log(`\nWrote → ${outPath}  (${(out.length/1024/1024).toFixed(1)} MB)`);
console.log('\nSuggested calibration (frame in metres after scale):');
const json = {
  frameId: 'cyberpunk_glasses',
  frameWidth: 125,
  bridgeWidth: 16,
  lensWidth: 48,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  defaultScale: parseFloat(scale.toFixed(6)),
};
console.log(JSON.stringify(json, null, 2));
