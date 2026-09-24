import * as THREE from 'three';

/**
 * A loaded eyewear model, normalised for fitting.
 *
 * "Fit space" (after `root.matrix`): +X = wearer's left, +Y = up, +Z = forward (away from
 * the face), origin = centre of the frame front at the back surface of the rims.
 * Units stay the model's own units; `units` tells how they map to real centimetres.
 */

export interface TryOnUniforms {
  [name: string]: THREE.IUniform;
  uTryonBendOn: THREE.IUniform<number>;
  uTryonNorm: THREE.IUniform<THREE.Matrix4>;
  uTryonNormInv: THREE.IUniform<THREE.Matrix4>;
  uTryonHingeZ: THREE.IUniform<number>;
  /** x: wearer's-left temple (+X), y: right temple (−X). */
  uTryonEarZ: THREE.IUniform<THREE.Vector2>;
  uTryonDX: THREE.IUniform<THREE.Vector2>;
  uTryonDY: THREE.IUniform<THREE.Vector2>;
  /** Temple length scale (distance behind the hinge) so the modelled ear bend lands on the ear. */
  uTryonZScale: THREE.IUniform<THREE.Vector2>;
  /** Temple is hidden beyond this distance behind the ear rest point (it is behind the ear). */
  uTryonCut: THREE.IUniform<number>;
  /** (|x| where temple weighting starts, |x| where it is full, hinge ramp length). */
  uTryonLat: THREE.IUniform<THREE.Vector3>;
  uTryonHairOn: THREE.IUniform<number>;
  uTryonHair: THREE.IUniform<THREE.Texture | null>;
  /** Drawing-buffer → full video frame mapping: (offsetX, offsetY from bottom, fullW, fullH). */
  uTryonView: THREE.IUniform<THREE.Vector4>;
}

export interface TempleProfile {
  slices: number;
  /** Per side [left(+X), right(−X)]: inner |x| (touches the head), lowest/highest y, sample count. */
  inner: [Float32Array, Float32Array];
  minY: [Float32Array, Float32Array];
  maxY: [Float32Array, Float32Array];
  count: [Uint32Array, Uint32Array];
}

export interface FrameAnalysis {
  /** Total frame width (front), model units. */
  frontWidth: number;
  frontHeight: number;
  depth: number;
  hasTemples: boolean;
  /** z where the temples start (fit space). */
  hingeZ: number;
  /** Rear-most z (temple tips). */
  minZ: number;
  maxZ: number;
  /** Lowest point of the bridge and its rear surface (fit space). */
  bridgeBottomY: number;
  bridgeBackZ: number;
  temple: TempleProfile;
  /** Fit-space z where the modelled ear bend starts (tip curls down from here), null if straight. */
  earBendZ: number | null;
}

/** Author / license info from the glTF `asset` block (e.g. Sketchfab downloads). */
export interface ModelCredit {
  title?: string;
  author?: string;
  license?: string;
  source?: string;
}

export interface UnitGuess {
  label: 'm' | 'cm' | 'mm' | 'in';
  toCm: number;
}

const VERT_PARS = /* glsl */ `
uniform float uTryonBendOn;
uniform mat4 uTryonNorm;
uniform mat4 uTryonNormInv;
uniform float uTryonHingeZ;
uniform vec2 uTryonEarZ;
uniform vec2 uTryonDX;
uniform vec2 uTryonDY;
uniform vec2 uTryonZScale;
uniform vec3 uTryonLat;
varying float vTryonTemple;
varying float vTryonBehind;
`;

