/**
 * core/types/index.ts
 * ---------------------------------------------------------------------------
 * Barrel export. Everywhere else in the app should import from
 * `@/core/types` rather than reaching into individual files, so this module
 * is the single public surface of the shared type layer.
 * ---------------------------------------------------------------------------
 */

export * from './math.types';
export * from './landmarks.types';
export * from './faceMetrics.types';
export * from './headPose.types';
export * from './calibration.types';
export * from './camera.types';
export * from './performance.types';
export * from './tracking.types';
export * from './smoothing.types';
