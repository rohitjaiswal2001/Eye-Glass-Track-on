#!/usr/bin/env node
/**
 * reprocess-cyberpunk-glb-v3.mjs
 *
 * Implements the perfect coordinate transformation by ignoring the tilted parent node
 * matrices and transforming the local coordinate system of the meshes directly:
 *   - X_world = X_local
 *   - Y_world = Z_local (height)
 *   - Z_world = -Y_local (temples go backward along -Z)
 *
 * This completely removes the -66.3° tilt and ensures the glasses are perfectly horizontal.
 * It then centers X around 0, centers Z (so lenses are at Z=0), and shifts Y so the bottom
 * of the lenses is at Y=0.
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

// ── First Pass: Transform local to target space & compute bounding box ─────
let gMin = [Infinity, Infinity, Infinity];
let gMax = [-Infinity, -Infinity, -Infinity];

gltf.meshes.forEach((mesh, mi) => {
  mesh.primitives?.forEach(prim => {
    const accIdx = prim.attributes?.POSITION;
    if (accIdx === undefined) return;
    const acc = gltf.accessors[accIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;

    for (let i = 0; i < acc.count; i++) {
      const off = byteOffset + i * stride;
      const lx = binData.readFloatLE(off + 0);
      const ly = binData.readFloatLE(off + 4);
      const lz = binData.readFloatLE(off + 8);

      // Transform:
      // X_target = lx
      // Y_target = lz
      // Z_target = -ly
      const tx = lx;
      const ty = lz;
      const tz = -ly;

      if (tx < gMin[0]) gMin[0] = tx; if (tx > gMax[0]) gMax[0] = tx;
      if (ty < gMin[1]) gMin[1] = ty; if (ty > gMax[1]) gMax[1] = ty;
      if (tz < gMin[2]) gMin[2] = tz; if (tz > gMax[2]) gMax[2] = tz;
    }
  });
});

const size   = gMin.map((v, i) => gMax[i] - v);
const center = gMin.map((v, i) => (gMax[i] + v) / 2);

console.log('=== Target Space Bounds (no offset) ===');
console.log(`  Min:  [${gMin.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`  Max:  [${gMax.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`  Size: W=${size[0].toFixed(4)} H=${size[1].toFixed(4)} D=${size[2].toFixed(4)}`);

// Shift to center the glasses:
//   - X should be centered at 0
//   - Z should be aligned so the front of the frame/lenses (which is at max Z because temples extend to min Z) sits at Z = 0
//     Max Z is around 0.29 (Mesh 0) or 0 (Mesh 2), so let's shift so Max Z is 0.
//   - Y should be aligned so the bottom of the frame is at Y = 0 (we'll adjust vertical positioning with offsetY calibration)
const cx = -center[0];
const cy = -gMin[1];
const cz = -gMax[2]; // shift so the front of the glasses sits at Z = 0

console.log(`\nOffsets: dX=${cx.toFixed(4)} dY=${cy.toFixed(4)} dZ=${cz.toFixed(4)}`);

// ── Second Pass: Apply transformation, centring, and scale ────────────────
gltf.meshes.forEach((mesh, mi) => {
  mesh.primitives?.forEach(prim => {
    // --- POSITION ---
    const posIdx = prim.attributes?.POSITION;
    if (posIdx !== undefined) {
      const acc = gltf.accessors[posIdx];
      const bv  = gltf.bufferViews[acc.bufferView];
      const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const stride = bv.byteStride ?? 12;
      let newMin = [Infinity, Infinity, Infinity], newMax = [-Infinity, -Infinity, -Infinity];

      for (let i = 0; i < acc.count; i++) {
        const off = byteOffset + i * stride;
        const lx = binData.readFloatLE(off + 0);
        const ly = binData.readFloatLE(off + 4);
        const lz = binData.readFloatLE(off + 8);

        let tx = lx + cx;
        let ty = lz + cy;
        let tz = -ly + cz;

        binData.writeFloatLE(tx, off + 0);
        binData.writeFloatLE(ty, off + 4);
        binData.writeFloatLE(tz, off + 8);

        if (tx < newMin[0]) newMin[0] = tx; if (tx > newMax[0]) newMax[0] = tx;
        if (ty < newMin[1]) newMin[1] = ty; if (ty > newMax[1]) newMax[1] = ty;
        if (tz < newMin[2]) newMin[2] = tz; if (tz > newMax[2]) newMax[2] = tz;
      }
      acc.min = newMin;
      acc.max = newMax;
      console.log(`  Mesh "${mesh.name}": min=[${newMin.map(v=>v.toFixed(3)).join(',')}] max=[${newMax.map(v=>v.toFixed(3)).join(',')}]`);
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
        const nx = binData.readFloatLE(off + 0);
        const ny = binData.readFloatLE(off + 4);
        const nz = binData.readFloatLE(off + 8);

        // Transform normals (directions only, same rotation):
        // nx_new = nx
        // ny_new = nz
        // nz_new = -ny
        const tx = nx;
        const ty = nz;
        const tz = -ny;

        const len = Math.sqrt(tx*tx + ty*ty + tz*tz) || 1;
        binData.writeFloatLE(tx/len, off + 0);
        binData.writeFloatLE(ty/len, off + 4);
        binData.writeFloatLE(tz/len, off + 8);
      }
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

// ── Reassemble GLB ───────────────────────────────────────────────────────────
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
console.log(`\nWrote straight aligned GLB → ${outPath}`);

// Compute calibration scale for a target 135mm (0.135m) width:
// Original local width is around 12.77cm (which is 12.77 units in local space).
// So width in local units is 12.7719.
const localWidth = size[0];
const targetScale = 0.135 / localWidth;
console.log(`Suggested scale: ${targetScale.toFixed(6)}`);
