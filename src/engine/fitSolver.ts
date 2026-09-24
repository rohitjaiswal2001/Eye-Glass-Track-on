import * as THREE from 'three';
import {
  CORNEA_OFFSET_CM,
  EAR_BEND_BEHIND_ROOT_CM,
  IDEAL_FRAME_TO_FACE,
  PUPIL_TO_FRAME_CENTER,
  VERTEX_DISTANCE_CM,
} from './constants';
import { noseDepthAt, type FaceProfile } from './faceProfile';
import { sampleTemple, type FrameAnalysis, type GlassesAsset, type TempleSection } from './glassesAsset';
import type { FitLabel, FitParams } from './types';

export interface FitResult {
  /** Fit space → canonical face space. */
  matrix: THREE.Matrix4;
  /** Canonical cm per model unit. */
  scale: number;
  /** Frame width as rendered, real mm. */
  frameWidthMm: number;
  recommendedWidthMm: number;
  label: FitLabel;
}

export function createFitResult(): FitResult {
  return { matrix: new THREE.Matrix4(), scale: 1, frameWidthMm: 0, recommendedWidthMm: 0, label: 'good' };
}

/** Temple length may be adjusted within this range to put the modelled ear bend on the ear. */
const Z_SCALE_MIN = 0.85;
const Z_SCALE_MAX = 1.2;
/**
 * The temple disappears this far behind the ear rest point: from there on it runs behind the
 * ear (and the head), so ending it here is robust to every ear shape and viewing angle.
 */
const TEMPLE_CUT_BEHIND_ROOT_CM = 0.3;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _ear: TempleSection = { inner: 0, minY: 0, maxY: 0 };

/**
 * Places the frame on the face (canonical space, cm):
 *  - size: real frame width ÷ the user's real face scale (iris-measured), or fit-to-face;
 *  - height: pupils slightly above the lens box centre;
 *  - depth: lenses at the optometric vertex distance, but never sunk into the nose;
 *  - temples: kept straight (original shape) and swung at the hinge to rest on the ear roots,
 *    length matched so the modelled ear bend sits over the ear, ended where they go behind it.
 */
export function solveFit(profile: FaceProfile, asset: GlassesAsset, fit: FitParams, out: FitResult): void {
  const a = asset.analysis;
  const s = profile.scale;
  const mmToCanon = 0.1 / s;

  const unitToCm = fit.frameWidthMm ? fit.frameWidthMm / 10 / a.frontWidth : (asset.units?.toCm ?? null);
  const idealCanon = IDEAL_FRAME_TO_FACE * profile.faceWidth;
  let k = fit.sizeMode === 'real' && unitToCm ? unitToCm / s : idealCanon / a.frontWidth;
  k *= fit.sizeAdjust;

  const tilt = THREE.MathUtils.degToRad(fit.tiltDeg);
  _q.setFromAxisAngle(X_AXIS, tilt);

  const cx = (profile.pupilR.x + profile.pupilL.x) / 2;
  const pupilY = (profile.pupilR.y + profile.pupilL.y) / 2;
  const cy = pupilY - PUPIL_TO_FRAME_CENTER * a.frontHeight * k + fit.offsetY * mmToCanon;
  let cz = profile.eyeZ + CORNEA_OFFSET_CM + VERTEX_DISTANCE_CM;

  // Nose contact: the underside of the bridge must sit on, not inside, the nose.
  _v.set(0, a.bridgeBottomY, a.bridgeBackZ).multiplyScalar(k).applyQuaternion(_q);
  const noseZ = noseDepthAt(profile, cy + _v.y);
  cz = Math.max(cz, noseZ + 0.05 - _v.z) + fit.offsetZ * mmToCanon;

  _pos.set(cx, cy, cz);
  _s.setScalar(k);
  out.matrix.compose(_pos, _q, _s);
  out.scale = k;

  const u = asset.uniforms;
  if (a.hasTemples) {
    _qInv.copy(_q).invert();
    const spread = (fit.templeAdjust * mmToCanon) / k;
    const minEarZ = a.hingeZ - 0.1 * a.frontWidth;
    for (const side of [0, 1] as const) {
      // Ear rest point in the frame's own (fit) space.
      _v.copy(side === 0 ? profile.earL : profile.earR)
        .sub(_pos)
        .applyQuaternion(_qInv)
        .divideScalar(k);
      const earZ = Math.min(_v.z, minEarZ);
      // Temple length: the modelled bend should start over the top of the ear, just behind the
      // rest point, so the temple passes over the ear and curls down out of sight behind it.
      const bendTarget = earZ - EAR_BEND_BEHIND_ROOT_CM / k;
      const zScale =
        a.earBendZ === null
          ? 1
          : THREE.MathUtils.clamp((a.hingeZ - bendTarget) / (a.hingeZ - a.earBendZ), Z_SCALE_MIN, Z_SCALE_MAX);

      let dx = 0;
      let dy = 0;
      if (sampleTemple(a, side, unscaleZ(a, earZ, zScale), _ear)) {
        // Many models have straight, parallel temples (no built-in spread or pantoscopic
        // drop), so allow up to ~2.5 cm of swing at the ear, like opening a real hinge wider.
        dx = THREE.MathUtils.clamp(Math.abs(_v.x) - _ear.inner + spread, -1.2 / k, 2.5 / k);
        dy = THREE.MathUtils.clamp(_v.y - _ear.minY, -2.5 / k, 1.0 / k);
      }

      u.uTryonEarZ.value.setComponent(side, earZ);
      u.uTryonZScale.value.setComponent(side, zScale);
      u.uTryonDX.value.setComponent(side, dx);
      u.uTryonDY.value.setComponent(side, dy);
    }
    u.uTryonCut.value = TEMPLE_CUT_BEHIND_ROOT_CM / k;
    u.uTryonBendOn.value = 1;
  } else {
    u.uTryonCut.value = 1e6;
    u.uTryonBendOn.value = 0;
  }

  out.frameWidthMm = a.frontWidth * k * s * 10;
  out.recommendedWidthMm = idealCanon * s * 10;
  const r = out.frameWidthMm / out.recommendedWidthMm;
  out.label = r < 0.92 ? 'too-narrow' : r < 0.965 ? 'narrow' : r <= 1.035 ? 'good' : r <= 1.08 ? 'wide' : 'too-wide';
}

/** Original (un-stretched) z of the temple point that ends up at `z` after the length scale. */
function unscaleZ(a: FrameAnalysis, z: number, zScale: number): number {
  return a.hingeZ - (a.hingeZ - z) / zScale;
}
