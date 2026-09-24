import * as THREE from 'three';
import { CANONICAL_POSITIONS } from './canonicalFace';
import {
  EAR_ROOT_OFFSET,
  IRIS_DIAMETER_CM,
  LEFT_EYE_CONTOUR,
  LEFT_IRIS_RING,
  LM,
  NOSE_MIDLINE,
  RIGHT_EYE_CONTOUR,
  RIGHT_IRIS_RING,
} from './constants';
import type { FaceReconstruction } from './faceReconstruction';

/**
 * Per-user face measurements in canonical space (cm). MediaPipe normalises every face to
 * the canonical size, so `scale` (real cm per canonical cm, from the iris) is what turns a
 * real-size frame into a true-to-life fit.
 */
export interface FaceProfile {
  pupilR: THREE.Vector3;
  pupilL: THREE.Vector3;
  /** Mean depth (z) of the eyelid contours. */
  eyeZ: number;
  /** Nose midline samples (top → bottom). */
  noseY: Float32Array;
  noseZ: Float32Array;
  /** Face contour in front of the ears (landmarks 127 / 356). */
  earFrontR: THREE.Vector3;
  earFrontL: THREE.Vector3;
  /** Temple rest points on top of the ears. */
  earR: THREE.Vector3;
  earL: THREE.Vector3;
  /** Face width at 127↔356. */
  faceWidth: number;
  /** Real-world cm per canonical cm. */
  scale: number;
  /** 0‥1 progress of the iris measurement. */
  progress: number;
  source: 'default' | 'iris' | 'manual';
}

const NOSE_N = NOSE_MIDLINE.length;
// Sample record layout
const F_PUPIL_R = 0;
const F_PUPIL_L = 3;
const F_EYE_Z = 6;
const F_NOSE_Y = 7;
const F_NOSE_Z = F_NOSE_Y + NOSE_N;
const F_EAR_R = F_NOSE_Z + NOSE_N;
const F_EAR_L = F_EAR_R + 3;
const F_IRIS = F_EAR_L + 3;
const FIELDS = F_IRIS + 1;

const EYE_CONTOURS = [...RIGHT_EYE_CONTOUR, ...LEFT_EYE_CONTOUR];

const WINDOW = 60;
const FULL_IRIS_SAMPLES = 30;
const MAX_FACING_ANGLE = THREE.MathUtils.degToRad(20);
const MIN_EYE_OPENNESS = 0.16;
const MIN_IRIS_PX = 7;

function canonical(i: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.fromArray(CANONICAL_POSITIONS, i * 3);
}

function meanCanonical(ids: readonly number[]): THREE.Vector3 {
  const v = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (const i of ids) v.add(canonical(i, t));
  return v.divideScalar(ids.length);
}

function defaultRecord(): Float32Array {
  const r = new Float32Array(FIELDS);
  meanCanonical(RIGHT_EYE_CONTOUR).toArray(r, F_PUPIL_R);
  meanCanonical(LEFT_EYE_CONTOUR).toArray(r, F_PUPIL_L);
  r[F_EYE_Z] = meanCanonical([...RIGHT_EYE_CONTOUR, ...LEFT_EYE_CONTOUR]).z;
  NOSE_MIDLINE.forEach((id, k) => {
    r[F_NOSE_Y + k] = CANONICAL_POSITIONS[id * 3 + 1];
    r[F_NOSE_Z + k] = CANONICAL_POSITIONS[id * 3 + 2];
  });
  canonical(LM.rightEarFront).toArray(r, F_EAR_R);
  canonical(LM.leftEarFront).toArray(r, F_EAR_L);
  r[F_IRIS] = IRIS_DIAMETER_CM;
  return r;
}

export class FaceCalibrator {
  readonly profile: FaceProfile;
  private readonly defaults = defaultRecord();
  private readonly ring = new Float32Array(WINDOW * FIELDS);
  private count = 0;
  private head = 0;
  private column = new Float32Array(WINDOW);
  private median = new Float32Array(FIELDS);
  private manualPdMm: number | null = null;
  private sinceRebuild = 0;
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();

