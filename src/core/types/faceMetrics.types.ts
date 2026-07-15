/**
 * faceMetrics.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Raw landmarks are just 478 points — nothing about "how wide is this
 *   person's face" or "where is the nose bridge" is explicit. CalibrationEngine
 *   needs these derived, named measurements to scale/position glasses
 *   correctly for THIS face, not an average face.
 *
 * WHAT IT DOES
 *   Declares the `FaceMetrics` shape produced by `FaceTracker` via the pure
 *   functions in `core/math/faceMetrics.ts`.
 *
 * HOW IT COMMUNICATES
 *   - `modules/faceTracker/FaceTracker.ts` produces `FaceMetrics` every frame.
 *   - `modules/calibration/CalibrationEngine.ts` consumes it alongside
 *     `CalibrationData` (per-model JSON) to compute the final scale factor.
 * ---------------------------------------------------------------------------
 */

import type { Point3D, Vector3Like } from './math.types';

/** Millimeter-normalized or unit-less measurements — see FaceTracker docs for the convention used. */
export interface FaceMetrics {
  /** Interpupillary distance — distance between the two eye-center landmarks. */
  interPupillaryDistance: number;
  /** Approximate full face width, temple to temple. */
  faceWidth: number;
  /** Left eye center, in normalized landmark space. */
  leftEyeCenter: Point3D;
  /** Right eye center, in normalized landmark space. */
  rightEyeCenter: Point3D;
  /** Midpoint between the two eye centers — the primary horizontal anchor. */
  eyeMidpoint: Point3D;
  /** Nose bridge point (between the eyes, at the top of the nose), in normalized landmark space. */
  noseBridge: Point3D;
  /**
   * The nose bridge, back-projected into the SAME metric camera-space (mm)
   * that `headPose.position` lives in — see
   * `core/math/projection.ts`'s `unprojectToMetricSpace` doc comment for why
   * this (not `headPose.position`) is the anatomically correct anchor point
   * for glasses. This is what `CalibrationEngine` actually positions against.
   */
  noseBridgeMetric: Vector3Like;
  /** Distance from nose bridge to chin, used as a secondary vertical-scale reference. */
  faceHeight: number;
  /** Left face edge (temple/ear area) back-projected into 3D metric camera-space (mm). */
  leftFaceEdgeMetric: Vector3Like;
  /** Right face edge (temple/ear area) back-projected into 3D metric camera-space (mm). */
  rightFaceEdgeMetric: Vector3Like;
}

