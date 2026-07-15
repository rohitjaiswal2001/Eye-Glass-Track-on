/**
 * HeadPoseEstimator.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   This is the module that turns MediaPipe's raw 16-element
 *   `facialTransformationMatrix` into a usable `HeadPose` (position +
 *   quaternion + Euler). As per the architecture decision, we deliberately
 *   decompose MediaPipe's ready-made matrix (`core/math/matrix.ts`) instead
 *   of hand-rolling a PnP solver — it's the same information, already
 *   computed by a model trained specifically for this, and far more stable.
 *   Like `FaceTracker`, it also holds the last known pose across brief
 *   detection gaps so a single missed frame doesn't snap the glasses away.
 *
 * WHAT IT DOES
 *   `process(frame)`:
 *     - On a genuine detection with a transformation matrix present: decomposes
 *       it into position/quaternion, derives Euler angles for debug/logging,
 *       and returns `HeadPose` with `isTracked: true`.
 *     - On a miss (or a detection missing the matrix, which shouldn't happen
 *       once MediaPipeService is configured correctly, but is handled
 *       defensively): holds the last pose for up to `maxHeldFrames`, then
 *       returns `null`.
 *
 * CRITICAL UNIT NOTE — MediaPipe's translation is in CENTIMETERS
 *   MediaPipe's canonical face model — and therefore the translation
 *   component of `facialTransformationMatrix` — is defined in centimeters
 *   (confirmed by Google's official "MediaPipe 3D Face Transform" post:
 *   "A metric unit used by the default canonical face model is a
 *   centimeter"). The rest of this codebase (calibration JSON offsets,
 *   `CalibrationEngine`'s mm→scene-unit conversion) is authored in
 *   millimeters for intuitive tuning. This is the ONE place that needs to
 *   know MediaPipe's specific unit convention — we convert cm→mm right here,
 *   at the boundary, so every module downstream (FaceTracker's depth input,
 *   CalibrationEngine's position math) can consistently assume millimeters
 *   without needing to know or care where the raw pose came from. Getting
 *   this wrong doesn't just mis-scale the glasses — a 10x-too-small position
 *   can land the glasses inside the camera's near-clipping plane, making
 *   them invisible even though tracking itself is working correctly.
 *
 * HOW IT COMMUNICATES
 *   - `modules/frameManager/FrameManager.ts` owns one instance and calls
 *     `process()` once per `MediaPipeService.detectForVideo()` result.
 *   - Output (`HeadPose | null`) flows into `core/smoothing/*` and then
 *     `CalibrationEngine`.
 * ---------------------------------------------------------------------------
 */

import type { FaceLandmarkerFrame } from '../../core/types/landmarks.types';
import type { HeadPose } from '../../core/types/headPose.types';
import { decomposeMatrix4 } from '../../core/math/matrix';
import { toEulerYXZ } from '../../core/math/quaternion';
import { scale as scaleVec3 } from '../../core/math/vector3';

export interface HeadPoseEstimatorOptions {
  /** Same rationale as `FaceTracker`'s option — see that file's doc comment. */
  maxHeldFrames?: number;
}

const DEFAULT_MAX_HELD_FRAMES = 5;

/** See the file header's "CRITICAL UNIT NOTE" — MediaPipe's canonical face model uses centimeters. */
const MEDIAPIPE_CM_TO_MM = 10;

export class HeadPoseEstimator {
  private readonly maxHeldFrames: number;
  private lastPose: HeadPose | null = null;
  private missedFrameCount = 0;

  constructor(options: HeadPoseEstimatorOptions = {}) {
    this.maxHeldFrames = options.maxHeldFrames ?? DEFAULT_MAX_HELD_FRAMES;
  }

  process(frame: FaceLandmarkerFrame): HeadPose | null {
    if (frame.faceDetected && frame.facialTransformationMatrix) {
      this.missedFrameCount = 0;
      const decomposed = decomposeMatrix4(frame.facialTransformationMatrix);
      const position = scaleVec3(decomposed.position, MEDIAPIPE_CM_TO_MM);
      const euler = toEulerYXZ(decomposed.quaternion);

      this.lastPose = {
        position,
        quaternion: decomposed.quaternion,
        euler,
        timestampMs: frame.timestampMs,
        isTracked: true,
      };
      return this.lastPose;
    }

    this.missedFrameCount += 1;
    if (this.lastPose !== null && this.missedFrameCount <= this.maxHeldFrames) {
      // Held pose: same spatial data, updated timestamp, flagged as not freshly tracked.
      return { ...this.lastPose, timestampMs: frame.timestampMs, isTracked: false };
    }

    this.lastPose = null;
    return null;
  }

  /** Clears held state — call when deliberately switching users/sessions. */
  reset(): void {
    this.lastPose = null;
    this.missedFrameCount = 0;
  }
}
