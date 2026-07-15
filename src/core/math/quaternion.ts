/**
 * quaternion.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Head rotation must be represented as a quaternion to avoid gimbal lock
 *   and to interpolate smoothly (this is what prevents jitter/snapping when
 *   the user turns their head quickly). This file provides every quaternion
 *   operation the pipeline needs, decoupled from Three.js so it can be
 *   unit-tested and ported later.
 *
 * WHAT IT DOES
 *   - identity/multiply/conjugate/normalize/dot/angleBetween
 *   - fromEulerYXZ / toEulerYXZ: conversion between quaternion and the
 *     pitch/yaw/roll convention used by `HeadPose.euler` and by the
 *     `rotationX/Y/Z` calibration offsets (authored in degrees, applied as
 *     an extra rotation on top of the tracked head pose).
 *   - slerp: spherical linear interpolation, used by `QuaternionSmoother`
 *     for jitter-free, framerate-independent rotation smoothing.
 *
 * HOW IT COMMUNICATES
 *   - `matrix.ts` produces a raw quaternion when decomposing MediaPipe's
 *     facialTransformationMatrix; `HeadPoseEstimator` calls into this file to
 *     get the Euler representation for debug/logging.
 *   - `core/smoothing/QuaternionSmoother.ts` calls `slerp` every frame.
 *   - `CalibrationEngine` calls `fromEulerYXZ` to turn the JSON
 *     `rotationX/Y/Z` correction into a quaternion, then `multiply`s it with
 *     the tracked head quaternion.
 * ---------------------------------------------------------------------------
 */

import type { EulerAnglesLike, QuaternionLike, Vector3Like } from '../types/math.types';
import { EPSILON, clamp } from './scalar';

export function quat(x: number, y: number, z: number, w: number): QuaternionLike {
  return { x, y, z, w };
}

export const IDENTITY_QUATERNION: Readonly<QuaternionLike> = Object.freeze({
  x: 0,
  y: 0,
  z: 0,
  w: 1,
});

export function lengthQuaternion(q: QuaternionLike): number {
  return Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
}

