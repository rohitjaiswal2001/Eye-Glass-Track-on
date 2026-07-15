/**
 * PerformanceMonitor.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   "Maintain ~60 FPS" is a stated requirement, not an assumption — this
 *   module is what makes that measurable and debuggable in production,
 *   rather than something only checked informally during development. It's
 *   also what a `DebugOverlay` reads to show live FPS/latency numbers.
 *
 * WHAT IT DOES
 *   Maintains two independent rolling ~1-second windows (configurable):
 *     - Render loop: call `recordRenderFrame(timestampMs)` once per R3F
 *       `useFrame` tick. Tracks render FPS and average frame time.
 *     - Detection loop: call `recordDetectionFrame(timestampMs, latencyMs)`
 *       once per `FrameManager` detection tick. Tracks tracking FPS and
 *       average detection latency (these can legitimately differ from
 *       render FPS — MediaPipe runs once per decoded camera frame, the
 *       render loop runs once per display refresh).
 *   `getStats()` is a cheap, allocation-free read of the last completed
 *   window's snapshot — safe to call every frame without adding overhead.
 *
 * HOW IT COMMUNICATES
 *   - `hooks/useFrameLoop.ts` (or `FrameManager` itself) calls
 *     `recordDetectionFrame` each tick; `GlassesScene`'s `useFrame` callback
 *     calls `recordRenderFrame`.
 *   - `components/DebugOverlay.tsx` polls `getStats()` on its own
 *     low-frequency timer (like `useFaceTracking` does for tracking
 *     quality), never inside the hot render path.
 * ---------------------------------------------------------------------------
 */

import type { PerformanceStats } from '../../core/types/performance.types';

const DEFAULT_WINDOW_MS = 1000;

const EMPTY_STATS: PerformanceStats = {
  renderFps: 0,
  trackingFps: 0,
  detectionLatencyMs: 0,
  frameTimeMs: 0,
  sampledAtMs: 0,
};

export class PerformanceMonitor {
  private readonly windowMs: number;

  private renderFrameCount = 0;
  private renderWindowStartMs = 0;
  private lastRenderTimestampMs = 0;
  private renderFrameTimeAccumMs = 0;

  private detectionFrameCount = 0;
  private detectionWindowStartMs = 0;
  private detectionLatencyAccumMs = 0;

  private latestStats: PerformanceStats = { ...EMPTY_STATS };

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Call once per render-loop tick (e.g. inside an R3F `useFrame` callback). */
  recordRenderFrame(timestampMs: number): void {
    if (this.renderWindowStartMs === 0) {
      this.renderWindowStartMs = timestampMs;
      this.lastRenderTimestampMs = timestampMs;
      return;
    }

    this.renderFrameTimeAccumMs += timestampMs - this.lastRenderTimestampMs;
    this.lastRenderTimestampMs = timestampMs;
    this.renderFrameCount += 1;

    if (timestampMs - this.renderWindowStartMs >= this.windowMs) {
      this.flushRenderWindow(timestampMs);
    }
  }

  /** Call once per detection-loop tick, with how long that tick's detection work took (ms). */
  recordDetectionFrame(timestampMs: number, detectionLatencyMs: number): void {
    if (this.detectionWindowStartMs === 0) {
      this.detectionWindowStartMs = timestampMs;
    }

    this.detectionFrameCount += 1;
    this.detectionLatencyAccumMs += detectionLatencyMs;

    if (timestampMs - this.detectionWindowStartMs >= this.windowMs) {
      this.flushDetectionWindow(timestampMs);
    }
  }

  private flushRenderWindow(timestampMs: number): void {
    const elapsedSeconds = (timestampMs - this.renderWindowStartMs) / 1000;
    const renderFps = elapsedSeconds > 0 ? this.renderFrameCount / elapsedSeconds : 0;
    const frameTimeMs = this.renderFrameCount > 0 ? this.renderFrameTimeAccumMs / this.renderFrameCount : 0;

    this.latestStats = { ...this.latestStats, renderFps, frameTimeMs, sampledAtMs: timestampMs };

    this.renderFrameCount = 0;
    this.renderFrameTimeAccumMs = 0;
    this.renderWindowStartMs = timestampMs;
  }

  private flushDetectionWindow(timestampMs: number): void {
    const elapsedSeconds = (timestampMs - this.detectionWindowStartMs) / 1000;
    const trackingFps = elapsedSeconds > 0 ? this.detectionFrameCount / elapsedSeconds : 0;
    const detectionLatencyMs =
      this.detectionFrameCount > 0 ? this.detectionLatencyAccumMs / this.detectionFrameCount : 0;

    this.latestStats = { ...this.latestStats, trackingFps, detectionLatencyMs, sampledAtMs: timestampMs };

    this.detectionFrameCount = 0;
    this.detectionLatencyAccumMs = 0;
    this.detectionWindowStartMs = timestampMs;
  }

  /** Cheap, allocation-free read of the most recent completed window's stats. */
  getStats(): PerformanceStats {
    return this.latestStats;
  }

  reset(): void {
    this.renderFrameCount = 0;
    this.renderWindowStartMs = 0;
    this.lastRenderTimestampMs = 0;
    this.renderFrameTimeAccumMs = 0;
    this.detectionFrameCount = 0;
    this.detectionWindowStartMs = 0;
    this.detectionLatencyAccumMs = 0;
    this.latestStats = { ...EMPTY_STATS };
  }
}
