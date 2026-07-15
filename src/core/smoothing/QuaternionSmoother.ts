/**
 * QuaternionSmoother.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   You cannot low-pass filter quaternion *components* independently
 *   (`alpha*q1 + (1-alpha)*q2` per-component) the way `OneEuroFilter` does
 *   for position — the result isn't a valid rotation and doesn't interpolate
 *   along the shortest arc, which reintroduces exactly the kind of visible
 *   snapping/wobble we're trying to eliminate. The mathematically correct
 *   analog of "exponential smoothing" in rotation space is `slerp` between
 *   the previous smoothed orientation and the new raw one. This class
 *   applies the same adaptive-cutoff idea as the One-Euro filter, but uses
 *   slerp as its smoothing primitive and angular speed (rad/s) as its
 *   "derivative" signal instead of a per-component delta.
 *
 * WHAT IT DOES
 *   `QuaternionSmoother.filter(rawQuaternion, timestampMs)`:
 *     1. Measures angular velocity between the previous smoothed orientation
 *        and the new raw one.
 *     2. Low-passes that velocity (stage 1, same as OneEuroFilter).
 *     3. Uses it to compute an adaptive slerp factor: fast head turns get a
 *        slerp factor close to 1 (track closely, low lag); a still face gets
 *        a slerp factor close to `rotation.minCutoff`'s implied alpha (heavy
 *        smoothing, kills tremor/jitter).
 *
 * HOW IT COMMUNICATES
 *   - `modules/frameManager/FrameManager.ts` owns one instance and feeds it
 *     `HeadPose.quaternion` every tracked frame.
 *   - Output flows into `CalibrationEngine` alongside the smoothed position
 *     from `Vector3OneEuroFilter`.
 * ---------------------------------------------------------------------------
 */

import type { OneEuroFilterConfig } from '../types/smoothing.types';
import type { QuaternionLike } from '../types/math.types';
import { angleBetween, normalizeQuaternion, slerp } from '../math/quaternion';
import { smoothingAlpha } from './OneEuroFilter';

/** Sensible default for smoothing head rotation. `beta` is scaled for radians/sec input. */
export const DEFAULT_ROTATION_FILTER_CONFIG: OneEuroFilterConfig = {
  minCutoff: 1.0,
  beta: 0.5,
  dCutoff: 1.0,
  maxDtMs: 250,
};

export class QuaternionSmoother {
  private readonly config: OneEuroFilterConfig;
  private lastSmoothed: QuaternionLike | null = null;
  private lastAngularVelocity = 0; // radians/second, low-passed
  private lastTimestampMs: number | null = null;

  constructor(config: OneEuroFilterConfig = DEFAULT_ROTATION_FILTER_CONFIG) {
    this.config = config;
  }

  /** Feeds a new raw orientation sample and returns the smoothed orientation. */
  filter(rawQuaternion: QuaternionLike, timestampMs: number): QuaternionLike {
    const raw = normalizeQuaternion(rawQuaternion);

    // First sample, or gap too large to trust an angular-velocity estimate: pass through.
    if (
      this.lastTimestampMs === null ||
      this.lastSmoothed === null ||
      timestampMs - this.lastTimestampMs <= 0 ||
      timestampMs - this.lastTimestampMs > this.config.maxDtMs
    ) {
      this.lastSmoothed = raw;
      this.lastAngularVelocity = 0;
      this.lastTimestampMs = timestampMs;
      return raw;
    }

    const dtSeconds = (timestampMs - this.lastTimestampMs) / 1000;

    // Stage 1: low-pass the angular velocity between the last smoothed pose and this new raw one.
    const rawAngularVelocity = angleBetween(this.lastSmoothed, raw) / dtSeconds;
    const dAlpha = smoothingAlpha(this.config.dCutoff, dtSeconds);
    const filteredAngularVelocity = dAlpha * rawAngularVelocity + (1 - dAlpha) * this.lastAngularVelocity;

    // Stage 2: adapt the cutoff (and thus the slerp factor) to the angular velocity.
    const cutoff = this.config.minCutoff + this.config.beta * filteredAngularVelocity;
    const alpha = smoothingAlpha(cutoff, dtSeconds);

    const smoothed = slerp(this.lastSmoothed, raw, alpha);

    this.lastSmoothed = smoothed;
    this.lastAngularVelocity = filteredAngularVelocity;
    this.lastTimestampMs = timestampMs;

    return smoothed;
  }

  /** Clears all internal state — call when tracking is lost/regained deliberately. */
  reset(): void {
    this.lastSmoothed = null;
    this.lastAngularVelocity = 0;
    this.lastTimestampMs = null;
  }
}
