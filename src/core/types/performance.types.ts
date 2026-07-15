/**
 * performance.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   "Maintain ~60 FPS" is a requirement, not a hope. We need a concrete,
 *   typed stats object that PerformanceMonitor produces so a DebugOverlay
 *   (or automated tests) can assert on it.
 *
 * WHAT IT DOES
 *   Declares `PerformanceStats`, the rolling-window telemetry snapshot.
 *
 * HOW IT COMMUNICATES
 *   - `modules/performance/PerformanceMonitor.ts` produces this each second.
 *   - `components/DebugOverlay.tsx` renders it; nothing else in the render
 *     path depends on it, so its updates never affect the 3D render loop.
 * ---------------------------------------------------------------------------
 */

export interface PerformanceStats {
  /** Smoothed frames-per-second of the R3F render loop. */
  renderFps: number;
  /** Smoothed frames-per-second of the MediaPipe detection loop (may differ from render FPS). */
  trackingFps: number;
  /** Rolling average detection latency in ms (video frame capture -> landmarks available). */
  detectionLatencyMs: number;
  /** Time spent in the render loop's JS per frame (ms), a proxy for main-thread pressure. */
  frameTimeMs: number;
  /** Timestamp this snapshot was produced. */
  sampledAtMs: number;
}
