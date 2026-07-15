/**
 * OneEuroFilter.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Raw MediaPipe landmark positions have small-amplitude, high-frequency
 *   noise (sensor/model noise) that reads as visible jitter if applied
 *   directly to the glasses model. A naive fixed low-pass filter forces a
 *   trade-off: smooth enough to kill jitter, but that same smoothing then
 *   lags noticeably behind fast head turns. The One-Euro filter (Casiez,
 *   Roussel, Vogel — CHI 2012) solves this by adapting its cutoff frequency
 *   to the signal's own rate of change: still = heavy smoothing, moving
 *   fast = light smoothing. This is a well-established, small, dependency-free
 *   algorithm — ideal for this use case.
 *
 * WHAT IT DOES
 *   - `OneEuroFilter`: filters a single scalar stream.
 *   - `Vector3OneEuroFilter`: three independent `OneEuroFilter` instances
 *     (one per axis), exposed as a single `Vector3Like -> Vector3Like` filter.
 *   - Both reset cleanly (and safely) if the gap between samples exceeds
 *     `maxDtMs` — this is what happens when the face briefly leaves frame.
 *
 * HOW IT COMMUNICATES
 *   - `modules/frameManager/FrameManager.ts` owns one `Vector3OneEuroFilter`
 *     instance and feeds it `HeadPose.position` every tracked frame.
 *   - The filtered output flows into `CalibrationEngine` alongside the
 *     smoothed rotation from `QuaternionSmoother.ts`.
 * ---------------------------------------------------------------------------
 */

import type { OneEuroFilterConfig } from '../types/smoothing.types';
import type { Vector3Like } from '../types/math.types';

/** Sensible default for smoothing a head-position stream in millimeter-ish units. */
export const DEFAULT_POSITION_FILTER_CONFIG: OneEuroFilterConfig = {
  minCutoff: 1.0,
  beta: 0.3,
  dCutoff: 1.0,
  maxDtMs: 250,
};

/** Standard One-Euro smoothing-factor formula: converts a cutoff frequency + dt into a lerp alpha. */
export function smoothingAlpha(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/**
 * Filters one scalar signal. Stateful — call `filter()` once per new sample,
 * in strictly increasing timestamp order.
 */
export class OneEuroFilter {
  private config: OneEuroFilterConfig;
  private lastFilteredValue: number | null = null;
  private lastFilteredDerivative = 0;
  private lastTimestampMs: number | null = null;

  constructor(config: OneEuroFilterConfig = DEFAULT_POSITION_FILTER_CONFIG) {
    this.config = config;
  }

  /** Feeds a new raw sample and returns the filtered value. */
  filter(value: number, timestampMs: number): number {
    // First sample, or the previous sample is too old to trust a derivative from: pass through.
    if (
      this.lastTimestampMs === null ||
      this.lastFilteredValue === null ||
      timestampMs - this.lastTimestampMs <= 0 ||
      timestampMs - this.lastTimestampMs > this.config.maxDtMs
    ) {
      this.lastFilteredValue = value;
      this.lastFilteredDerivative = 0;
      this.lastTimestampMs = timestampMs;
      return value;
    }

    const dtSeconds = (timestampMs - this.lastTimestampMs) / 1000;

    // Stage 1: low-pass the derivative (rate of change) of the signal.
    const rawDerivative = (value - this.lastFilteredValue) / dtSeconds;
    const dAlpha = smoothingAlpha(this.config.dCutoff, dtSeconds);
    const filteredDerivative = dAlpha * rawDerivative + (1 - dAlpha) * this.lastFilteredDerivative;

    // Stage 2: adapt the cutoff frequency to how fast the signal is moving,
    // then low-pass the signal itself with that adaptive cutoff.
    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(filteredDerivative);
    const alpha = smoothingAlpha(cutoff, dtSeconds);
    const filteredValue = alpha * value + (1 - alpha) * this.lastFilteredValue;

    this.lastFilteredValue = filteredValue;
    this.lastFilteredDerivative = filteredDerivative;
    this.lastTimestampMs = timestampMs;

    return filteredValue;
  }

  /** Clears all internal state — call when tracking is lost/regained deliberately. */
  reset(): void {
    this.lastFilteredValue = null;
    this.lastFilteredDerivative = 0;
    this.lastTimestampMs = null;
  }
}

/**
 * Filters a `Vector3Like` stream by running an independent `OneEuroFilter`
 * per axis. Axes are independent because head-position noise/motion is not
 * meaningfully correlated across x/y/z for this use case.
 */
export class Vector3OneEuroFilter {
  private readonly xFilter: OneEuroFilter;
  private readonly yFilter: OneEuroFilter;
  private readonly zFilter: OneEuroFilter;

  constructor(config: OneEuroFilterConfig = DEFAULT_POSITION_FILTER_CONFIG) {
    this.xFilter = new OneEuroFilter(config);
    this.yFilter = new OneEuroFilter(config);
    this.zFilter = new OneEuroFilter(config);
  }

  filter(value: Vector3Like, timestampMs: number): Vector3Like {
    return {
      x: this.xFilter.filter(value.x, timestampMs),
      y: this.yFilter.filter(value.y, timestampMs),
      z: this.zFilter.filter(value.z, timestampMs),
    };
  }

  reset(): void {
    this.xFilter.reset();
    this.yFilter.reset();
    this.zFilter.reset();
  }
}
