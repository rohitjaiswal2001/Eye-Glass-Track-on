/**
 * FaceTracker.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   `computeFaceMetrics` (core/math) is a pure, stateless function — it has
 *   no opinion about what happens when the face briefly leaves frame (hand
 *   passing in front, fast head turn past ±90°, etc). Without some state,
 *   a single missed frame would make the glasses vanish/flicker every time
 *   detection has a momentary gap, which reads as broken rather than robust.
 *   FaceTracker adds a small, deliberate "hold last known good value" policy
 *   on top of the pure math.
 *
 * WHAT IT DOES
 *   `process(frame, depthMm?)`:
 *     - On a genuine detection: computes fresh `FaceMetrics` and returns them
 *       with `isTracked: true`.
 *     - On a miss: returns the last known metrics (unchanged) with
 *       `isTracked: false`, for up to `maxHeldFrames` consecutive misses.
 *     - After too many consecutive misses: returns `null` (glasses should
 *       hide — the face is genuinely gone, not just a blip).
 *
 * HOW IT COMMUNICATES
 *   - `modules/frameManager/FrameManager.ts` owns one instance and calls
 *     `process()` once per `MediaPipeService.detectForVideo()` result.
 *   - Output (`FaceMetrics | null`) flows into `CalibrationEngine`.
 * ---------------------------------------------------------------------------
 */

import type { FaceLandmarkerFrame } from '../../core/types/landmarks.types';
import type { FaceMetrics } from '../../core/types/faceMetrics.types';
import { computeFaceMetrics } from '../../core/math/faceMetrics';

export interface FaceTrackerOptions {
  /**
   * How many consecutive missed frames to keep serving the last known good
   * metrics before reporting `null` (face genuinely lost). At ~60fps, 5
   * frames is well under 100ms — long enough to ride out a blink-length
   * detection blip, short enough that a real face-away transition still
   * hides the glasses promptly.
   */
  maxHeldFrames?: number;
}

export interface FaceTrackerResult {
  metrics: FaceMetrics | null;
  /** True only on frames where MediaPipe genuinely detected a face this tick. */
  isTracked: boolean;
}

const DEFAULT_MAX_HELD_FRAMES = 5;

export class FaceTracker {
  private readonly maxHeldFrames: number;
  private lastMetrics: FaceMetrics | null = null;
  private missedFrameCount = 0;

  constructor(options: FaceTrackerOptions = {}) {
    this.maxHeldFrames = options.maxHeldFrames ?? DEFAULT_MAX_HELD_FRAMES;
  }

  /**
   * @param frame    The latest detection frame from MediaPipeService.
   * @param depthMm  Optional estimated camera-to-face distance (mm), passed
   *                 through to `computeFaceMetrics` for millimeter-accurate
   *                 output. Typically `headPose.position.z` from the same tick.
   */
  process(frame: FaceLandmarkerFrame, depthMm?: number): FaceTrackerResult {
    if (frame.faceDetected && frame.landmarks.length > 0) {
      this.missedFrameCount = 0;
      this.lastMetrics = computeFaceMetrics(frame.landmarks, frame.frameWidth, frame.frameHeight, depthMm);
      return { metrics: this.lastMetrics, isTracked: true };
    }

    this.missedFrameCount += 1;
    if (this.lastMetrics !== null && this.missedFrameCount <= this.maxHeldFrames) {
      return { metrics: this.lastMetrics, isTracked: false };
    }

    this.lastMetrics = null;
    return { metrics: null, isTracked: false };
  }

  /** Clears held state — call when deliberately switching users/sessions. */
  reset(): void {
    this.lastMetrics = null;
    this.missedFrameCount = 0;
  }
}
