/**
 * scalar.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Small scalar helpers (clamp, lerp, deg/rad conversion) are used by nearly
 *   every other math file. Centralizing them avoids five slightly-different
 *   copies of `clamp` scattered around the codebase.
 *
 * WHAT IT DOES
 *   Pure scalar functions with no dependencies.
 *
 * HOW IT COMMUNICATES
 *   Imported by `vector3.ts`, `quaternion.ts`, `matrix.ts`, `projection.ts`,
 *   and the smoothing filters.
 * ---------------------------------------------------------------------------
 */

/** A small epsilon for floating point comparisons (avoids div-by-zero, etc). */
export const EPSILON = 1e-8;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** Returns true if two numbers are within `epsilon` of each other. */
export function approxEqual(a: number, b: number, epsilon: number = EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}
