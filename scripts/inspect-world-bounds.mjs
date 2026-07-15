#!/usr/bin/env node
import { readFileSync } from 'fs';

const buf = readFileSync('public/models/cyberpunk_glasses.glb');
const jsonLen = buf.readUInt32LE(12);
const jsonText = buf.slice(20, 20 + jsonLen).toString('utf8');
const gltf = JSON.parse(jsonText);

const binOffset = 20 + jsonLen;
const binLen = buf.readUInt32LE(binOffset);
const binData = buf.slice(binOffset + 8, binOffset + 8 + binLen);

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

console.log('=== World Bounds per Mesh (before any recentering or modification) ===');
gltf.meshes.forEach((mesh, mi) => {
  const mat = (nodeMeshMap[mi] ?? [])[0];
  if (!mat) return;
  mesh.primitives?.forEach((prim, pi) => {
    const posIdx = prim.attributes?.POSITION;
    if (posIdx === undefined) return;
    const acc = gltf.accessors[posIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;

    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < acc.count; i++) {
      const off = byteOffset + i * stride;
      const px = binData.readFloatLE(off + 0);
      const py = binData.readFloatLE(off + 4);
      const pz = binData.readFloatLE(off + 8);

      const wx = mat[0]*px + mat[4]*py + mat[8]*pz  + mat[12];
      const wy = mat[1]*px + mat[5]*py + mat[9]*pz  + mat[13];
      const wz = mat[2]*px + mat[6]*py + mat[10]*pz + mat[14];

      if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
      if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
      if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
    }

    console.log(`Mesh ${mi} ("${mesh.name}") prim ${pi}:`);
    console.log(`  Min:  [${min.map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`  Max:  [${max.map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`  Size: [${min.map((v, idx) => (max[idx] - v).toFixed(4)).join(', ')}]`);
  });
});
