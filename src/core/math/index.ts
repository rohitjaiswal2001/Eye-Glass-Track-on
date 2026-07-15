/**
 * core/math/index.ts
 * ---------------------------------------------------------------------------
 * Barrel export for the framework-agnostic math layer. Everything here is a
 * pure function operating on the structural types in `core/types` — no
 * Three.js, no React, no DOM. This is the layer intended to be portable to
 * a future Flutter/Dart implementation.
 * ---------------------------------------------------------------------------
 */

export * from './scalar';
export * from './vector3';
export * from './quaternion';
export * from './matrix';
export * from './landmarkIndices';
export * from './projection';
export * from './faceMetrics';
