/**
 * faceMetrics.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   This is the single place that turns "478 raw points" into the specific,
 *   named measurements CalibrationEngine actually needs. Keeping it isolated
 *   means FaceTracker stays a thin orchestrator, and this logic is trivially
 *   unit-testable with a fixture landmark array.
 *
 * WHAT IT DOES
 *   `computeFaceMetrics(landmarks, frameWidth, frameHeight, depthMm?)`:
 *     - Derives eye centers from eye-corner midpoints (robust whether or not
 *       iris landmarks are enabled).
 *     - Computes interpupillary distance and face width in pixel space.
 *     - If `depthMm` is supplied (from HeadPoseEstimator's decomposed
 *       translation), converts those distances to millimeters via
 *       `projection.ts` so they're directly comparable to a calibration
 *       JSON's `frameWidth`/`bridgeWidth` (also mm). Without a depth value,
 *       distances are returned in pixel units — still useful for relative
 *       comparisons, just not yet metric.
 *
 * HOW IT COMMUNICATES
 *   - `modules/faceTracker/FaceTracker.ts` calls this every frame with the
 *     latest `FaceLandmarkerFrame`.
 *   - Output feeds `modules/calibration/CalibrationEngine.ts`.
 * ---------------------------------------------------------------------------
 */

import type { FaceLandmarkList } from '../types/landmarks.types';
import type { FaceMetrics } from '../types/faceMetrics.types';
import * as idx from './landmarkIndices';
import { distance, midpoint } from './vector3';
import { estimateFocalLengthPx, pixelDistanceToMm, unnormalizeToPixels, unprojectToMetricSpace } from './projection';

/**
 * Computes derived face measurements from a raw landmark set.
 *
 * @param landmarks    478-point normalized landmark array for one frame.
 * @param frameWidth   Source video frame width in pixels (to unnormalize).
 * @param frameHeight  Source video frame height in pixels (to unnormalize).
 * @param depthMm      Optional: estimated distance from camera to face in mm
 *                     (typically the z component of the decomposed head pose
 *                     translation). When provided, distance measurements are
 *                     converted to millimeters, and `noseBridgeMetric` is
 *                     properly back-projected; otherwise distances are left
 *                     in pixel units and `noseBridgeMetric` falls back to a
 *                     best-effort estimate at a nominal 1m depth.
 */
export function computeFaceMetrics(
  landmarks: FaceLandmarkList,
  frameWidth: number,
  frameHeight: number,
  depthMm?: number,
): FaceMetrics {
  const rightOuter = landmarks[idx.RIGHT_EYE_OUTER_CORNER];
  const rightInner = landmarks[idx.RIGHT_EYE_INNER_CORNER];
  const leftOuter = landmarks[idx.LEFT_EYE_OUTER_CORNER];
  const leftInner = landmarks[idx.LEFT_EYE_INNER_CORNER];
  const noseBridgePoint = landmarks[idx.NOSE_BRIDGE];
  const chinPoint = landmarks[idx.CHIN];
  const rightFaceEdge = landmarks[idx.RIGHT_FACE_EDGE];
  const leftFaceEdge = landmarks[idx.LEFT_FACE_EDGE];

  // Eye centers, kept in normalized landmark space — these serve as 3D
  // anchor references, not distance measurements, so no unit conversion needed.
  const rightEyeCenter = midpoint(rightOuter, rightInner);
  const leftEyeCenter = midpoint(leftOuter, leftInner);
  const eyeMidpoint = midpoint(leftEyeCenter, rightEyeCenter);

  // Pixel-space points, used only for distance math below.
  const rightEyeCenterPx = unnormalizeToPixels(rightEyeCenter, frameWidth, frameHeight);
  const leftEyeCenterPx = unnormalizeToPixels(leftEyeCenter, frameWidth, frameHeight);
  const rightFaceEdgePx = unnormalizeToPixels(rightFaceEdge, frameWidth, frameHeight);
  const leftFaceEdgePx = unnormalizeToPixels(leftFaceEdge, frameWidth, frameHeight);
  const noseBridgePx = unnormalizeToPixels(noseBridgePoint, frameWidth, frameHeight);
  const chinPx = unnormalizeToPixels(chinPoint, frameWidth, frameHeight);

  const ipdPx = distance(leftEyeCenterPx, rightEyeCenterPx);
  const faceWidthPx = distance(leftFaceEdgePx, rightFaceEdgePx);
  const faceHeightPx = distance(noseBridgePx, chinPx);

  const toFinalUnit = (px: number): number => {
    if (depthMm === undefined || depthMm <= 0) return px;
    const focalLengthPx = estimateFocalLengthPx(frameHeight);
    return pixelDistanceToMm(px, depthMm, focalLengthPx);
  };

  // See `unprojectToMetricSpace`'s doc comment: this is the anatomically
  // correct anchor point for glasses, distinct from (and more accurate than)
  // the whole-face transform's own origin. Falls back to a nominal 1m depth
  // if no real depth estimate is available yet (should be rare in practice).
  const noseBridgeMetric = unprojectToMetricSpace(
    noseBridgePoint,
    frameWidth,
    frameHeight,
    depthMm && depthMm > 0 ? depthMm : 1000,
  );

  const leftFaceEdgeMetric = unprojectToMetricSpace(
    leftFaceEdge,
    frameWidth,
    frameHeight,
    depthMm && depthMm > 0 ? depthMm : 1000,
  );

  const rightFaceEdgeMetric = unprojectToMetricSpace(
    rightFaceEdge,
    frameWidth,
    frameHeight,
    depthMm && depthMm > 0 ? depthMm : 1000,
  );

  return {
    interPupillaryDistance: toFinalUnit(ipdPx),
    faceWidth: toFinalUnit(faceWidthPx),
    faceHeight: toFinalUnit(faceHeightPx),
    leftEyeCenter,
    rightEyeCenter,
    eyeMidpoint,
    noseBridge: noseBridgePoint,
    noseBridgeMetric,
    leftFaceEdgeMetric,
    rightFaceEdgeMetric,
  };
}

