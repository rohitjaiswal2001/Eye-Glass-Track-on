// scripts/generate-sample-frames.ts
//
// Generates real, loadable placeholder GLB eyewear models with realistic
// details: proper lens/rim outline shapes (THREE.Shape + ExtrudeGeometry),
// clear lenses (matching real prescription-eyewear product photography,
// not tinted sunglasses), nose pads, hinges, and curved temple tips. Run:
//   npx tsx scripts/generate-sample-frames.ts
//
// Three.js's GLTFExporter works headlessly here — it serializes geometry
// and material data, no WebGL/GPU context required.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../public/models');

// GLTFExporter's binary (.glb) path uses the browser's FileReader to convert
// its internal Blob to an ArrayBuffer. Node has no FileReader, but does have
// a global Blob with `.arrayBuffer()` — this minimal shim bridges the two so
// the exporter can run headlessly here, no browser/DOM required.
if (typeof (globalThis as unknown as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReaderShim {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          this.onloadend?.();
        })
        .catch((err) => {
          this.onerror?.(err);
        });
    }
  }
  (globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReaderShim;
}

// ===========================================================================
// Lens outline shapes
// ===========================================================================

function makeCircleShape(diameter: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, diameter / 2, 0, Math.PI * 2, false);
  return shape;
}

function makeRoundedRectShape(width: number, height: number, cornerRadiusFraction: number): THREE.Shape {
  const w = width / 2;
  const h = height / 2;
  const r = Math.max(0.0001, Math.min(width * cornerRadiusFraction, w, h));
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  return shape;
}

function makeAviatorShape(width: number, height: number): THREE.Shape {
  const w = width / 2;
  const h = height / 2;
  const points = [
    new THREE.Vector2(0, 0.92 * h),
    new THREE.Vector2(0.72 * w, 0.68 * h),
    new THREE.Vector2(1.0 * w, 0.14 * h),
    new THREE.Vector2(0.82 * w, -0.56 * h),
    new THREE.Vector2(0.38 * w, -1.0 * h),
    new THREE.Vector2(0, -1.06 * h),
    new THREE.Vector2(-0.38 * w, -1.0 * h),
    new THREE.Vector2(-0.82 * w, -0.56 * h),
    new THREE.Vector2(-1.0 * w, 0.14 * h),
    new THREE.Vector2(-0.72 * w, 0.68 * h),
  ];
  const shape = new THREE.Shape();
  shape.moveTo(points[0].x, points[0].y);
  shape.splineThru(points.slice(1));
  shape.closePath();
  return shape;
}

function makeCatEyeShape(width: number, height: number): THREE.Shape {
  const w = width / 2;
  const h = height / 2;
  const points = [
    new THREE.Vector2(-0.15 * w, 0.85 * h),
    new THREE.Vector2(0.95 * w, 1.15 * h),
    new THREE.Vector2(1.0 * w, 0.35 * h),
    new THREE.Vector2(0.85 * w, -0.65 * h),
    new THREE.Vector2(0.35 * w, -1.0 * h),
    new THREE.Vector2(0, -1.05 * h),
    new THREE.Vector2(-0.5 * w, -0.9 * h),
    new THREE.Vector2(-0.85 * w, -0.35 * h),
    new THREE.Vector2(-0.9 * w, 0.35 * h),
    new THREE.Vector2(-0.55 * w, 0.75 * h),
  ];
  const shape = new THREE.Shape();
  shape.moveTo(points[0].x, points[0].y);
  shape.splineThru(points.slice(1));
  shape.closePath();
  return shape;
}

type LensShapeKind = 'round' | 'rounded-rect' | 'aviator' | 'cat-eye';

function makeOutlineShape(kind: LensShapeKind, width: number, height: number, cornerRadiusFraction: number): THREE.Shape {
  switch (kind) {
    case 'round':
      return makeCircleShape(width);
    case 'rounded-rect':
      return makeRoundedRectShape(width, height, cornerRadiusFraction);
    case 'aviator':
      return makeAviatorShape(width, height);
    case 'cat-eye':
      return makeCatEyeShape(width, height);
  }
}

// ===========================================================================
// Frame spec + geometry builder
// ===========================================================================

type FrameMaterialKind = 'metal' | 'acetate-translucent';

interface FrameSpec {
  frameId: string;
  displayName: string;

