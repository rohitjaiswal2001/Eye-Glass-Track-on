#!/usr/bin/env node
/**
 * simulate-calibration.mjs
 *
 * Simulates the CalibrationEngine positioning and rotation on the original GLB mesh vertices.
 * Tests different rotation values (rotationX, rotationY, rotationZ) and offsets
 * to find the parameters that result in:
 *   - Frame width centered at X = 0, size = 135mm
 *   - Lens center at Y = 0
 *   - Lenses front at Z = 0, temples extending backward into -Z
 *   - Glasses perfectly straight (minimal Y range for the lens mesh, i.e. no tilt).
 */

import { readFileSync } from 'fs';

const buf = readFileSync('public/models/cyberpunk_glasses.glb');
const jsonLen = buf.readUInt32LE(12);
const jsonText = buf.slice(20, 20 + jsonLen).toString('utf8');
const gltf = JSON.parse(jsonText);

const binOffset = 20 + jsonLen;
const binLen = buf.readUInt32LE(binOffset);
const binData = buf.slice(binOffset + 8, binOffset + 8 + binLen);

// ── Math helpers ──────────────────────────────────────────────────────────

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

// Simple Euler to Quaternion conversion
function quatFromEulerYXZ(pitch, yaw, roll) {
  const c1 = Math.cos(pitch / 2);
  const s1 = Math.sin(pitch / 2);
  const c2 = Math.cos(yaw / 2);
  const s2 = Math.sin(yaw / 2);
  const c3 = Math.cos(roll / 2);
  const s3 = Math.sin(roll / 2);

  // YXZ order
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3
  ];
}

function mat4FromQuat(q) {
  const [qx, qy, qz, qw] = q;
  const x2=qx+qx, y2=qy+qy, z2=qz+qz;
  const xx=qx*x2, xy=qx*y2, xz=qx*z2;
  const yy=qy*y2, yz=qy*z2, zz=qz*z2;
  const wx=qw*x2, wy=qw*y2, wz=qw*z2;
  return [
    1-(yy+zz), xy+wz,     xz-wy,     0,
    xy-wz,     1-(xx+zz), yz+wx,     0,
    xz+wy,     yz-wx,     1-(xx+yy), 0,
    0, 0, 0, 1
  ];
}

const worldMatrix = new Array(gltf.nodes.length).fill(null);
function computeWorld(ni, parent) {
  const n = gltf.nodes[ni];
  const local = n.matrix ? [...n.matrix] : mat4FromTRS(n.translation, n.rotation, n.scale);
  const world = parent ? mat4Multiply(parent, local) : local;
  worldMatrix[ni] = world;
  (n.children ?? []).forEach(ci => computeWorld(ci, world));
}
(gltf.scenes?.[0]?.nodes ?? [0]).forEach(ri => computeWorld(ri, null));

const nodeMeshMap = {};
gltf.nodes.forEach((n, ni) => {
  if (n.mesh !== undefined) {
    if (!nodeMeshMap[n.mesh]) nodeMeshMap[n.mesh] = [];
    nodeMeshMap[n.mesh].push(worldMatrix[ni]);
  }
});

