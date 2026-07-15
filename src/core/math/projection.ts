/**
 * projection.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Face landmarks come back in *normalized image space* (x,y in [0,1]).
 *   A pixel distance means nothing in millimeters until you account for how
 *   far the face is from the camera and the camera's field of view — this
 *   is basic pinhole-camera projection math. `CalibrationEngine` needs a
 *   real millimeter estimate of the user's IPD/face-width to compare against
 *   a frame's `frameWidth`/`bridgeWidth` (also in millimeters).
 *
 * WHAT IT DOES
 *   - Unnormalizes a landmark point into pixel space.
 *   - Estimates a webcam's effective focal length in pixels from image width
 *     and an assumed field of view (webcams don't expose real intrinsics via
 *     the browser, so a reasonable default FOV is used; this can later be
 *     refined by `CalibrationEngine`'s optional user-guided calibration step).
 *   - Converts a pixel-space distance at a given depth into millimeters
 *     (inverse pinhole projection: real = pixel * depth / focalLengthPx).
 *
 * HOW IT COMMUNICATES
 *   `core/math/faceMetrics.ts` calls these helpers when a head-pose depth
 *   value is available, to produce millimeter-scale `FaceMetrics` instead of
 *   unitless normalized ones.
 * ---------------------------------------------------------------------------
 */

import type { Point3D, Vector3Like } from '../types/math.types';

/**
 * MediaPipe's own default virtual camera for its face-geometry metric space
 * uses a 63° vertical FOV (confirmed via MediaPipe's
 * `FaceGeometryEnvGeneratorCalculatorOptions` default: `vertical_fov_degrees:
 * 63.0`). Matching this exactly matters more than it might seem: MediaPipe's
 * facialTransformationMatrix is a RIGID transform (rotation + translation,
 * no baked-in scale) that encodes a user's actual face size via estimated
 * DEPTH rather than a scale factor — so a virtual object rendered through a
 * camera with the SAME assumed FOV will reproduce the correct apparent size
 * automatically. A mismatched FOV assumption breaks that relationship and
 * makes tracked objects appear the wrong size even though tracking itself
 * is accurate.
 */
export const DEFAULT_VERTICAL_FOV_DEGREES = 63;

/** Converts a normalized landmark point ([0,1] range) into pixel-space coordinates. */
export function unnormalizeToPixels(point: Point3D, frameWidth: number, frameHeight: number): Vector3Like {
  return {
    x: point.x * frameWidth,
    y: point.y * frameHeight,
    // MediaPipe's normalized z is roughly in the same scale as x (proportional to frame width).
    z: point.z * frameWidth,
  };
}

/**
 * Estimates the camera's effective vertical focal length in pixels, using
 * the standard pinhole relationship:
 *   focalLengthPx = (frameHeight / 2) / tan(verticalFovRadians / 2)
 */
export function estimateFocalLengthPx(
  frameHeight: number,
  verticalFovDegrees: number = DEFAULT_VERTICAL_FOV_DEGREES,
): number {
  const verticalFovRadians = (verticalFovDegrees * Math.PI) / 180;
  return frameHeight / 2 / Math.tan(verticalFovRadians / 2);
}

/**
 * Converts a pixel-space distance into an estimated real-world distance
 * (millimeters), given the subject's depth from the camera and the camera's
 * focal length in pixels.
 *
 * `depthMm` should be a positive distance from the camera to the face
 * (e.g. derived from the z/translation component of the decomposed
 * `facialTransformationMatrix`, converted to millimeters).
 */
export function pixelDistanceToMm(pixelDistance: number, depthMm: number, focalLengthPx: number): number {
  if (focalLengthPx <= 0) return 0;
  return (pixelDistance * depthMm) / focalLengthPx;
}

/**
 * Back-projects a single normalized landmark (e.g. the nose bridge) into a
 * full 3D position in the SAME metric camera-space that
 * `HeadPoseEstimator`'s decomposed `headPose.position` lives in (mm, camera
 * at origin looking down -Z, +Y up, +X right).
 *
 * WHY THIS EXISTS: `headPose.position` is MediaPipe's whole-face rigid-fit
 * origin — a Procrustes best-fit point across all 468 landmarks, which is
 * NOT the same as "where the nose bridge is." Empirically (and by
 * construction — the fit weights the whole mesh, which extends further
 * below the eyes toward the chin/jaw than above toward the forehead) this
 * origin sits measurably below eye level. For anchoring glasses, the nose
 * bridge landmark itself is the anatomically correct reference point — this
 * function is what makes it usable in the same units/space as the rest of
 * the pipeline, via standard inverse-pinhole projection:
 *   worldX = (pixelX - frameWidth/2)  * depth / focalLengthPx
 *   worldY = -(pixelY - frameHeight/2) * depth / focalLengthPx   (image Y grows
 *            downward; world Y grows upward, hence the negation)
 *   worldZ = -depth                                              (in front of
 *            the camera, which looks down -Z)
 *
 * @param normalizedPoint  A landmark in MediaPipe's normalized [0,1] space (e.g. `faceMetrics`'s raw nose bridge point).
 * @param frameWidth       Source video frame width in pixels.
 * @param frameHeight      Source video frame height in pixels.
 * @param depthMm          Estimated camera-to-point distance (mm) — typically reused from `headPose.position.z`, since the nose bridge sits close to the face's overall depth.
 * @param verticalFovDegrees  MUST match the same assumption used for `RendererCore`'s camera — see `DEFAULT_VERTICAL_FOV_DEGREES`'s doc comment.
 */
export function unprojectToMetricSpace(
  normalizedPoint: Point3D,
  frameWidth: number,
  frameHeight: number,
  depthMm: number,
  verticalFovDegrees: number = DEFAULT_VERTICAL_FOV_DEGREES,
): Vector3Like {
  const focalLengthPx = estimateFocalLengthPx(frameHeight, verticalFovDegrees);
  if (focalLengthPx <= 0) return { x: 0, y: 0, z: -depthMm };

  const pixelX = normalizedPoint.x * frameWidth;
  const pixelY = normalizedPoint.y * frameHeight;
  const offsetXPx = pixelX - frameWidth / 2;
  const offsetYPx = pixelY - frameHeight / 2;

  return {
    x: (offsetXPx * depthMm) / focalLengthPx,
    y: (-offsetYPx * depthMm) / focalLengthPx,
    z: -depthMm - (normalizedPoint.z * frameWidth * depthMm) / focalLengthPx,
  };
}