// Swings the temples (everything lateral and behind the hinge) at the hinge so they meet the
// ears, keeping them straight like a real rigid arm: the temple is lengthened/shortened so its
// modelled ear bend lands just behind the ear root, then an offset that grows linearly from 0
// at the hinge to full at the ear spreads/drops it onto the ear. vTryonBehind = distance
// behind the ear rest point.
const VERT_MAIN = /* glsl */ `
vTryonBehind = -1.0;
{
  vec3 tryonP = (uTryonNorm * vec4(transformed, 1.0)).xyz;
  float tryonLat = smoothstep(uTryonLat.x, uTryonLat.y, abs(tryonP.x));
  vTryonTemple = tryonLat * clamp((uTryonHingeZ - tryonP.z) / uTryonLat.z, 0.0, 1.0);
  if (uTryonBendOn > 0.5) {
    float tryonSide = step(0.0, tryonP.x);
    float tryonScaleZ = mix(uTryonZScale.y, uTryonZScale.x, tryonSide);
    tryonP.z -= max(uTryonHingeZ - tryonP.z, 0.0) * (tryonScaleZ - 1.0) * tryonLat;
    float tryonEar = mix(uTryonEarZ.y, uTryonEarZ.x, tryonSide);
    float tryonT = clamp((uTryonHingeZ - tryonP.z) / max(uTryonHingeZ - tryonEar, 1e-5), 0.0, 1.0);
    float tryonW = tryonT * tryonLat;
    tryonP.x += sign(tryonP.x) * mix(uTryonDX.y, uTryonDX.x, tryonSide) * tryonW;
    tryonP.y += mix(uTryonDY.y, uTryonDY.x, tryonSide) * tryonW;
    vTryonBehind = tryonEar - tryonP.z;
    transformed = (uTryonNormInv * vec4(tryonP, 1.0)).xyz;
  }
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uTryonCut;
uniform float uTryonHairOn;
uniform sampler2D uTryonHair;
uniform vec4 uTryonView;
varying float vTryonTemple;
varying float vTryonBehind;
`;

// The temple ends where it goes behind the ear (the ear/head hide the rest in reality); optional
// hair mask hides temple pixels that are covered by hair.
const FRAG_MAIN = /* glsl */ `
if (vTryonTemple > 0.5 && vTryonBehind > uTryonCut) discard;
if (uTryonHairOn > 0.5 && vTryonTemple > 0.02) {
  vec2 tryonUv = (gl_FragCoord.xy + uTryonView.xy) / uTryonView.zw;
  float tryonHair = texture2D(uTryonHair, vec2(tryonUv.x, 1.0 - tryonUv.y)).r;
  if (tryonHair * vTryonTemple > 0.45) discard;
}
`;

const PROGRAM_KEY = 'tryon-glasses-v6';