  lensShape: LensShapeKind;
  cornerRadiusFraction: number;
  lensWidthM: number;
  lensHeightM: number;
  rimWidthM: number;
  rimDepthM: number;
  lensDepthM: number;

  bridgeGapM: number;
  templeLengthM: number;
  templeThicknessM: number;
  browBar: boolean;
  /** Optional override so the brow bar reads as a contrasting color (e.g. black brow on a silver frame). */
  browBarColor?: number;

  materialKind: FrameMaterialKind;
  frameColor: number;

  /** Real eyewear lenses are clear, not tinted — a low, realistic opacity (see file header). */
  lensOpacity: number;

  calibration: {
    frameWidth: number;
    bridgeWidth: number;
    lensWidth: number;
    offsetX: number;
    offsetY: number;
    offsetZ: number;
    rotationX: number;
    rotationY: number;
    rotationZ: number;
    defaultScale: number;
  };
}

const NOSE_PAD_COLOR = 0xe0ded9; // clear/frosted silicone
const HINGE_COLOR = 0xb8b8ba; // silver metal, realistic regardless of frame material

const FRAME_SPECS: FrameSpec[] = [
  {
    frameId: 'frame001',
    displayName: 'Round Wire — Gunmetal',
    lensShape: 'round',
    cornerRadiusFraction: 0,
    lensWidthM: 0.050,
    lensHeightM: 0.050,
    rimWidthM: 0.0022, // thin wire — real metal frames like this are only ~1.5-2.5mm
    rimDepthM: 0.0035,
    lensDepthM: 0.0018,
    bridgeGapM: 0.020,
    templeLengthM: 0.135,
    templeThicknessM: 0.0022,
    browBar: false,
    materialKind: 'metal',
    frameColor: 0x53565a, // gunmetal
    lensOpacity: 0.10,
    calibration: {
      frameWidth: 132, bridgeWidth: 20, lensWidth: 50,
      offsetX: 0, offsetY: 0, offsetZ: 2,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      defaultScale: 1.0,
    },
  },
  {
    frameId: 'frame002',
    displayName: 'Clear Round-Square — Smoke Grey',
    lensShape: 'rounded-rect',
    cornerRadiusFraction: 0.34,
    lensWidthM: 0.052,
    lensHeightM: 0.046,
    rimWidthM: 0.0055,
    rimDepthM: 0.0085,
    lensDepthM: 0.002,
    bridgeGapM: 0.020,
    templeLengthM: 0.14,
    templeThicknessM: 0.0055,
    browBar: false,
    materialKind: 'acetate-translucent',
    frameColor: 0x8c8579, // translucent smoke grey/taupe
    lensOpacity: 0.09,
    calibration: {
      frameWidth: 140, bridgeWidth: 20, lensWidth: 52,
      offsetX: 0, offsetY: 0, offsetZ: 3,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      defaultScale: 1.0,
    },
  },
  {
    frameId: 'frame003',
    displayName: 'Rectangle — Deep Blue',
    lensShape: 'rounded-rect',
    cornerRadiusFraction: 0.10,
    lensWidthM: 0.056,
    lensHeightM: 0.034,
    rimWidthM: 0.0055,
    rimDepthM: 0.008,
    lensDepthM: 0.002,
    bridgeGapM: 0.019,
    templeLengthM: 0.14,
    templeThicknessM: 0.0055,
    browBar: false,
    materialKind: 'acetate-translucent',
    frameColor: 0x16307a, // deep translucent blue
    lensOpacity: 0.09,
    calibration: {
      frameWidth: 143, bridgeWidth: 19, lensWidth: 56,
      offsetX: 0, offsetY: 0, offsetZ: 3,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      defaultScale: 1.0,
    },
  },
  {
    frameId: 'frame004',
    displayName: 'Geometric Aviator — Silver / Black',
    lensShape: 'aviator',
    cornerRadiusFraction: 0,
    lensWidthM: 0.054,
    lensHeightM: 0.050,
    rimWidthM: 0.0028,
    rimDepthM: 0.004,
    lensDepthM: 0.0015,
    bridgeGapM: 0.017,
    templeLengthM: 0.135,
    templeThicknessM: 0.0028,
    browBar: true,
    browBarColor: 0x1a1a1a, // contrasting black brow — two-tone combination-frame look
    materialKind: 'metal',
    frameColor: 0xc4c6c8, // bright silver
    lensOpacity: 0.10,
    calibration: {
      frameWidth: 136, bridgeWidth: 17, lensWidth: 54,
      offsetX: 0, offsetY: 0, offsetZ: 2.5,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      defaultScale: 1.0,
    },
  },
  {
    frameId: 'frame005',
    displayName: 'Retro Cat-Eye — Rose Gold',
    lensShape: 'cat-eye',
    cornerRadiusFraction: 0,
    lensWidthM: 0.054,
    lensHeightM: 0.044,
    rimWidthM: 0.0032,
    rimDepthM: 0.0045,
    lensDepthM: 0.002,
    bridgeGapM: 0.018,
    templeLengthM: 0.135,
    templeThicknessM: 0.0032,
    browBar: false,
    materialKind: 'metal',
    frameColor: 0xc98a94, // rose gold
    lensOpacity: 0.10,
    calibration: {
      frameWidth: 136, bridgeWidth: 18, lensWidth: 54,
      offsetX: 0, offsetY: 1, offsetZ: 3,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      defaultScale: 1.0,
    },
  },
  {
    frameId: 'frame006',
    displayName: 'Bold Square — Deep Red',
    lensShape: 'rounded-rect',
    cornerRadiusFraction: 0.20,
    lensWidthM: 0.056,
    lensHeightM: 0.042,
    rimWidthM: 0.008,
    rimDepthM: 0.010,
    lensDepthM: 0.002,
    bridgeGapM: 0.020,
    templeLengthM: 0.14,
    templeThicknessM: 0.007,
    browBar: false,
    materialKind: 'acetate-translucent',
    frameColor: 0x7a0f1c, // deep translucent red
    lensOpacity: 0.10,
    calibration: {
      frameWidth: 146, bridgeWidth: 20, lensWidth: 56,
      offsetX: 0, offsetY: 0, offsetZ: 3,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      defaultScale: 1.0,
    },
  },
];

