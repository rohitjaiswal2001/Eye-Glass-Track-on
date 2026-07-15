/**
 * matrix.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   MediaPipe's FaceLandmarker gives us head pose as a raw 16-element 4x4
 *   matrix (`facialTransformationMatrix`), not as separate position/rotation.
 *   We deliberately decompose this matrix ourselves (a well-understood,
 *   numerically standard operation) rather than hand-rolling a PnP solver —
 *   see the architecture notes. This file is the one place that
 *   understands the matrix layout.
 *
 * WHAT IT DOES
 *   - `decomposeMatrix4`: splits a column-major 4x4 matrix into
 *     position + quaternion + scale (the same algorithm used internally by
 *     `THREE.Matrix4.decompose`, reimplemented without a THREE dependency).
 *   - `transformPoint`: applies a 4x4 matrix to a 3D point (used for
 *     sanity-checking decomposition and for potential future projection needs).
 *   - `identityMatrix4`: a neutral 4x4 matrix, useful for tests/fallbacks.
 *
 * HOW IT COMMUNICATES
 *   - `modules/headPose/HeadPoseEstimator.ts` calls `decomposeMatrix4` on
 *     every `FaceLandmarkerFrame.facialTransformationMatrix` to produce a
 *     `HeadPose`.
 * ---------------------------------------------------------------------------
 */

import type { Matrix4Array, QuaternionLike, TransformLike, Vector3Like } from '../types/math.types';
import { EPSILON } from './scalar';

/** A neutral, no-op 4x4 matrix in column-major layout (matches Three.js/MediaPipe convention). */
export function identityMatrix4(): number[] {
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/**
 * Decomposes a column-major 4x4 transform matrix into translation, rotation
 * (as a quaternion) and scale.
 *
 * Matrix element layout (column-major, matches MediaPipe & Three.js):
 *   [ m0  m4  m8  m12 ]      column 0 = local X basis (m0,m1,m2)
 *   [ m1  m5  m9  m13 ]      column 1 = local Y basis (m4,m5,m6)
 *   [ m2  m6  m10 m14 ]      column 2 = local Z basis (m8,m9,m10)
 *   [ m3  m7  m11 m15 ]      column 3 = translation  (m12,m13,m14)
 */
export function decomposeMatrix4(m: Matrix4Array): TransformLike {
  const e = m;

  // --- Translation is simply the 4th column. ---
  const position: Vector3Like = { x: e[12], y: e[13], z: e[14] };

  // --- Scale is the length of each basis column. ---
  let sx = Math.hypot(e[0], e[1], e[2]);
  const sy = Math.hypot(e[4], e[5], e[6]);
  const sz = Math.hypot(e[8], e[9], e[10]);

  // If the determinant is negative, the transform includes a reflection;
  // fold that sign into one axis so the rotation matrix we extract next is
  // a proper (determinant +1) rotation.
  const det =
    e[0] * (e[5] * e[10] - e[6] * e[9]) -
    e[4] * (e[1] * e[10] - e[2] * e[9]) +
    e[8] * (e[1] * e[6] - e[2] * e[5]);
  if (det < 0) sx = -sx;

  const invSx = Math.abs(sx) > EPSILON ? 1 / sx : 0;
  const invSy = Math.abs(sy) > EPSILON ? 1 / sy : 0;
  const invSz = Math.abs(sz) > EPSILON ? 1 / sz : 0;

  // Normalized (scale-free) rotation basis columns.
  const m00 = e[0] * invSx;
  const m10 = e[1] * invSx;
  const m20 = e[2] * invSx;
  const m01 = e[4] * invSy;
  const m11 = e[5] * invSy;
  const m21 = e[6] * invSy;
  const m02 = e[8] * invSz;
  const m12 = e[9] * invSz;
  const m22 = e[10] * invSz;

  const quaternion = rotationMatrixToQuaternion(m00, m01, m02, m10, m11, m12, m20, m21, m22);

  return {
    position,
    quaternion,
    scale: { x: Math.abs(sx), y: Math.abs(sy), z: Math.abs(sz) },
  };
}

/**
 * Converts a 3x3 rotation matrix (given as individual components, row-major
 * naming `m{row}{col}`) into a quaternion using the standard trace-based
 * method (numerically stable branch selection, equivalent to the algorithm
 * used in Three.js / most graphics engines).
 */
function rotationMatrixToQuaternion(
  m00: number,
  m01: number,
  m02: number,
  m10: number,
  m11: number,
  m12: number,
  m20: number,
  m21: number,
  m22: number,
): QuaternionLike {
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return {
      w: 0.25 / s,
      x: (m21 - m12) * s,
      y: (m02 - m20) * s,
      z: (m10 - m01) * s,
    };
  }

  if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    return {
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    };
  }

  if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    return {
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    };
  }

  const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
  return {
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  };
}

/** Applies a column-major 4x4 matrix to a 3D point (assumes w=1, i.e. a position not a direction). */
export function transformPoint(m: Matrix4Array, p: Vector3Like): Vector3Like {
  const e = m;
  return {
    x: e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12],
    y: e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13],
    z: e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14],
  };
}