export function normalizeQuaternion(q: QuaternionLike): QuaternionLike {
  const len = lengthQuaternion(q);
  if (len < EPSILON) return { ...IDENTITY_QUATERNION };
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

export function conjugate(q: QuaternionLike): QuaternionLike {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Hamilton product: applies rotation `a` followed by rotation `b` (b * a). */
export function multiplyQuaternions(a: QuaternionLike, b: QuaternionLike): QuaternionLike {
  return {
    x: b.w * a.x + b.x * a.w + b.y * a.z - b.z * a.y,
    y: b.w * a.y - b.x * a.z + b.y * a.w + b.z * a.x,
    z: b.w * a.z + b.x * a.y - b.y * a.x + b.z * a.w,
    w: b.w * a.w - b.x * a.x - b.y * a.y - b.z * a.z,
  };
}

export function dotQuaternion(a: QuaternionLike, b: QuaternionLike): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

/** Angle (radians) of the rotation this quaternion represents relative to identity. */
export function angleOf(q: QuaternionLike): number {
  const n = normalizeQuaternion(q);
  return 2 * Math.acos(clamp(n.w, -1, 1));
}

/** Angular distance (radians) between two orientations — useful for smoothing thresholds. */
export function angleBetween(a: QuaternionLike, b: QuaternionLike): number {
  const d = clamp(Math.abs(dotQuaternion(normalizeQuaternion(a), normalizeQuaternion(b))), -1, 1);
  return 2 * Math.acos(d);
}

/**
 * Spherical linear interpolation between two quaternions.
 * Falls back to normalized linear interpolation (nlerp) when the angle is
 * very small, which is both cheaper and numerically safer near t≈identity —
 * exactly the regime a mostly-still face sits in most of the time.
 */
export function slerp(a: QuaternionLike, b: QuaternionLike, t: number): QuaternionLike {
  const ct = clamp(t, 0, 1);
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;

  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw;

  // Take the shorter path around the hypersphere.
  if (cosHalfTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }

  if (cosHalfTheta > 0.9995) {
    // Nearly identical orientations — nlerp avoids a division-by-near-zero below.
    return normalizeQuaternion({
      x: a.x + (bx - a.x) * ct,
      y: a.y + (by - a.y) * ct,
      z: a.z + (bz - a.z) * ct,
      w: a.w + (bw - a.w) * ct,
    });
  }

  const halfTheta = Math.acos(clamp(cosHalfTheta, -1, 1));
  const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);

  const ratioA = Math.sin((1 - ct) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(ct * halfTheta) / sinHalfTheta;

  return {
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  };
}

/** Cheaper approximate interpolation — used only when the two orientations are already very close. */
export function nlerp(a: QuaternionLike, b: QuaternionLike, t: number): QuaternionLike {
  const ct = clamp(t, 0, 1);
  const sign = dotQuaternion(a, b) < 0 ? -1 : 1;
  return normalizeQuaternion({
    x: a.x + (b.x * sign - a.x) * ct,
    y: a.y + (b.y * sign - a.y) * ct,
    z: a.z + (b.z * sign - a.z) * ct,
    w: a.w + (b.w * sign - a.w) * ct,
  });
}

/**
 * Builds a quaternion from pitch/yaw/roll (radians) using intrinsic Y (yaw) →
 * X (pitch) → Z (roll) order — the standard convention for head orientation
 * (yaw is "turning to look left/right", applied first/outermost).
 */
export function fromEulerYXZ(euler: EulerAnglesLike): QuaternionLike {
  const { pitch, yaw, roll } = euler;

  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cx = Math.cos(pitch * 0.5);
  const sx = Math.sin(pitch * 0.5);
  const cz = Math.cos(roll * 0.5);
  const sz = Math.sin(roll * 0.5);

  // Quaternion composition for order Y * X * Z (applied right-to-left: roll, then pitch, then yaw).
  const qy: QuaternionLike = { x: 0, y: sy, z: 0, w: cy };
  const qx: QuaternionLike = { x: sx, y: 0, z: 0, w: cx };
  const qz: QuaternionLike = { x: 0, y: 0, z: sz, w: cz };

  return multiplyQuaternions(multiplyQuaternions(qz, qx), qy);
}

/**
 * Decomposes a quaternion back into pitch/yaw/roll (radians), matching the
 * YXZ order used by `fromEulerYXZ`. Used for debug overlays and for
 * inspecting/clamping tracked head rotation.
 */
export function toEulerYXZ(q: QuaternionLike): EulerAnglesLike {
  const n = normalizeQuaternion(q);
  const { x, y, z, w } = n;

  // Standard YXZ (intrinsic) extraction from quaternion components.
  const sinPitch = clamp(2 * (w * x - y * z), -1, 1);
  const pitch = Math.asin(sinPitch);

  let yaw: number;
  let roll: number;

  if (Math.abs(sinPitch) < 0.9999) {
    yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
    roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  } else {
    // Gimbal lock (looking almost straight up/down) — fall back to a stable
    // approximation. This edge case is rare for a face pointed at a webcam.
    yaw = Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z));
    roll = 0;
  }

  return { pitch, yaw, roll };
}

export function cloneQuaternion(q: QuaternionLike): QuaternionLike {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/**
 * Rotates a 3D vector by a quaternion (v' = q * v * q⁻¹, computed via the
 * standard optimized expansion rather than two full quaternion multiplies).
 * Used by `CalibrationEngine` to express a per-model offset (authored in the
 * model's own local space) in the head's current world orientation, so the
 * offset "rides along" with head rotation instead of staying axis-aligned.
 */
export function rotateVector3ByQuaternion(v: Vector3Like, q: QuaternionLike): Vector3Like {
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;

  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);

  // v' = v + q.w * t + cross(q.xyz, t)
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}
