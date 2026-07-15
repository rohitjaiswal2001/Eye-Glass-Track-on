#!/usr/bin/env node
/**
 * inspect-glb-raw.mjs
 * Parses a GLB file at the binary level to extract accessor bounds
 * (min/max from all POSITION accessors) without needing a browser environment.
 * This gives us the geometry bounding box directly from the JSON chunk.
 */

import { readFileSync } from 'fs';

const filePath = process.argv[2] ?? 'public/models/cyberpunk_glasses.glb';
const buf = readFileSync(filePath);

// ── GLB header ─────────────────────────────────────────────────────────────
// Magic: 0x46546C67  ("glTF")
// Version: uint32
// Length: uint32
const magic = buf.readUInt32LE(0);
const version = buf.readUInt32LE(4);
const totalLength = buf.readUInt32LE(8);

if (magic !== 0x46546C67) {
  console.error('Not a GLB file (wrong magic bytes)');
  process.exit(1);
}
console.log(`GLB  version=${version}  totalLength=${totalLength} bytes`);

// ── Chunk 0: JSON ──────────────────────────────────────────────────────────
const chunk0Length = buf.readUInt32LE(12);
const chunk0Type   = buf.readUInt32LE(16);   // 0x4E4F534A = "JSON"
const jsonText     = buf.slice(20, 20 + chunk0Length).toString('utf8');
const gltf         = JSON.parse(jsonText);

console.log(`\nNode count:     ${gltf.nodes?.length ?? 0}`);
console.log(`Mesh count:     ${gltf.meshes?.length ?? 0}`);
console.log(`Accessor count: ${gltf.accessors?.length ?? 0}`);
console.log(`Material count: ${gltf.materials?.length ?? 0}`);

// ── Print node hierarchy ───────────────────────────────────────────────────
if (gltf.nodes) {
  console.log('\n── Nodes ─────────────────────────────────────────────────────');
  gltf.nodes.forEach((n, i) => {
    const translation = n.translation ? n.translation.map(v => v.toFixed(4)).join(', ') : '0, 0, 0';
    const scale       = n.scale       ? n.scale.map(v => v.toFixed(4)).join(', ')       : '1, 1, 1';
    const meshRef     = n.mesh !== undefined ? ` → mesh[${n.mesh}] "${gltf.meshes?.[n.mesh]?.name ?? ''}"` : '';
    console.log(`  [${i}] "${n.name ?? ''}"  t=(${translation})  s=(${scale})${meshRef}`);
  });
}

// ── Collect all POSITION accessor min/max ─────────────────────────────────
let globalMin = [Infinity, Infinity, Infinity];
let globalMax = [-Infinity, -Infinity, -Infinity];
let hasPosition = false;

if (gltf.meshes && gltf.accessors) {
  console.log('\n── Mesh Primitives (POSITION accessor bounds) ────────────────');
  gltf.meshes.forEach((mesh, mi) => {
    mesh.primitives?.forEach((prim, pi) => {
      const posIndex = prim.attributes?.POSITION;
      if (posIndex === undefined) return;
      const acc = gltf.accessors[posIndex];
      if (!acc?.min || !acc?.max) return;
      hasPosition = true;
      console.log(`  mesh[${mi}] prim[${pi}] "${mesh.name ?? ''}"  min=(${acc.min.map(v => v.toFixed(5)).join(', ')})  max=(${acc.max.map(v => v.toFixed(5)).join(', ')})`);
      for (let i = 0; i < 3; i++) {
        if (acc.min[i] < globalMin[i]) globalMin[i] = acc.min[i];
        if (acc.max[i] > globalMax[i]) globalMax[i] = acc.max[i];
      }
    });
  });
}

if (!hasPosition) {
  console.log('\n  (no POSITION accessors with min/max found — accessor mins/maxes may be omitted in this file)');
  // Try to get from nodes' translations instead
  process.exit(0);
}

const size   = globalMin.map((mn, i) => globalMax[i] - mn);
const center = globalMin.map((mn, i) => (globalMax[i] + mn) / 2);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('OVERALL BOUNDS (raw model units, no node transforms applied)');
console.log(`  Min:    ${globalMin.map(v => v.toFixed(6)).join(', ')}`);
console.log(`  Max:    ${globalMax.map(v => v.toFixed(6)).join(', ')}`);
console.log(`  Size:   W=${size[0].toFixed(6)}  H=${size[1].toFixed(6)}  D=${size[2].toFixed(6)}`);
console.log(`  Center: X=${center[0].toFixed(6)}  Y=${center[1].toFixed(6)}  Z=${center[2].toFixed(6)}`);

// ── Recommend calibration ──────────────────────────────────────────────────
const W = size[0];
const TARGET_W_M = 0.135;  // 135mm glasses width in metres

let unit = 'unknown', unitScale = 1;
if (W > 0.02 && W < 0.5)    { unit = 'metres (already correct scale)';  unitScale = 1; }
else if (W >= 0.5 && W < 3) { unit = 'metres (character scale)';        unitScale = 1; }
else if (W >= 3 && W < 80)  { unit = 'centimetres → ×0.01';             unitScale = 0.01; }
else if (W >= 80)            { unit = 'millimetres → ×0.001';            unitScale = 0.001; }

const effectiveW = W * unitScale;
const suggestedScale = TARGET_W_M / effectiveW;
const offsetX_mm = -(center[0] * unitScale * 1000);
const offsetY_mm = -(center[1] * unitScale * 1000);
const offsetZ_mm = -(center[2] * unitScale * 1000) + 10;  // +10mm forward

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('CALIBRATION RECOMMENDATIONS');
console.log(`  Detected unit:    ${unit}`);
console.log(`  Effective width:  ${(effectiveW * 1000).toFixed(1)} mm`);
console.log(`  Suggested scale:  ${suggestedScale.toFixed(6)}`);
console.log(`  Offset (mm):      X=${offsetX_mm.toFixed(2)}  Y=${offsetY_mm.toFixed(2)}  Z=${offsetZ_mm.toFixed(2)}`);
console.log('\nSuggested cyberpunk_glasses.json:');
console.log(JSON.stringify({
  frameId: 'cyberpunk_glasses',
  frameWidth: 125,
  bridgeWidth: 16,
  lensWidth: 48,
  offsetX: parseFloat(offsetX_mm.toFixed(2)),
  offsetY: parseFloat(offsetY_mm.toFixed(2)),
  offsetZ: parseFloat(offsetZ_mm.toFixed(2)),
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  defaultScale: parseFloat(suggestedScale.toFixed(6)),
}, null, 2));