// Load original vertices in world space
const originalWorldVertices = [];
gltf.meshes.forEach((mesh, mi) => {
  const mat = (nodeMeshMap[mi] ?? [])[0];
  if (!mat) return;
  const isLenses = mi === 4 || mesh.name.toLowerCase().includes('cam');

  mesh.primitives?.forEach(prim => {
    const accIdx = prim.attributes?.POSITION;
    if (accIdx === undefined) return;
    const acc = gltf.accessors[accIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;

    for (let i = 0; i < acc.count; i++) {
      const off = byteOffset + i * stride;
      const px = binData.readFloatLE(off + 0);
      const py = binData.readFloatLE(off + 4);
      const pz = binData.readFloatLE(off + 8);

      const wx = mat[0]*px + mat[4]*py + mat[8]*pz  + mat[12];
      const wy = mat[1]*px + mat[5]*py + mat[9]*pz  + mat[13];
      const wz = mat[2]*px + mat[6]*py + mat[10]*pz + mat[14];

      originalWorldVertices.push({ x: wx, y: wy, z: wz, isLenses });
    }
  });
});

console.log(`Loaded ${originalWorldVertices.length} vertices.`);

function testCalibration(rx_deg, ry_deg, rz_deg, scale) {
  const rx = rx_deg * Math.PI / 180;
  const ry = ry_deg * Math.PI / 180;
  const rz = rz_deg * Math.PI / 180;

  const q = quatFromEulerYXZ(rx, ry, rz);
  const rotMat = mat4FromQuat(q);

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];

  let lenMinY = Infinity;
  let lenMaxY = -Infinity;

  originalWorldVertices.forEach(v => {
    // Apply local corrective rotation
    const rx = rotMat[0]*v.x + rotMat[4]*v.y + rotMat[8]*v.z;
    const ry = rotMat[1]*v.x + rotMat[5]*v.y + rotMat[9]*v.z;
    const rz = rotMat[2]*v.x + rotMat[6]*v.y + rotMat[10]*v.z;

    const sx = rx * scale;
    const sy = ry * scale;
    const sz = rz * scale;

    if (sx < min[0]) min[0] = sx; if (sx > max[0]) max[0] = sx;
    if (sy < min[1]) min[1] = sy; if (sy > max[1]) max[1] = sy;
    if (sz < min[2]) min[2] = sz; if (sz > max[2]) max[2] = sz;

    if (v.isLenses) {
      if (sy < lenMinY) lenMinY = sy;
      if (sy > lenMaxY) lenMaxY = sy;
    }
  });

  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const depth = max[2] - min[2];
  const lenHeight = lenMaxY - lenMinY;

  return { min, max, width, height, depth, lenHeight, lenMinY, lenMaxY };
}

// We want to find a rotation that makes the lenses height (lenHeight) as small as possible
// (which means the lenses are perfectly aligned to the vertical plane, i.e. no tilt).
// Let's scan Y-rotation (since local Y is the tilt axis) from -180 to 180:
let bestRy = 0;
let minLenHeight = Infinity;

for (let ry = -180; ry <= 180; ry += 0.5) {
  const res = testCalibration(0, ry, 0, 0.049);
  if (res.lenHeight < minLenHeight) {
    minLenHeight = res.lenHeight;
    bestRy = ry;
  }
}

console.log(`\nBest corrective rotationY: ${bestRy.toFixed(1)}° (minimizes lens vertical span to ${(minLenHeight*1000).toFixed(1)}mm)`);

// Now let's calculate the correct scale to get exactly 135mm width:
const initialRes = testCalibration(0, bestRy, 0, 1.0);
const targetScale = 0.135 / initialRes.width;
console.log(`Suggested scale: ${targetScale.toFixed(6)}`);

// Now calculate the centered bounds using the targetScale
const finalRes = testCalibration(0, bestRy, 0, targetScale);
console.log('\n=== Final Bounds with best rotation + scale ===');
console.log(`  Width:  ${(finalRes.width * 1000).toFixed(1)} mm`);
console.log(`  Height: ${(finalRes.height * 1000).toFixed(1)} mm`);
console.log(`  Depth:  ${(finalRes.depth * 1000).toFixed(1)} mm`);
console.log(`  Lens Vertical Span: ${(finalRes.lenHeight * 1000).toFixed(1)} mm`);

// Center coordinates:
const cx = -(finalRes.min[0] + finalRes.max[0]) / 2;
const cy = -(finalRes.lenMinY + finalRes.lenMaxY) / 2;
const cz = -finalRes.max[2]; // align lenses front to Z=0

console.log(`\nSuggested sidecar JSON values (in millimeters):`);
console.log(JSON.stringify({
  frameId: 'cyberpunk_glasses',
  frameWidth: 125,
  bridgeWidth: 16,
  lensWidth: 48,
  offsetX: parseFloat((cx * 1000).toFixed(2)),
  offsetY: parseFloat((cy * 1000).toFixed(2)),
  offsetZ: parseFloat((cz * 1000).toFixed(2)),
  rotationX: 0,
  rotationY: parseFloat(bestRy.toFixed(2)),
  rotationZ: 0,
  defaultScale: parseFloat(targetScale.toFixed(6)),
}, null, 2));
