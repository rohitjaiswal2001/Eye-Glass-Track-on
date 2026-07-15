#!/usr/bin/env node
/**
 * reprocess-cyberpunk-glb-v4.mjs
 *
 * The ultimate alignment script for the Cyberpunk glasses.
 * Centers the model precisely such that:
 *   - X center of the frame is at X = 0 (no horizontal shift).
 *   - Y center of the lenses (Mesh 4 "Johnny Glasses_Cam_0") is at Y = 0 (perfect eye alignment).
 *   - Z front of the lenses is at Z = 0, with temples extending backward into -Z.
 *
 * This completely resolves:
 *   - The vertical height issue (glasses rendered on forehead).
 *   - The temple orientation issue (temples pointing forward/sideways).
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

// ── First Pass: Find lenses bounding box in target space ──────────────────
let lensesMinY = Infinity;
let lensesMaxY = -Infinity;
let lensesMaxZ = -Infinity;

let allMinX = Infinity;
let allMaxX = -Infinity;

gltf.meshes.forEach((mesh, mi) => {
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
      const lx = binData.readFloatLE(off + 0);
      const ly = binData.readFloatLE(off + 4);
      const lz = binData.readFloatLE(off + 8);

      // Target space mapping:
      // X_target = lx
      // Y_target = lz
      // Z_target = -ly
      const tx = lx;
      const ty = lz;
      const tz = -ly;

      if (tx < allMinX) allMinX = tx;
      if (tx > allMaxX) allMaxX = tx;

      if (isLenses) {
        if (ty < lensesMinY) lensesMinY = ty;
        if (ty > lensesMaxY) lensesMaxY = ty;
        if (tz > lensesMaxZ) lensesMaxZ = tz;
      }
    }
  });
});

const xCenter = (allMinX + allMaxX) / 2;
const yCenterLenses = (lensesMinY + lensesMaxY) / 2;

// Offsets to center the model:
// - X: Center of all meshes to 0
// - Y: Center of the lenses to 0
// - Z: Front of the lenses (max Z) to 0 (so temples extend to negative Z)
const cx = -xCenter;
const cy = -yCenterLenses;
const cz = -lensesMaxZ;

console.log('=== Lenses Target Space Bounds ===');
console.log(`  Min Y: ${lensesMinY.toFixed(4)}`);
console.log(`  Max Y: ${lensesMaxY.toFixed(4)}`);
console.log(`  Max Z (Front): ${lensesMaxZ.toFixed(4)}`);
console.log(`\nCentring Offsets: dX=${cx.toFixed(4)} dY=${cy.toFixed(4)} dZ=${cz.toFixed(4)}`);

// ── Second Pass: Transform, center, and re-write ───────────────────────────
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

        // Apply transformation + centring offsets
        const tx = lx + cx;
        const ty = lz + cy;
        const tz = -ly + cz;

        binData.writeFloatLE(tx, off + 0);
        binData.writeFloatLE(ty, off + 4);
        binData.writeFloatLE(tz, off + 8);

        if (tx < newMin[0]) newMin[0] = tx; if (tx > newMax[0]) newMax[0] = tx;
        if (ty < newMin[1]) newMin[1] = ty; if (ty > newMax[1]) newMax[1] = ty;
        if (tz < newMin[2]) newMin[2] = tz; if (tz > newMax[2]) newMax[2] = tz;
      }
      acc.min = newMin;
      acc.max = newMax;
      console.log(`  Mesh ${mi} ("${mesh.name}"): min=[${newMin.map(v=>v.toFixed(3)).join(',')}] max=[${newMax.map(v=>v.toFixed(3)).join(',')}]`);
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

        // Rotate normals:
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

// ── Reset node transforms to identity ──────────────────────────────────────
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
console.log(`\nWrote aligned GLB → ${outPath}`);

// Width in local units is 12.7719.
const localWidth = allMaxX - allMinX;
const targetScale = 0.135 / localWidth;
console.log(`Suggested scale: ${targetScale.toFixed(6)}`);
