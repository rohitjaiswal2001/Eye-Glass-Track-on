/**
 * smoothing.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Both the position filter (One-Euro) and the rotation filter (slerp-based
 *   analog) are tuned with the same three parameters from the One-Euro
 *   filter paper (Casiez et al., 2012): `minCutoff`, `beta`, `dCutoff`. Named
 *   here once so FrameManager/CalibrationEngine can expose them as a single
 *   tunable surface (and potentially a future debug-panel slider) instead of
 *   scattering magic numbers through the smoothing implementation.
 *
 * WHAT IT DOES
 *   Declares `OneEuroFilterConfig` and `PoseSmoothingConfig` (position +
 *   rotation configs bundled together, since they travel together through
 *   FrameManager).
 *
 * HOW IT COMMUNICATES
 *   - `core/smoothing/OneEuroFilter.ts` and `QuaternionSmoother.ts` accept
 *     `OneEuroFilterConfig`.
 *   - `modules/frameManager/FrameManager.ts` owns one `PoseSmoothingConfig`
 *     and constructs the two filter instances from it.
 * ---------------------------------------------------------------------------
 */

export interface OneEuroFilterConfig {
  /**
   * Minimum cutoff frequency (Hz). Lower = more smoothing when the signal is
   * nearly still, at the cost of more lag on slow movements. This is the
   * parameter to lower if you still see low-amplitude jitter when the user
   * holds still.
   */
  minCutoff: number;
  /**
   * Speed coefficient. Higher = cutoff frequency rises faster as the signal's
   * rate of change increases, meaning fast intentional motion is smoothed
   * less (less lag) while slow drift/jitter is smoothed more. This is the
   * parameter to raise if fast head turns feel laggy/rubbery.
   */
  beta: number;
  /** Cutoff frequency (Hz) for the derivative low-pass stage. Rarely needs tuning; 1.0 is standard. */
  dCutoff: number;
  /**
   * If the gap between two samples exceeds this (ms), the filter resets
   * instead of computing a derivative — prevents a huge, meaningless
   * "velocity" spike after the face is lost and reacquired.
   */
  maxDtMs: number;
}

/** Bundled smoothing configuration for a full head-pose stream (position + rotation). */
export interface PoseSmoothingConfig {
  position: OneEuroFilterConfig;
  rotation: OneEuroFilterConfig;
}
