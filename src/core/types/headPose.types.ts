/**
 * headPose.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Position and rotation of the head need to travel through a smoothing
 *   stage before they reach the renderer. Naming this shape explicitly keeps
 *   HeadPoseEstimator, the smoothing layer, and CalibrationEngine talking the
 *   same language.
 *
 * WHAT IT DOES
 *   Declares the `HeadPose` type: a position + quaternion + convenience Euler
 *   angles (for debug UI and for calibration rotation offsets which are
 *   authored in Euler degrees in the per-frame JSON).
 *
 * HOW IT COMMUNICATES
 *   - `modules/headPose/HeadPoseEstimator.ts` produces raw `HeadPose` each frame.
 *   - `core/smoothing/*` consumes and returns the same shape (smoothed).
 *   - `modules/calibration/CalibrationEngine.ts` consumes the smoothed pose.
 * ---------------------------------------------------------------------------
 */

import type { EulerAnglesLike, QuaternionLike, Vector3Like } from './math.types';

export interface HeadPose {
  /** Head position in MediaPipe's metric camera-space (roughly centimeters). */
  position: Vector3Like;
  /** Head rotation as a quaternion — the primary representation used for smoothing/rendering. */
  quaternion: QuaternionLike;
  /** Same rotation, decomposed to Euler angles (radians) for debug display and JSON offsets. */
  euler: EulerAnglesLike;
  /** Frame timestamp this pose corresponds to (ms), carried through for smoothing dt calculations. */
  timestampMs: number;
  /** Whether this pose is a genuine detection or a held-over/predicted value (face lost briefly). */
  isTracked: boolean;
}