function makeFrameMaterial(spec: FrameSpec, colorOverride?: number): THREE.MeshStandardMaterial {
  const color = colorOverride ?? spec.frameColor;
  if (spec.materialKind === 'metal') {
    return new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.22 });
  }
  // Translucent acetate: real colored acetate frames let some light through
  // and have a glossy plastic finish — approximated with moderate opacity
  // and low roughness rather than full `transmission` (simpler and more
  // robust to render correctly layered over the clear lens beneath it).
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0,
    roughness: 0.18,
    transparent: true,
    opacity: 0.88,
  });
}

function buildRimMesh(spec: FrameSpec, material: THREE.Material): THREE.Mesh {
  const outer = makeOutlineShape(spec.lensShape, spec.lensWidthM, spec.lensHeightM, spec.cornerRadiusFraction);
  const innerForHole = makeOutlineShape(
    spec.lensShape,
    spec.lensWidthM - 2 * spec.rimWidthM,
    spec.lensHeightM - 2 * spec.rimWidthM,
    spec.cornerRadiusFraction,
  );
  outer.holes.push(innerForHole);

  const geometry = new THREE.ExtrudeGeometry(outer, {
    depth: spec.rimDepthM,
    bevelEnabled: true,
    bevelThickness: spec.rimDepthM * 0.15,
    bevelSize: spec.rimWidthM * 0.15,
    bevelSegments: 2,
    curveSegments: 32,
  });
  geometry.translate(0, 0, -spec.rimDepthM / 2);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function buildLensMesh(spec: FrameSpec, material: THREE.Material): THREE.Mesh {
  const lensShape = makeOutlineShape(
    spec.lensShape,
    spec.lensWidthM - 2 * spec.rimWidthM,
    spec.lensHeightM - 2 * spec.rimWidthM,
    spec.cornerRadiusFraction,
  );
  const geometry = new THREE.ExtrudeGeometry(lensShape, {
    depth: spec.lensDepthM,
    bevelEnabled: false,
    curveSegments: 32,
  });
  geometry.translate(0, 0, -spec.lensDepthM / 2);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/** A small silicone-style nose pad — real glasses (especially metal/thin-rim ones) almost always have these. */
function buildNosePad(): THREE.Mesh {
  const geometry = new THREE.CapsuleGeometry(0.0016, 0.0055, 4, 8);
  const material = new THREE.MeshStandardMaterial({
    color: NOSE_PAD_COLOR,
    metalness: 0,
    roughness: 0.4,
    transparent: true,
    opacity: 0.85,
  });
  return new THREE.Mesh(geometry, material);
}

/** A small hinge block where the rim meets the temple — visible on essentially all real eyewear. */
function buildHinge(rimDepthM: number): THREE.Mesh {
  const size = Math.max(0.004, rimDepthM * 1.4);
  const geometry = new THREE.BoxGeometry(size * 0.5, size * 0.7, size);
  const material = new THREE.MeshStandardMaterial({ color: HINGE_COLOR, metalness: 0.75, roughness: 0.3 });
  return new THREE.Mesh(geometry, material);
}

/**
 * Builds a temple arm as two segments (a straight main run + a tip angled
 * downward) rather than one straight box — real temples curve to follow
 * behind the ear, and a single straight box reads as visibly artificial.
 *
 * IMPORTANT: temples extend in the -Z direction (backward, away from the
 * camera, towards the ears) — NOT +Z (forward). The hinge sits at the rim's
 * outer edge; from there the arm runs backward and the tip curves downward
 * to hook behind the ear.
 */
function buildTempleArm(spec: FrameSpec, material: THREE.Material, side: 1 | -1): THREE.Group {
  const group = new THREE.Group();
  const bendAngle = 0.28; // radians (~16°) downward tilt at the ear-hook tip
  const mainLength = spec.templeLengthM * 0.72;
  const tipLength = spec.templeLengthM * 0.28;

  // Main straight shaft runs backward (negative Z)
  const mainGeometry = new THREE.BoxGeometry(spec.templeThicknessM, spec.templeThicknessM, mainLength);
  const main = new THREE.Mesh(mainGeometry, material);
  // Center of the main shaft is half its length BEHIND the hinge (-Z)
  main.position.set(0, 0, -(mainLength / 2));
  group.add(main);

  // Tip curves downward at the end of the main shaft (the ear-hook)
  const tipGeometry = new THREE.BoxGeometry(spec.templeThicknessM * 0.8, spec.templeThicknessM * 0.8, tipLength);
  const tip = new THREE.Mesh(tipGeometry, material);
  // Tip starts at the back end of the main shaft and curves further back & downward
  const tipCenterZ = -(mainLength + (tipLength / 2) * Math.cos(bendAngle));
  const tipCenterY = -((tipLength / 2) * Math.sin(bendAngle));
  tip.position.set(0, tipCenterY, tipCenterZ);
  tip.rotation.x = -bendAngle; // angle rotates downward in -Z direction
  group.add(tip);

  group.name = side === 1 ? 'RightTemple' : 'LeftTemple';
  return group;
}

function buildFrameGroup(spec: FrameSpec): THREE.Group {
  const group = new THREE.Group();
  group.name = 'GlassesFrame';

  const frameMaterial = makeFrameMaterial(spec);
  const lensMaterial = new THREE.MeshStandardMaterial({
    color: 0xeaf2f7, // barely-there cool tint, like real anti-reflective coated lenses
    metalness: 0.05,
    roughness: 0.08,
    transparent: true,
    opacity: spec.lensOpacity,
    side: THREE.DoubleSide,
  });

  const halfSpan = spec.lensWidthM / 2 + spec.bridgeGapM / 2;

  // --- Left/right rim + lens pairs (left mirrored via scale.x=-1 so
  // asymmetric shapes like cat-eye flip correctly — see prior fix) ---
  const leftRim = buildRimMesh(spec, frameMaterial);
  leftRim.name = 'LeftRim';
  leftRim.scale.x = -1;
  leftRim.position.set(-halfSpan, 0, 0);
  group.add(leftRim);

  const leftLens = buildLensMesh(spec, lensMaterial);
  leftLens.name = 'LeftLens';
  leftLens.scale.x = -1;
  leftLens.position.set(-halfSpan, 0, 0);
  group.add(leftLens);

  const rightRim = buildRimMesh(spec, frameMaterial);
  rightRim.name = 'RightRim';
  rightRim.position.set(halfSpan, 0, 0);
  group.add(rightRim);

  const rightLens = buildLensMesh(spec, lensMaterial);
  rightLens.name = 'RightLens';
  rightLens.position.set(halfSpan, 0, 0);
  group.add(rightLens);

  // --- Bridge ---
  const bridgeGeometry = new THREE.BoxGeometry(spec.bridgeGapM, spec.rimWidthM * 1.3, spec.rimDepthM * 0.8);
  const bridge = new THREE.Mesh(bridgeGeometry, frameMaterial);
  bridge.name = 'Bridge';
  bridge.position.set(0, spec.lensHeightM * 0.12, 0);
  group.add(bridge);

  // --- Nose pads (behind the lens plane, below the bridge, near the nose) ---
  const nosePadX = spec.bridgeGapM * 0.42;
  const nosePadY = -spec.lensHeightM * 0.16;
  const nosePadZ = -spec.rimDepthM * 1.6;
  const leftNosePad = buildNosePad();
  leftNosePad.name = 'LeftNosePad';
  leftNosePad.position.set(-nosePadX, nosePadY, nosePadZ);
  group.add(leftNosePad);

  const rightNosePad = buildNosePad();
  rightNosePad.name = 'RightNosePad';
  rightNosePad.position.set(nosePadX, nosePadY, nosePadZ);
  group.add(rightNosePad);

  // --- Optional aviator-style brow bar (with optional contrasting color) ---
  if (spec.browBar) {
    const browBarMaterial = spec.browBarColor !== undefined ? makeFrameMaterial(spec, spec.browBarColor) : frameMaterial;
    const browBarRadius = spec.rimWidthM * 0.85;
    const browBarSpan = 2 * halfSpan + spec.lensWidthM * 0.3;
    const browBarGeometry = new THREE.CylinderGeometry(browBarRadius, browBarRadius, browBarSpan, 12);
    const browBar = new THREE.Mesh(browBarGeometry, browBarMaterial);
    browBar.name = 'BrowBar';
    browBar.rotation.z = Math.PI / 2;
    browBar.position.set(0, spec.lensHeightM * 0.44, 0);
    group.add(browBar);
  }

  // --- Hinges (rim/temple junction) ---
  const templeStartX = spec.lensWidthM + spec.bridgeGapM / 2;
  const leftHinge = buildHinge(spec.rimDepthM);
  leftHinge.name = 'LeftHinge';
  leftHinge.position.set(-templeStartX, 0, 0);
  group.add(leftHinge);

  const rightHinge = buildHinge(spec.rimDepthM);
  rightHinge.name = 'RightHinge';
  rightHinge.position.set(templeStartX, 0, 0);
  group.add(rightHinge);

  // --- Temple arms (two-segment, curved tip) ---
  const leftTemple = buildTempleArm(spec, frameMaterial, -1);
  leftTemple.position.set(-templeStartX, 0, 0);
  group.add(leftTemple);

  const rightTemple = buildTempleArm(spec, frameMaterial, 1);
  rightTemple.position.set(templeStartX, 0, 0);
  group.add(rightTemple);

  return group;
}

function exportGlb(group: THREE.Group, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) {
          fs.writeFileSync(outputPath, Buffer.from(result));
          resolve();
        } else {
          reject(new Error('Expected binary ArrayBuffer output from GLTFExporter (binary: true).'));
        }
      },
      (error) => reject(error),
      { binary: true },
    );
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const manifestEntries: Array<{
    frameId: string;
    glbUrl: string;
    jsonUrl: string;
    displayName: string;
  }> = [];

  for (const spec of FRAME_SPECS) {
    const group = buildFrameGroup(spec);
    const glbPath = path.join(OUTPUT_DIR, `${spec.frameId}.glb`);
    const jsonPath = path.join(OUTPUT_DIR, `${spec.frameId}.json`);

    await exportGlb(group, glbPath);

    const calibrationJson = { frameId: spec.frameId, ...spec.calibration };
    fs.writeFileSync(jsonPath, JSON.stringify(calibrationJson, null, 2));

    manifestEntries.push({
      frameId: spec.frameId,
      glbUrl: `/models/${spec.frameId}.glb`,
      jsonUrl: `/models/${spec.frameId}.json`,
      displayName: spec.displayName,
    });

    console.log(`Generated ${spec.frameId}.glb + ${spec.frameId}.json (${spec.displayName})`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifestEntries, null, 2));
  console.log(`Generated manifest.json with ${manifestEntries.length} entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
