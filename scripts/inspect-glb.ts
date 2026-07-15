/**
 * inspect-glb.ts
 * Loads a GLB via Three.js and reports the bounding box, size, and
 * child mesh names so we can compute correct calibration values.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'fs';

// We need node-compatible GLTF loading. Three's GLTFLoader works with
// raw ArrayBuffer in non-browser contexts.
const filePath = process.argv[2] ?? 'public/models/cyberpunk_glasses.glb';
const buffer = readFileSync(filePath);

// @ts-ignore — Three GLTFLoader's parse() accepts ArrayBuffer
const loader = new GLTFLoader();

loader.parse(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  '',
  (gltf) => {
    const scene = gltf.scene;

    // List all mesh names + individual bounds
    const meshNames: string[] = [];
    scene.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        const mesh = node as THREE.Mesh;
        const box = new THREE.Box3().setFromObject(mesh);
        const size = new THREE.Vector3();
        box.getSize(size);
        console.log(`  Mesh: "${mesh.name}" | bounds: ${box.min.toArray().map((v: number) => v.toFixed(4))} → ${box.max.toArray().map((v: number) => v.toFixed(4))} | size: ${size.toArray().map((v: number) => v.toFixed(4))}`);
        meshNames.push(mesh.name);
      }
    });

    // Overall bounding box (all meshes combined)
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    console.log('\n=== OVERALL BOUNDING BOX ===');
    console.log(`  Min:    ${box.min.toArray().map((v: number) => v.toFixed(6)).join(', ')}`);
    console.log(`  Max:    ${box.max.toArray().map((v: number) => v.toFixed(6)).join(', ')}`);
    console.log(`  Size:   W=${size.x.toFixed(6)}  H=${size.y.toFixed(6)}  D=${size.z.toFixed(6)}`);
    console.log(`  Center: X=${center.x.toFixed(6)}  Y=${center.y.toFixed(6)}  Z=${center.z.toFixed(6)}`);

    // Determine the likely unit:
    //  If W is roughly 0.1–0.2: probably meters (correct for glasses)
    //  If W is roughly 10–20: probably centimeters → need scale 0.01
    //  If W is roughly 100–200: probably millimeters → need scale 0.001
    const likelyWidth = size.x;
    let likelyUnit = 'unknown';
    let suggestedScale = 1.0;
    const TARGET_WIDTH_M = 0.135; // 135mm physical glasses width in meters

    if (likelyWidth > 0.05 && likelyWidth < 0.5) {
      likelyUnit = 'meters (correct)';
      suggestedScale = TARGET_WIDTH_M / likelyWidth;
    } else if (likelyWidth >= 5 && likelyWidth < 50) {
      likelyUnit = 'centimeters';
      suggestedScale = (TARGET_WIDTH_M * 100) / likelyWidth;
    } else if (likelyWidth >= 50 && likelyWidth < 500) {
      likelyUnit = 'millimeters';
      suggestedScale = (TARGET_WIDTH_M * 1000) / likelyWidth;
    } else if (likelyWidth >= 0.5) {
      likelyUnit = 'meters (oversized, character scale)';
      suggestedScale = TARGET_WIDTH_M / likelyWidth;
    }

    console.log('\n=== CALIBRATION RECOMMENDATIONS ===');
    console.log(`  Likely unit:      ${likelyUnit}`);
    console.log(`  Suggested scale:  ${suggestedScale.toFixed(6)}`);
    console.log(`  Center offset X:  ${(-center.x).toFixed(6)}`);
    console.log(`  Center offset Y:  ${(-center.y).toFixed(6)}`);
    console.log(`  Center offset Z:  ${(-center.z).toFixed(6)}`);
    console.log(`\n  Suggested JSON:`);
    console.log(JSON.stringify({
      frameId: 'cyberpunk_glasses',
      frameWidth: 125,
      bridgeWidth: 18,
      lensWidth: 48,
      offsetX: parseFloat((-center.x * suggestedScale * 1000).toFixed(2)),
      offsetY: parseFloat((-center.y * suggestedScale * 1000).toFixed(2)),
      offsetZ: parseFloat((-center.z * suggestedScale * 1000 + 10).toFixed(2)),
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      defaultScale: parseFloat(suggestedScale.toFixed(6)),
    }, null, 2));
  },
  (error) => {
    console.error('Failed to parse GLB:', error);
    process.exit(1);
  }
);
