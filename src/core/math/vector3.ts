/**
 * vector3.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   FaceTracker and CalibrationEngine need vector arithmetic (distance,
 *   midpoint, lerp) on plain `Vector3Like`/`Point3D` objects without pulling
 *   in Three.js. This keeps the measurement math portable and unit-testable
 *   in isolation.
 *
 * WHAT IT DOES
 *   Pure functions: add, subtract, scale, dot, cross, length, distance,
 *   normalize, lerp, midpoint. Every function takes and returns
 *   `Vector3Like` — never mutates its inputs.
 *
 * HOW IT COMMUNICATES
 *   Used by `faceMetrics.ts` (distance/midpoint calculations), by
 *   `core/smoothing/OneEuroFilter.ts` (per-axis filtering), and by
 *   `CalibrationEngine` (offset application).
 * ---------------------------------------------------------------------------
 */

import type { Vector3Like } from '../types/math.types';
import { EPSILON, clamp } from './scalar';

export function vec3(x: number, y: number, z: number): Vector3Like {
  return { x, y, z };
}

export const ZERO: Readonly<Vector3Like> = Object.freeze({ x: 0, y: 0, z: 0 });

export function add(a: Vector3Like, b: Vector3Like): Vector3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Vector3Like, b: Vector3Like): Vector3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vector3Like, s: number): Vector3Like {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function negate(v: Vector3Like): Vector3Like {
  return { x: -v.x, y: -v.y, z: -v.z };
}

export function dot(a: Vector3Like, b: Vector3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vector3Like, b: Vector3Like): Vector3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(v: Vector3Like): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function length(v: Vector3Like): number {
  return Math.sqrt(lengthSq(v));
}

/** Euclidean distance between two points. This is the workhorse for IPD/face-width math. */
export function distance(a: Vector3Like, b: Vector3Like): number {
  return length(subtract(a, b));
}

export function normalize(v: Vector3Like): Vector3Like {
  const len = length(v);
  if (len < EPSILON) return { x: 0, y: 0, z: 0 };
  return scale(v, 1 / len);
}

/** Linear interpolation between two points, t clamped to [0, 1]. */
export function lerpVector3(a: Vector3Like, b: Vector3Like, t: number): Vector3Like {
  const ct = clamp(t, 0, 1);
  return {
    x: a.x + (b.x - a.x) * ct,
    y: a.y + (b.y - a.y) * ct,
    z: a.z + (b.z - a.z) * ct,
  };
}

/** Midpoint between two points — used heavily for eye-center / nose-bridge estimation. */
export function midpoint(a: Vector3Like, b: Vector3Like): Vector3Like {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

export function toArray(v: Vector3Like): [number, number, number] {
  return [v.x, v.y, v.z];
}

export function fromArray(arr: ArrayLike<number>, offset = 0): Vector3Like {
  return { x: arr[offset], y: arr[offset + 1], z: arr[offset + 2] };
}

export function clone(v: Vector3Like): Vector3Like {
  return { x: v.x, y: v.y, z: v.z };
}