  constructor() {
    this.profile = {
      pupilR: new THREE.Vector3(),
      pupilL: new THREE.Vector3(),
      eyeZ: 0,
      noseY: new Float32Array(NOSE_N),
      noseZ: new Float32Array(NOSE_N),
      earFrontR: new THREE.Vector3(),
      earFrontL: new THREE.Vector3(),
      earR: new THREE.Vector3(),
      earL: new THREE.Vector3(),
      faceWidth: 0,
      scale: 1,
      progress: 0,
      source: 'default',
    };
    this.reset();
  }

  get sampleCount(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.median.set(this.defaults);
    this.rebuild(0);
  }

  setManualPd(pdMm: number | null): void {
    this.manualPdMm = pdMm && pdMm > 40 && pdMm < 85 ? pdMm : null;
    this.rebuild(this.irisCount());
  }

  /** Feeds one tracked frame. Returns true if it was accepted as a calibration sample. */
  addFrame(recon: FaceReconstruction): boolean {
    if (!this.isGoodView(recon)) return false;
    const rec = this.ring.subarray(this.head * FIELDS, (this.head + 1) * FIELDS);
    const v = this.v;

    recon.getCanonical(LM.rightIrisCenter, v).toArray(rec, F_PUPIL_R);
    recon.getCanonical(LM.leftIrisCenter, v).toArray(rec, F_PUPIL_L);
    let eyeZ = 0;
    for (const i of EYE_CONTOURS) eyeZ += recon.getCanonical(i, v).z;
    rec[F_EYE_Z] = eyeZ / EYE_CONTOURS.length;
    NOSE_MIDLINE.forEach((id, k) => {
      recon.getCanonical(id, v);
      rec[F_NOSE_Y + k] = v.y;
      rec[F_NOSE_Z + k] = v.z;
    });
    recon.getCanonical(LM.rightEarFront, v).toArray(rec, F_EAR_R);
    recon.getCanonical(LM.leftEarFront, v).toArray(rec, F_EAR_L);
    rec[F_IRIS] = this.measureIris(recon);

    this.head = (this.head + 1) % WINDOW;
    this.count = Math.min(this.count + 1, WINDOW);
    // Medians of ~110 fields: every sample while converging, then every 4th (still ~8×/s).
    if (this.count < WINDOW || ++this.sinceRebuild >= 4) {
      this.sinceRebuild = 0;
      this.computeMedians();
      this.rebuild(this.irisCount());
    }
    return true;
  }

  /** Face shape is only measured from (near-)frontal views, where the landmarks are reliable. */
  private isGoodView(recon: FaceReconstruction): boolean {
    const e = recon.matrix.elements;
    const fwd = this.v.set(e[8], e[9], e[10]).normalize();
    const toCam = this.w.set(-e[12], -e[13], -e[14]).normalize();
    return fwd.dot(toCam) >= Math.cos(MAX_FACING_ANGLE);
  }

  /**
   * Horizontal iris diameter converted to canonical cm. NaN (sample skipped for scale only)
   * while blinking/squinting or when the iris is too small in the image to trust.
   */
  private measureIris(recon: FaceReconstruction): number {
    const openR =
      recon.pixelDistance(LM.rightEyeUpper, LM.rightEyeLower) /
      Math.max(recon.pixelDistance(LM.rightEyeOuter, LM.rightEyeInner), 1);
    const openL =
      recon.pixelDistance(LM.leftEyeUpper, LM.leftEyeLower) /
      Math.max(recon.pixelDistance(LM.leftEyeOuter, LM.leftEyeInner), 1);
    if (openR < MIN_EYE_OPENNESS || openL < MIN_EYE_OPENNESS) return NaN;
    const dR = this.irisPx(recon, RIGHT_IRIS_RING, LM.rightEyeOuter, LM.rightEyeInner);
    const dL = this.irisPx(recon, LEFT_IRIS_RING, LM.leftEyeOuter, LM.leftEyeInner);
    if (Math.min(dR, dL) < MIN_IRIS_PX) return NaN;
    const depth = (recon.meanDepth(RIGHT_EYE_CONTOUR) + recon.meanDepth(LEFT_EYE_CONTOUR)) / 2;
    return (((dR + dL) / 2) * depth) / recon.focalPx;
  }

