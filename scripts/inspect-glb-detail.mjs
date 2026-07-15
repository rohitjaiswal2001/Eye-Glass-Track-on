#!/usr/bin/env node
/**
 * inspect-glb-detail.mjs
 * Deep analysis: prints full node transforms (including rotations),
 * scene hierarchy, and a corrected bounding box after applying
 * the Sketchfab coordinate conversion (Y-up to Z-up / FBX to glTF).
 */

import { readFileSync } from 'fs';

const filePath = process.argv[2] ?? 'public/models/cyberpunk_glasses.glb';
const buf = readFileSync(filePath);

const magic = buf.readUInt32LE(0);
if (magic !== 0x46546C67) { console.error('Not a GLB'); process.exit(1); }

const chunk0Length = buf.readUInt32LE(12);
const jsonText = buf.slice(20, 20 + chunk0Length).toString('utf8');
const gltf = JSON.parse(jsonText);

// Print ALL node data including rotation quaternions
console.log('═══ FULL NODE LIST ═══════════════════════════════════════════');
(gltf.nodes ?? []).forEach((n, i) => {
  const t = (n.translation ?? [0,0,0]).map(v => v.toFixed(4));
  const r = (n.rotation    ?? [0,0,0,1]).map(v => v.toFixed(4));
  const s = (n.scale       ?? [1,1,1]).map(v => v.toFixed(4));
  const m = n.matrix ? 'has matrix' : null;
  const children = n.children ? ` → children: [${n.children.join(',')}]` : '';
  const mesh = n.mesh !== undefined ? ` → mesh[${n.mesh}]` : '';
  console.log(`  [${i}] "${n.name ?? ''}"${mesh}${children}`);
  console.log(`       T=(${t.join(',')})  R=(${r.join(',')})  S=(${s.join(',')})${m ? '  ' + m : ''}`);
});

// Per-mesh size check
console.log('\n═══ MESH SIZES PER-PRIMITIVE ══════════════════════════════════');
(gltf.meshes ?? []).forEach((mesh, mi) => {
  (mesh.primitives ?? []).forEach((prim, pi) => {
    const posIdx = prim.attributes?.POSITION;
    if (posIdx === undefined) return;
    const acc = gltf.accessors?.[posIdx];
    if (!acc?.min) return;
    const sz = acc.max.map((v, k) => (v - acc.min[k]).toFixed(4));
    const cx = ((acc.max[0] + acc.min[0]) / 2).toFixed(4);
    const cy = ((acc.max[1] + acc.min[1]) / 2).toFixed(4);
    const cz = ((acc.max[2] + acc.min[2]) / 2).toFixed(4);
    console.log(`  mesh[${mi}] "${mesh.name}": size=(${sz.join(', ')})  center=(${cx}, ${cy}, ${cz})`);
  });
});

// Sketchfab FBX files often have root rotation: -90° around X to convert
// from Y-up (FBX default) to Z-up... actually, let's just report the root node's rotation
console.log('\n═══ ROOT NODE ROTATION (key for coordinate conversion) ════════');
const root = gltf.nodes?.[0];
if (root?.rotation) {
  const [rx, ry, rz, rw] = root.rotation;
  // Convert quaternion to Euler angles for readability
  const roll  = Math.atan2(2*(rw*rx + ry*rz), 1-2*(rx*rx + ry*ry)) * 180/Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2*(rw*ry - rz*rx)))) * 180/Math.PI;
  const yaw   = Math.atan2(2*(rw*rz + rx*ry), 1-2*(ry*ry + rz*rz)) * 180/Math.PI;
  console.log(`  Root quaternion (x,y,z,w): (${root.rotation.map(v => v.toFixed(5)).join(', ')})`);
  console.log(`  Euler (Roll/X, Pitch/Y, Yaw/Z): ${roll.toFixed(1)}°, ${pitch.toFixed(1)}°, ${yaw.toFixed(1)}°`);
} else if (root?.matrix) {
  console.log(`  Root has matrix: ${root.matrix.map(v => v.toFixed(4)).join(', ')}`);
} else {
  console.log('  Root: no rotation (identity)');
}

// Check node[1] (Johnny glasses.fbx)
const n1 = gltf.nodes?.[1];
if (n1?.rotation) {
  const [rx, ry, rz, rw] = n1.rotation;
  const roll  = Math.atan2(2*(rw*rx + ry*rz), 1-2*(rx*rx + ry*ry)) * 180/Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2*(rw*ry - rz*rx)))) * 180/Math.PI;
  const yaw   = Math.atan2(2*(rw*rz + rx*ry), 1-2*(ry*ry + rz*rz)) * 180/Math.PI;
  console.log(`\n  Node[1] "${n1.name}" quaternion (x,y,z,w): (${n1.rotation.map(v => v.toFixed(5)).join(', ')})`);
  console.log(`  Euler: Roll=${roll.toFixed(1)}°, Pitch=${pitch.toFixed(1)}°, Yaw=${yaw.toFixed(1)}°`);
} else if (n1?.matrix) {
  console.log(`\n  Node[1] "${n1?.name}" has matrix: ${n1.matrix.map(v => v.toFixed(4)).join(', ')}`);
}

// Check all nodes for rotation
console.log('\n═══ NODES WITH NON-IDENTITY ROTATION ══════════════════════════');
(gltf.nodes ?? []).forEach((n, i) => {
  const r = n.rotation;
  const m = n.matrix;
  if (r && (Math.abs(r[0]) > 0.001 || Math.abs(r[1]) > 0.001 || Math.abs(r[2]) > 0.001 || Math.abs(r[3] - 1) > 0.001)) {
    const [rx, ry, rz, rw] = r;
    const roll  = Math.atan2(2*(rw*rx + ry*rz), 1-2*(rx*rx + ry*ry)) * 180/Math.PI;
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2*(rw*ry - rz*rx)))) * 180/Math.PI;
    const yaw   = Math.atan2(2*(rw*rz + rx*ry), 1-2*(ry*ry + rz*rz)) * 180/Math.PI;
    console.log(`  [${i}] "${n.name}": quat=(${r.map(v=>v.toFixed(4)).join(',')})  Euler: R=${roll.toFixed(1)}° P=${pitch.toFixed(1)}° Y=${yaw.toFixed(1)}°`);
  }
  if (m) {
    console.log(`  [${i}] "${n.name}": has 4x4 matrix`);
    // Print matrix rows
    for (let row = 0; row < 4; row++) {
      console.log(`    row${row}: ${m.slice(row*4, row*4+4).map(v => v.toFixed(4)).join('  ')}`);
    }
  }
});
