/**
 * tracking.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   FrameManager orchestrates several modules per tick (FaceTracker,
 *   HeadPoseEstimator, smoothing, CalibrationEngine). Rather than passing
 *   five separate arguments around, we bundle the per-frame pipeline state
 *   into one typed object that's easy to log, test, and hand to the renderer.
 *
 * WHAT IT DOES
 *   Declares `TrackingResult`, the single object FrameManager emits once per
 *   render tick, and `TrackingQuality`, a coarse confidence signal used to
 *   decide whether to show/hide the glasses model.
 *
 * HOW IT COMMUNICATES
 *   - `modules/frameManager/FrameManager.ts` produces `TrackingResult`.
 *   - `hooks/useFrameLoop.ts` reads it via a ref (not React state) inside the
 *     R3F `useFrame` callback and imperatively updates the glasses Object3D.
 * ---------------------------------------------------------------------------
 */

import type { FaceMetrics } from './faceMetrics.types';
import type { HeadPose } from './headPose.types';
import type { TransformLike } from './math.types';

export type TrackingQuality = 'none' | 'low' | 'good';

export interface TrackingResult {
  quality: TrackingQuality;
  headPose: HeadPose | null;
  /**
   * The pre-smoothing head pose (straight out of `HeadPoseEstimator`, before
   * `core/smoothing/*` runs). Exposed alongside the smoothed `headPose`
   * purely for debugging/visibility — e.g. `DebugOverlay` can show both side
   * by side to make the smoothing filters' effect visible rather than a
   * black box. `CalibrationEngine` and the renderer should always use the
   * smoothed `headPose`, never this one.
   */
  rawHeadPose: HeadPose | null;
  faceMetrics: FaceMetrics | null;
  /** The final, smoothed, calibrated transform ready to apply to the glasses Object3D. */
  glassesTransform: TransformLike | null;
  timestampMs: number;
}