  private irisPx(recon: FaceReconstruction, ring: readonly number[], outer: number, inner: number): number {
    const p = recon.pixels;
    let ex = p[inner * 2] - p[outer * 2];
    let ey = p[inner * 2 + 1] - p[outer * 2 + 1];
    const el = Math.hypot(ex, ey) || 1;
    ex /= el;
    ey /= el;
    let best = 0;
    let bestAlign = -1;
    for (let k = 0; k < 2; k++) {
      const a = ring[k];
      const b = ring[k + 2];
      const dx = p[a * 2] - p[b * 2];
      const dy = p[a * 2 + 1] - p[b * 2 + 1];
      const len = Math.hypot(dx, dy);
      const align = Math.abs((dx * ex + dy * ey) / (len || 1));
      if (align > bestAlign) {
        bestAlign = align;
        best = len;
      }
    }
    return best;
  }

  private irisCount(): number {
    let n = 0;
    for (let s = 0; s < this.count; s++) if (!Number.isNaN(this.ring[s * FIELDS + F_IRIS])) n++;
    return n;
  }

  private computeMedians(): void {
    for (let f = 0; f < FIELDS; f++) {
      let n = 0;
      for (let s = 0; s < this.count; s++) {
        const val = this.ring[s * FIELDS + f];
        if (!Number.isNaN(val)) this.column[n++] = val;
      }
      if (n === 0) {
        this.median[f] = this.defaults[f];
        continue;
      }
      const col = this.column.subarray(0, n).sort();
      this.median[f] = n % 2 ? col[(n - 1) >> 1] : (col[n / 2 - 1] + col[n / 2]) / 2;
    }
  }

  private rebuild(irisSamples: number): void {
    const m = this.median;
    const p = this.profile;
    p.pupilR.fromArray(m, F_PUPIL_R);
    p.pupilL.fromArray(m, F_PUPIL_L);
    p.eyeZ = m[F_EYE_Z];
    for (let k = 0; k < NOSE_N; k++) {
      p.noseY[k] = m[F_NOSE_Y + k];
      p.noseZ[k] = m[F_NOSE_Z + k];
    }
    p.earFrontR.fromArray(m, F_EAR_R);
    p.earFrontL.fromArray(m, F_EAR_L);
    const o = EAR_ROOT_OFFSET;
    p.earR.set(p.earFrontR.x - o.out, p.earFrontR.y + o.up, p.earFrontR.z - o.back);
    p.earL.set(p.earFrontL.x + o.out, p.earFrontL.y + o.up, p.earFrontL.z - o.back);
    p.faceWidth = p.earFrontL.x - p.earFrontR.x;

    const ipdCanon = Math.max(p.pupilR.distanceTo(p.pupilL), 3);
    if (this.manualPdMm) {
      p.scale = this.manualPdMm / 10 / ipdCanon;
      p.source = 'manual';
      p.progress = 1;
      return;
    }
    if (irisSamples >= 5) {
      const measured = THREE.MathUtils.clamp(IRIS_DIAMETER_CM / m[F_IRIS], 0.8, 1.25);
      const w = Math.min(1, irisSamples / 20);
      p.scale = 1 + (measured - 1) * w;
      p.source = 'iris';
    } else {
      p.scale = 1;
      p.source = 'default';
    }
    p.progress = Math.min(1, irisSamples / FULL_IRIS_SAMPLES);
  }

  /** Real pupillary distance in mm. */
  get pdMm(): number {
    return this.profile.pupilR.distanceTo(this.profile.pupilL) * this.profile.scale * 10;
  }
}

/** Nose surface depth at height `y` (linear interpolation along the midline). */
export function noseDepthAt(profile: FaceProfile, y: number): number {
  const { noseY, noseZ } = profile;
  const n = noseY.length;
  if (y >= noseY[0]) return noseZ[0];
  for (let k = 1; k < n; k++) {
    if (y >= noseY[k]) {
      const t = (y - noseY[k]) / Math.max(noseY[k - 1] - noseY[k], 1e-4);
      return noseZ[k] + (noseZ[k - 1] - noseZ[k]) * t;
    }
  }
  return noseZ[n - 1];
}