function createUniforms(): TryOnUniforms {
  return {
    uTryonBendOn: { value: 0 },
    uTryonNorm: { value: new THREE.Matrix4() },
    uTryonNormInv: { value: new THREE.Matrix4() },
    uTryonHingeZ: { value: 0 },
    uTryonEarZ: { value: new THREE.Vector2(-1, -1) },
    uTryonDX: { value: new THREE.Vector2() },
    uTryonDY: { value: new THREE.Vector2() },
    uTryonZScale: { value: new THREE.Vector2(1, 1) },
    uTryonCut: { value: 1e6 },
    uTryonLat: { value: new THREE.Vector3(0.5, 0.7, 0.01) },
    uTryonHairOn: { value: 0 },
    uTryonHair: { value: null },
    uTryonView: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
}

function patchMaterial(material: THREE.Material, uniforms: TryOnUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_MAIN}`);
  };
  material.customProgramCacheKey = () => PROGRAM_KEY;
  material.needsUpdate = true;
}

const LENS_NAME = /lens|glass(?!es)|verre|lente|linse|vidrio|cristal/i;
const IGNORE_NAME = /\b(floor|ground|shadow_?plane|shadow_?catcher|backdrop|background)\b/i;

interface LensState {
  transmission: number;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

/**
 * Real lenses have anti-reflective coatings; studio-lit glTF lenses reflect the synthetic
 * environment far too strongly in AR (milky lenses). Tone reflections down once per lens.
 */
const LENS_REFLECTION_SCALE = 0.4;

const METAL_NAME = /(chrom|hrom|metal|steel|gold|silver|titan|brass|alumin)/i;

/**
 * Exports from Sketchfab/FBX often lose metalness: parts named "chrome"/"metal" arrive as
 * matte plastic. Give such parts back a metallic finish (only when metalness is exactly 0).
 */
function restoreMetal(m: THREE.Material): void {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial || std.metalness !== 0 || std.metalnessMap || !METAL_NAME.test(m.name)) return;
  std.metalness = 0.9;
  std.roughness = Math.min(std.roughness, 0.35);
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function isLensMaterial(mesh: THREE.Mesh, m: THREE.Material): boolean {
  const phys = m as THREE.MeshPhysicalMaterial;
  return (
    LENS_NAME.test(`${mesh.name} ${m.name}`) ||
    (m.transparent && m.opacity < 0.98) ||
    (phys.isMeshPhysicalMaterial === true && phys.transmission > 0)
  );
}

function flipWinding(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geo.index) {
    const count = geo.attributes.position.count;
    const idx = new (count > 65535 ? Uint32Array : Uint16Array)(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const index = geo.index!;
  for (let i = 0; i + 2 < index.count; i += 3) {
    const b = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, b);
  }
  index.needsUpdate = true;
  return geo;
}

/** Copies every mesh with its world transform baked into the geometry. */
function bakeMeshes(source: THREE.Object3D): THREE.Mesh[] {
  source.updateMatrixWorld(true);
  const out: THREE.Mesh[] = [];
  const m = new THREE.Matrix4();
  const push = (mesh: THREE.Mesh, world: THREE.Matrix4) => {
    const geo = mesh.geometry.clone();
    geo.morphAttributes = {}; // morph targets would not survive the bake
    geo.applyMatrix4(world);
    if (world.determinant() < 0) flipWinding(geo);
    const baked = new THREE.Mesh(geo, mesh.material);
    baked.name = mesh.name;
    baked.renderOrder = mesh.renderOrder;
    baked.visible = mesh.visible && !IGNORE_NAME.test(mesh.name);
    out.push(baked);
  };
  source.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < Math.min(inst.count, 64); i++) {
        inst.getMatrixAt(i, m);
        push(mesh, m.premultiply(inst.matrixWorld));
      }
    } else {
      push(mesh, mesh.matrixWorld);
    }
  });
  return out;
}

function collectSamples(meshes: THREE.Mesh[], maxPoints = 60000): Float32Array {
  let total = 0;
  for (const mesh of meshes) if (mesh.visible) total += mesh.geometry.attributes.position.count;
  const stride = Math.max(1, Math.ceil(total / maxPoints));
  const out = new Float32Array(Math.ceil(total / stride) * 3 + 3);
  let n = 0;
  let k = 0;
  for (const mesh of meshes) {
    if (!mesh.visible) continue;
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++, k++) {
      if (k % stride !== 0) continue;
      out[n++] = pos.getX(i);
      out[n++] = pos.getY(i);
      out[n++] = pos.getZ(i);
    }
  }
  return out.subarray(0, n);
}

interface Range {
  min: number;
  max: number;
}

function percentileRange(values: Float32Array, trim: number): Range {
  if (values.length === 0) return { min: 0, max: 0 };
  const s = Float32Array.from(values).sort();
  const lo = Math.floor(trim * (s.length - 1));
  const hi = Math.ceil((1 - trim) * (s.length - 1));
  return { min: s[lo], max: s[hi] };
}

function axisValues(pts: Float32Array, axis: number): Float32Array {
  const n = pts.length / 3;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pts[i * 3 + axis];
  return out;
}

/** 0 = perfectly mirror-symmetric distribution along `axis`, larger = lopsided. */
function asymmetry(pts: Float32Array, axis: number, r: Range): number {
  const B = 32;
  const h = new Float64Array(B);
  const ext = r.max - r.min || 1;
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((pts[i * 3 + axis] - r.min) / ext) * B);
    if (b >= 0 && b < B) h[b]++;
  }
  let d = 0;
  let tot = 0;
  for (let i = 0; i < B; i++) tot += h[i];
  for (let i = 0; i < B / 2; i++) d += Math.abs(h[i] - h[B - 1 - i]);
  return d / Math.max(tot, 1);
}

/**
 * Finds which model axis is width / height / depth and which way is front and up.
 * Width: the most mirror-symmetric long axis. Front: the end that has geometry near the
 * centre plane (bridge) — temple tips never do. Up: temples leave the frame above its centre
 * and their tips curl downward.
 */
export function detectOrientation(pts: Float32Array): THREE.Matrix4 {
  const n = pts.length / 3;
  const ranges = [0, 1, 2].map((a) => percentileRange(axisValues(pts, a), 0.002));
  const ext = ranges.map((r) => r.max - r.min);
  const order = [0, 1, 2].sort((a, b) => ext[b] - ext[a]);
  const hasTemples = ext[order[1]] > 0.55 * ext[order[0]];

  let lat: number;
  let dep: number;
  let up: number;
  if (hasTemples) {
    const s0 = asymmetry(pts, order[0], ranges[order[0]]);
    const s1 = asymmetry(pts, order[1], ranges[order[1]]);
    [lat, dep] = s0 <= s1 ? [order[0], order[1]] : [order[1], order[0]];
    up = order[2];
  } else {
    [lat, up, dep] = order;
  }

  let frontSign = 1;
  let upSign = 1;
  if (hasTemples) {
    const cLat = (ranges[lat].min + ranges[lat].max) / 2;
    const halfLat = ext[lat] / 2;
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(pts[i * 3 + lat] - cLat) > 0.2 * halfLat) continue;
      const t = (pts[i * 3 + dep] - ranges[dep].min) / (ext[dep] || 1);
      if (t > 0.75) hi++;
      else if (t < 0.25) lo++;
    }
    frontSign = hi >= lo ? 1 : -1;

    let fMin = Infinity;
    let fMax = -Infinity;
    let midSum = 0;
    let midN = 0;
    let tipSum = 0;
    let tipN = 0;
    for (let i = 0; i < n; i++) {
      const d = pts[i * 3 + dep];
      const s = frontSign > 0 ? (ranges[dep].max - d) / (ext[dep] || 1) : (d - ranges[dep].min) / (ext[dep] || 1);
      const h = pts[i * 3 + up];
      if (s < 0.12) {
        fMin = Math.min(fMin, h);
        fMax = Math.max(fMax, h);
      } else if (s > 0.3 && s < 0.6) {
        midSum += h;
        midN++;
      } else if (s > 0.88) {
        tipSum += h;
        tipN++;
      }
    }
    if (midN > 0 && fMax >= fMin) {
      const mid = midSum / midN;
      let score = mid - (fMin + fMax) / 2;
      if (tipN > 0) score += mid - tipSum / tipN;
      upSign = score >= 0 ? 1 : -1;
    }
  }

  const axis = (a: number, s: number) => new THREE.Vector3().setComponent(a, s);
  const X = axis(lat, 1);
  const Y = axis(up, upSign);
  const Z = axis(dep, frontSign);
  if (X.clone().cross(Y).dot(Z) < 0) X.negate();
  return new THREE.Matrix4().set(X.x, X.y, X.z, 0, Y.x, Y.y, Y.z, 0, Z.x, Z.y, Z.z, 0, 0, 0, 0, 1);
}

const TEMPLE_SLICES = 40;

/** Measures the frame in fit orientation. Returns the analysis and the fit-space origin. */
export function analyzeFrame(raw: Float32Array, rotation: THREE.Matrix4): { analysis: FrameAnalysis; origin: THREE.Vector3 } {
  const n = raw.length / 3;
  const e = rotation.elements;
  const pts = new Float32Array(raw.length);
  for (let i = 0; i < n; i++) {
    const x = raw[i * 3];
    const y = raw[i * 3 + 1];
    const z = raw[i * 3 + 2];
    pts[i * 3] = e[0] * x + e[4] * y + e[8] * z;
    pts[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z;
    pts[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z;
  }
  const rx = percentileRange(axisValues(pts, 0), 0.002);
  const rz = percentileRange(axisValues(pts, 2), 0.002);
  const width = rx.max - rx.min || 1;
  const depth = rz.max - rz.min;
  const frontDepth = Math.max(Math.min(depth, 0.18 * width), 1e-6);
  const zFront = rz.max - frontDepth;

  // Frame front: extents of the slab closest to the viewer.
  const fx: number[] = [];
  const fy: number[] = [];
  for (let i = 0; i < n; i++) {
    if (pts[i * 3 + 2] >= zFront) {
      fx.push(pts[i * 3]);
      fy.push(pts[i * 3 + 1]);
    }
  }
  const frx = percentileRange(Float32Array.from(fx), 0.0005);
  const fry = percentileRange(Float32Array.from(fy), 0.001);
  const cx = (frx.min + frx.max) / 2;
  const halfW = Math.max((frx.max - frx.min) / 2, 1e-6);
  const cy = (fry.min + fry.max) / 2;
  const frontH = Math.max(fry.max - fry.min, 1e-6);

  // Back surface of the rims (ignoring the bridge / nose pads in the middle and hinges at the ends).
  const rimZ: number[] = [];
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(pts[i * 3] - cx) / halfW;
    if (pts[i * 3 + 2] >= zFront && ax > 0.3 && ax < 0.85) rimZ.push(pts[i * 3 + 2]);
  }
  const backPlane = rimZ.length > 10 ? percentileRange(Float32Array.from(rimZ), 0.1).min : zFront;

  // Bridge: geometry on the centre plane.
  let bMinY = Infinity;
  let bBackZ = Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const z = pts[i * 3 + 2];
    if (z >= zFront && Math.abs(x - cx) < 0.035 * 2 * halfW && y > cy - 0.1 * frontH) {
      bMinY = Math.min(bMinY, y);
      bBackZ = Math.min(bBackZ, z);
    }
  }
  if (!Number.isFinite(bMinY)) {
    bMinY = cy + 0.1 * frontH;
    bBackZ = backPlane;
  }

  const origin = new THREE.Vector3(cx, cy, backPlane);
  const minZ = rz.min - backPlane;

  // Temple cross-sections from the hinge to the tips. The swing point is placed just behind the
  // hinge hardware (the dense cluster of hinge/screw vertices right behind the frame front), so
  // hinges stay rigid and the temple itself stays straight.
  const hingeZ0 = -0.015 * 2 * halfW;
  let temple = buildTempleProfile(pts, cx, cy, backPlane, halfW, hingeZ0, minZ);
  const hingeZ = hingeZ0 - hingeHardwareDepth(temple, (hingeZ0 - minZ) / TEMPLE_SLICES, 0.06 * 2 * halfW);
  if (hingeZ !== hingeZ0) temple = buildTempleProfile(pts, cx, cy, backPlane, halfW, hingeZ, minZ);

  let filled = 0;
  for (let k = 0; k < TEMPLE_SLICES; k++) if (temple.count[0][k] > 0 && temple.count[1][k] > 0) filled++;
  const hasTemples = depth > 0.45 * width && filled > TEMPLE_SLICES * 0.4;

  return {
    origin,
    analysis: {
      frontWidth: 2 * halfW,
      frontHeight: frontH,
      depth,
      hasTemples,
      hingeZ,
      minZ,
      maxZ: rz.max - backPlane,
      bridgeBottomY: bMinY - cy,
      bridgeBackZ: bBackZ - backPlane,
      temple,
      earBendZ: hasTemples ? detectEarBend(temple, frontH, hingeZ, minZ) : null,
    },
  };
}

function buildTempleProfile(
  pts: Float32Array,
  cx: number,
  cy: number,
  backPlane: number,
  halfW: number,
  hingeZ: number,
  minZ: number,
): TempleProfile {
  const temple: TempleProfile = {
    slices: TEMPLE_SLICES,
    inner: [new Float32Array(TEMPLE_SLICES).fill(Infinity), new Float32Array(TEMPLE_SLICES).fill(Infinity)],
    minY: [new Float32Array(TEMPLE_SLICES).fill(Infinity), new Float32Array(TEMPLE_SLICES).fill(Infinity)],
    maxY: [new Float32Array(TEMPLE_SLICES).fill(-Infinity), new Float32Array(TEMPLE_SLICES).fill(-Infinity)],
    count: [new Uint32Array(TEMPLE_SLICES), new Uint32Array(TEMPLE_SLICES)],
  };
  const span = hingeZ - minZ;
  if (span <= 1e-6) return temple;
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3] - cx;
    const z = pts[i * 3 + 2] - backPlane;
    if (z >= hingeZ || Math.abs(x) < 0.55 * halfW) continue;
    const side = x >= 0 ? 0 : 1;
    const k = Math.min(TEMPLE_SLICES - 1, Math.max(0, Math.floor(((hingeZ - z) / span) * TEMPLE_SLICES)));
    const y = pts[i * 3 + 1] - cy;
    temple.inner[side][k] = Math.min(temple.inner[side][k], Math.abs(x));
    temple.minY[side][k] = Math.min(temple.minY[side][k], y);
    temple.maxY[side][k] = Math.max(temple.maxY[side][k], y);
    temple.count[side][k]++;
  }
  return temple;
}

/**
 * Depth of the hinge hardware behind the initial swing point: leading temple slices that are
 * much denser than a typical temple slice on BOTH sides (hinge barrels, screws, end pieces).
 * Requiring both sides ignores one-sided details such as a logo printed on one temple.
 */
function hingeHardwareDepth(t: TempleProfile, sliceLen: number, maxDepth: number): number {
  const counts: number[] = [];
  for (let k = 0; k < t.slices; k++) counts.push(Math.min(t.count[0][k], t.count[1][k]));
  const typical = counts.slice(5, Math.max(6, t.slices - 5)).filter((c) => c > 0).sort((a, b) => a - b);
  if (typical.length === 0) return 0;
  const median = typical[typical.length >> 1];
  let k = 0;
  while (k < t.slices && counts[k] > 2.5 * median) k++;
  return Math.min(k * sliceLen, maxDepth);
}

/**
 * Where does the temple's underside start dropping away at the back (a modelled ear bend)?
 * Fits a line to the underside over 10–60% of the temple length; if the rear falls well below
 * it, returns the fit-space z where the drop begins. Sloped-but-straight temples stay on the
 * line and return null.
 */
function detectEarBend(t: TempleProfile, frontHeight: number, hingeZ: number, minZ: number): number | null {
  let bendU = 0;
  let sides = 0;
  for (const side of [0, 1] as const) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let n = 0;
    for (let k = 0; k < t.slices; k++) {
      const u = (k + 0.5) / t.slices;
      if (u < 0.1 || u > 0.6 || t.count[side][k] === 0) continue;
      const y = t.minY[side][k];
      sx += u;
      sy += y;
      sxx += u * u;
      sxy += u * y;
      n++;
    }
    if (n < 3) continue;
    const slope = (n * sxy - sx * sy) / Math.max(n * sxx - sx * sx, 1e-9);
    const icpt = (sy - slope * sx) / n;
    const dev = (k: number) => icpt + (slope * (k + 0.5)) / t.slices - t.minY[side][k];
    let maxDev = 0;
    for (let k = 0; k < t.slices; k++) {
      if ((k + 0.5) / t.slices >= 0.6 && t.count[side][k] > 0) maxDev = Math.max(maxDev, dev(k));
    }
    if (maxDev <= 0.1 * frontHeight) continue;
    for (let k = 0; k < t.slices; k++) {
      const u = (k + 0.5) / t.slices;
      if (u >= 0.35 && t.count[side][k] > 0 && dev(k) > 0.1 * maxDev) {
        bendU += u;
        sides++;
        break;
      }
    }
  }
  return sides > 0 ? hingeZ - (bendU / sides) * (hingeZ - minZ) : null;
}

/** Guesses the model's unit from the frame width (real frames are ~95–200 mm wide). */
export function guessUnits(frontWidth: number): UnitGuess | null {
  const candidates: UnitGuess[] = [
    { label: 'm', toCm: 100 },
    { label: 'cm', toCm: 1 },
    { label: 'mm', toCm: 0.1 },
    { label: 'in', toCm: 2.54 },
  ];
  for (const c of candidates) {
    const mm = frontWidth * c.toCm * 10;
    if (mm >= 95 && mm <= 200) return c;
  }
  return null;
}

export interface TempleSection {
  inner: number;
  minY: number;
  maxY: number;
}

/** Temple cross-section nearest to slice `z` (fit space) on one side, written into `out`. */
export function sampleTemple(
  a: FrameAnalysis,
  side: 0 | 1,
  z: number,
  out: TempleSection = { inner: 0, minY: 0, maxY: 0 },
): TempleSection | null {
  const t = a.temple;
  const span = a.hingeZ - a.minZ;
  if (span <= 0) return null;
  const k0 = Math.min(t.slices - 1, Math.max(0, Math.floor(((a.hingeZ - z) / span) * t.slices)));
  for (let d = 0; d < t.slices; d++) {
    for (let j = 0; j < 2; j++) {
      const k = j === 0 ? k0 - d : k0 + d;
      if (k >= 0 && k < t.slices && t.count[side][k] > 0) {
        out.inner = t.inner[side][k];
        out.minY = t.minY[side][k];
        out.maxY = t.maxY[side][k];
        return out;
      }
    }
  }
  return null;
}

let nextId = 1;

export class GlassesAsset {
  readonly id = `glasses-${nextId++}`;
  /** Normalisation wrapper: model space → fit space. Add this to the scene. */
  readonly root = new THREE.Group();
  readonly uniforms = createUniforms();
  readonly stats = { meshes: 0, vertices: 0, triangles: 0 };
  analysis!: FrameAnalysis;
  units: UnitGuess | null = null;
  private readonly content = new THREE.Group();
  private readonly meshes: THREE.Mesh[];
  private readonly samples: Float32Array;
  private readonly autoRotation: THREE.Matrix4;
  private readonly userRotation = new THREE.Matrix4();
  private readonly lensStates = new Map<THREE.Material, LensState>();
  private lensMode: 'transmission' | 'alpha' = 'transmission';

  constructor(
    readonly name: string,
    source: THREE.Object3D,
    readonly credit: ModelCredit | null = null,
  ) {
    this.root.name = `tryon:${name}`;
    this.root.matrixAutoUpdate = false;
    this.root.add(this.content);
    this.meshes = bakeMeshes(source);
    if (this.meshes.length === 0) throw new Error('The file does not contain any meshes.');

    // Hide stray huge meshes (floors, backdrops) that would ruin the measurements.
    let samples = collectSamples(this.meshes);
    const rng = [0, 1, 2].map((a) => percentileRange(axisValues(samples, a), 0.01));
    const diag = Math.hypot(...rng.map((r) => r.max - r.min));
    let hidden = false;
    for (const mesh of this.meshes) {
      mesh.geometry.computeBoundingBox();
      const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
      if (mesh.visible && size.length() > 3 * diag) {
        mesh.visible = false;
        hidden = true;
      }
    }
    if (hidden) samples = collectSamples(this.meshes);
    if (samples.length < 30) throw new Error('The model has too little geometry to fit.');
    this.samples = samples;

    const patched = new Set<THREE.Material>();
    for (const mesh of this.meshes) {
      this.content.add(mesh);
      const geo = mesh.geometry;
      this.stats.meshes++;
      this.stats.vertices += geo.attributes.position.count;
      this.stats.triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      let lens = false;
      for (const m of materialsOf(mesh)) {
        const isLens = isLensMaterial(mesh, m);
        if (isLens) {
          lens = true;
          const phys = m as THREE.MeshPhysicalMaterial;
          if (!this.lensStates.has(m)) {
            this.lensStates.set(m, {
              transmission: phys.isMeshPhysicalMaterial ? phys.transmission : 0,
              opacity: m.opacity,
              transparent: m.transparent,
              depthWrite: m.depthWrite,
            });
            if ('envMapIntensity' in phys) phys.envMapIntensity *= LENS_REFLECTION_SCALE;
          }
        }
        if (!patched.has(m)) {
          if (!isLens) restoreMetal(m);
          patchMaterial(m, this.uniforms);
          patched.add(m);
        }
      }
      if (lens) mesh.renderOrder = Math.max(mesh.renderOrder, 2);
    }

    this.autoRotation = detectOrientation(this.samples);
    this.recompute();
  }

  /** Rotates the model by 90° steps (manual orientation fix), then re-measures it. */
  rotate(axis: 'x' | 'y' | 'z', degrees: number): void {
    const r = new THREE.Matrix4();
    const rad = THREE.MathUtils.degToRad(degrees);
    if (axis === 'x') r.makeRotationX(rad);
    else if (axis === 'y') r.makeRotationY(rad);
    else r.makeRotationZ(rad);
    this.userRotation.premultiply(r);
    this.recompute();
  }

  resetOrientation(): void {
    this.userRotation.identity();
    this.recompute();
  }

  get isOrientationCustom(): boolean {
    return !this.userRotation.equals(new THREE.Matrix4());
  }

  /** Real total frame width in mm, when the model's unit could be detected. */
  get detectedWidthMm(): number | null {
    return this.units ? this.analysis.frontWidth * this.units.toCm * 10 : null;
  }

  /** 'alpha' converts refractive (transmission) lenses into cheap alpha-blended ones. */
  setLensMode(mode: 'transmission' | 'alpha'): void {
    if (mode === this.lensMode) return;
    this.lensMode = mode;
    for (const [m, s] of this.lensStates) {
      if (s.transmission <= 0) continue;
      const phys = m as THREE.MeshPhysicalMaterial;
      if (mode === 'alpha') {
        phys.transmission = 0;
        phys.transparent = true;
        phys.opacity = Math.min(s.opacity, 0.2 + 0.5 * (1 - s.transmission));
        phys.depthWrite = false;
      } else {
        phys.transmission = s.transmission;
        phys.transparent = s.transparent;
        phys.opacity = s.opacity;
        phys.depthWrite = s.depthWrite;
      }
      phys.needsUpdate = true;
    }
  }

  private recompute(): void {
    const rotation = this.userRotation.clone().multiply(this.autoRotation);
    const { analysis, origin } = analyzeFrame(this.samples, rotation);
    this.analysis = analysis;
    this.units = guessUnits(analysis.frontWidth);
    const norm = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z).multiply(rotation);
    this.root.matrix.copy(norm);
    this.root.matrixWorldNeedsUpdate = true;
    this.uniforms.uTryonNorm.value.copy(norm);
    this.uniforms.uTryonNormInv.value.copy(norm).invert();
    this.uniforms.uTryonHingeZ.value = analysis.hingeZ;
    const halfW = analysis.frontWidth / 2;
    this.uniforms.uTryonLat.value.set(0.55 * halfW, 0.75 * halfW, 0.08 * halfW);
    this.uniforms.uTryonBendOn.value = 0;
  }

  dispose(): void {
    const textures = new Set<THREE.Texture>();
    const materials = new Set<THREE.Material>();
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      for (const m of materialsOf(mesh)) materials.add(m);
    }
    for (const m of materials) {
      for (const value of Object.values(m)) if ((value as THREE.Texture)?.isTexture) textures.add(value as THREE.Texture);
      m.dispose();
    }
    for (const t of textures) t.dispose();
    this.root.removeFromParent();
  }
}
