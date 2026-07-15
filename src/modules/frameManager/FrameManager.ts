/**
 * FrameManager.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   This is the orchestrator the whole architecture has been building
 *   toward: it owns one instance each of `MediaPipeService`, `FaceTracker`,
 *   `HeadPoseEstimator`, the two smoothing filters, and `CalibrationEngine`,
 *   and runs them in the correct order exactly once per video frame. It is
 *   deliberately 100% imperative — no React, no `setState` — because the
 *   60fps head-tracking loop must never trigger a React re-render. React's
 *   only job is to read `getLatestResult()` inside an R3F `useFrame`
 *   callback (which already runs outside React's render cycle) and mutate
 *   the glasses `Object3D` directly.
 *
 *   Detection is driven by `HTMLVideoElement.requestVideoFrameCallback`
 *   rather than `requestAnimationFrame`: it fires once per actual decoded
 *   video frame (so we never run MediaPipe twice on the same camera frame,
 *   wasting CPU) and provides a precise `mediaTime`, which is exactly the
 *   monotonically-increasing timestamp source the smoothing filters and
 *   MediaPipe's VIDEO mode require.
 *
 * WHAT IT DOES
 *   Per tick (`runDetectionTick`):
 *     1. `MediaPipeService.detectForVideo()` → raw `FaceLandmarkerFrame`.
 *     2. `HeadPoseEstimator.process()` → raw `HeadPose | null`.
 *     3. `FaceTracker.process()` → raw `FaceMetrics | null` (using the head
 *        pose's depth, when available, for millimeter-accurate metrics,
 *        including the back-projected `noseBridgeMetric` anchor point).
 *     4. Smooth the raw head QUATERNION (`QuaternionSmoother`) and,
 *        separately, the raw `noseBridgeMetric` position (its OWN
 *        `Vector3OneEuroFilter` instance — the whole-face `headPose.position`
 *        gets its own independent smoothing too, since it's still used for
 *        depth estimation and debug display, but `CalibrationEngine` anchors
 *        to the smoothed nose bridge, not the smoothed whole-face position).
 *     5. `CalibrationEngine.calibrate()` → final `TransformLike`, using the
 *        currently-selected frame's `CalibrationData`.
 *     6. Package everything into a `TrackingResult` and store it — read by
 *        whoever calls `getLatestResult()`.
 *
 * HOW IT COMMUNICATES
 *   - `hooks/useFrameLoop.ts` constructs one `FrameManager`, calls
 *     `start(videoElement)` once tracking should begin, and reads
 *     `getLatestResult()` inside its `useFrame` callback.
 *   - `hooks/useGlassesModel.ts` supplies the active frame's `CalibrationData`
 *     via `setActiveCalibration()` whenever the user switches frames.
 * ---------------------------------------------------------------------------
 */

import type { CalibrationData } from '../../core/types/calibration.types';
import type { TrackingResult, TrackingQuality } from '../../core/types/tracking.types';
import type { PoseSmoothingConfig } from '../../core/types/smoothing.types';
import { MediaPipeService, type MediaPipeServiceOptions } from '../mediapipe/MediaPipeService';
import { FaceTracker } from '../faceTracker/FaceTracker';
import { HeadPoseEstimator } from '../headPose/HeadPoseEstimator';
import { CalibrationEngine } from '../calibration/CalibrationEngine';
import {
  Vector3OneEuroFilter,
  DEFAULT_POSITION_FILTER_CONFIG,
} from '../../core/smoothing/OneEuroFilter';
import {
  QuaternionSmoother,
  DEFAULT_ROTATION_FILTER_CONFIG,
} from '../../core/smoothing/QuaternionSmoother';

export interface FrameManagerOptions {
  mediaPipeOptions?: MediaPipeServiceOptions;
  smoothingConfig?: PoseSmoothingConfig;
  /** Forwarded to FaceTracker/HeadPoseEstimator — see their own doc comments. */
  maxHeldFrames?: number;
}

const EMPTY_RESULT: TrackingResult = {
  quality: 'none',
  headPose: null,
  rawHeadPose: null,
  faceMetrics: null,
  glassesTransform: null,
  timestampMs: 0,
};

export class FrameManager {
  private readonly mediaPipeService: MediaPipeService;
  private readonly faceTracker: FaceTracker;
  private readonly headPoseEstimator: HeadPoseEstimator;
  private readonly calibrationEngine: CalibrationEngine;
  private readonly positionFilter: Vector3OneEuroFilter;
  private readonly rotationFilter: QuaternionSmoother;
  /**
   * Smooths `faceMetrics.noseBridgeMetric` — the actual glasses anchor point
   * used by `CalibrationEngine` — independently from `positionFilter` (which
   * still smooths the whole-face `headPose.position`, kept around for depth
   * estimation and debug display). Two separate signals, two separate
   * filter instances; using one filter for both would mix their dynamics.
   */
  private readonly noseBridgeFilter: Vector3OneEuroFilter;
  /**
   * The left/right face-edge (tragion/ear-area) metric points feed the
   * renderer's per-side temple ear-aiming (see modules/renderer/templeRig.ts).
   * Like the nose bridge, they go straight into a render transform, so they
   * get their own independent smoothing passes.
   */
  private readonly leftEarFilter: Vector3OneEuroFilter;
  private readonly rightEarFilter: Vector3OneEuroFilter;

  private activeCalibration: CalibrationData | null = null;
  private latestResult: TrackingResult = EMPTY_RESULT;
  private videoElement: HTMLVideoElement | null = null;
  private videoFrameCallbackHandle: number | null = null;
  private rafFallbackHandle: number | null = null;
  private running = false;

  constructor(options: FrameManagerOptions = {}) {
    this.mediaPipeService = new MediaPipeService(options.mediaPipeOptions);
    this.faceTracker = new FaceTracker({ maxHeldFrames: options.maxHeldFrames });
    this.headPoseEstimator = new HeadPoseEstimator({ maxHeldFrames: options.maxHeldFrames });
    this.calibrationEngine = new CalibrationEngine();

    const smoothing = options.smoothingConfig;
    this.positionFilter = new Vector3OneEuroFilter(smoothing?.position ?? DEFAULT_POSITION_FILTER_CONFIG);
    this.rotationFilter = new QuaternionSmoother(smoothing?.rotation ?? DEFAULT_ROTATION_FILTER_CONFIG);
    this.noseBridgeFilter = new Vector3OneEuroFilter(smoothing?.position ?? DEFAULT_POSITION_FILTER_CONFIG);
    this.leftEarFilter = new Vector3OneEuroFilter(smoothing?.position ?? DEFAULT_POSITION_FILTER_CONFIG);
    this.rightEarFilter = new Vector3OneEuroFilter(smoothing?.position ?? DEFAULT_POSITION_FILTER_CONFIG);
  }

  /** Loads the MediaPipe WASM runtime/model. Must resolve before `start()`. */
  async initialize(): Promise<void> {
    await this.mediaPipeService.initialize();
  }

  /** Sets (or clears, with `null`) the calibration data for the currently selected frame. */
  setActiveCalibration(calibration: CalibrationData | null): void {
    this.activeCalibration = calibration;
  }

  /** Starts the per-video-frame detection loop against the given video element. */
  start(video: HTMLVideoElement): void {
    if (this.running) return;
    if (!this.mediaPipeService.isReady()) {
      throw new Error('FrameManager.start() called before initialize() completed.');
    }
    this.videoElement = video;
    this.running = true;
    this.scheduleNextTick();
  }

  /** Stops the detection loop. Safe to call repeatedly. Does not dispose MediaPipe resources — see `dispose()`. */
  stop(): void {
    this.running = false;
    if (this.videoElement && this.videoFrameCallbackHandle !== null) {
      // `cancelVideoFrameCallback` exists on the same element type; guarded for environments without it.
      this.videoElement.cancelVideoFrameCallback?.(this.videoFrameCallbackHandle);
    }
    if (this.rafFallbackHandle !== null) {
      cancelAnimationFrame(this.rafFallbackHandle);
    }
    this.videoFrameCallbackHandle = null;
    this.rafFallbackHandle = null;
  }

  /** Full teardown: stops the loop, releases MediaPipe's WASM resources, resets tracking state. */
  dispose(): void {
    this.stop();
    this.mediaPipeService.dispose();
    this.faceTracker.reset();
    this.headPoseEstimator.reset();
    this.positionFilter.reset();
    this.rotationFilter.reset();
    this.noseBridgeFilter.reset();
    this.leftEarFilter.reset();
    this.rightEarFilter.reset();
    this.calibrationEngine.reset();
    this.latestResult = EMPTY_RESULT;
  }

  /** Reads the most recently computed tracking result. Safe to call every render frame — pure read, no computation. */
  getLatestResult(): TrackingResult {
    return this.latestResult;
  }

  private scheduleNextTick(): void {
    if (!this.running || !this.videoElement) return;

    if (typeof this.videoElement.requestVideoFrameCallback === 'function') {
      // Preferred path: fires once per actual decoded frame (not once per
      // display refresh), and hands us `mediaTime` — a precise, monotonic
      // timestamp tied to the video itself rather than the display clock.
      this.videoFrameCallbackHandle = this.videoElement.requestVideoFrameCallback((_now, metadata) => {
        this.runDetectionTick(metadata.mediaTime * 1000);
        this.scheduleNextTick();
      });
    } else {
      // Fallback for browsers without requestVideoFrameCallback support
      // (e.g. older Safari). Without this, calling the method above would
      // throw synchronously and silently kill the entire tracking loop with
      // no visible error — exactly the "glasses never appear" failure mode
      // this fallback exists to prevent. Slightly less precise (tied to
      // display refresh rather than decoded video frames) but functionally
      // equivalent, using performance.now() as the monotonic timestamp source.
      this.rafFallbackHandle = requestAnimationFrame(() => {
        this.runDetectionTick(performance.now());
        this.scheduleNextTick();
      });
    }
  }

  private runDetectionTick(timestampMs: number): void {
    if (!this.videoElement) return;

    const frame = this.mediaPipeService.detectForVideo(this.videoElement, timestampMs);
    const rawHeadPose = this.headPoseEstimator.process(frame);

    // Head depth (mm) feeds FaceTracker's pixel->mm conversion when available.
    const depthMm = rawHeadPose?.position.z !== undefined ? Math.abs(rawHeadPose.position.z) : undefined;
    const { metrics: faceMetrics, isTracked: faceIsTracked } = this.faceTracker.process(frame, depthMm);

    if (!rawHeadPose || !faceMetrics) {
      this.latestResult = {
        quality: 'none',
        headPose: null,
        rawHeadPose: rawHeadPose ?? null,
        faceMetrics: null,
        glassesTransform: null,
        timestampMs,
      };
      return;
    }

    const smoothedPosition = this.positionFilter.filter(rawHeadPose.position, timestampMs);
    const smoothedQuaternion = this.rotationFilter.filter(rawHeadPose.quaternion, timestampMs);
    const smoothedHeadPose = { ...rawHeadPose, position: smoothedPosition, quaternion: smoothedQuaternion };

    // The actual glasses anchor (see CalibrationEngine's header comment for
    // why this, not headPose.position, is the correct anchor) gets its own
    // independent smoothing pass — otherwise it would be raw/unsmoothed
    // per-frame data feeding directly into the render transform, reintroducing
    // exactly the jitter the whole smoothing layer exists to eliminate.
    const smoothedNoseBridge = this.noseBridgeFilter.filter(faceMetrics.noseBridgeMetric, timestampMs);
    const smoothedFaceMetrics = {
      ...faceMetrics,
      noseBridgeMetric: smoothedNoseBridge,
      leftFaceEdgeMetric: this.leftEarFilter.filter(faceMetrics.leftFaceEdgeMetric, timestampMs),
      rightFaceEdgeMetric: this.rightEarFilter.filter(faceMetrics.rightFaceEdgeMetric, timestampMs),
    };

    const glassesTransform = this.activeCalibration
      ? this.calibrationEngine.calibrate(smoothedHeadPose, smoothedFaceMetrics, this.activeCalibration)
      : null;

    const quality: TrackingQuality = rawHeadPose.isTracked && faceIsTracked ? 'good' : 'low';

    this.latestResult = {
      quality,
      headPose: smoothedHeadPose,
      rawHeadPose,
      faceMetrics: smoothedFaceMetrics,
      glassesTransform,
      timestampMs,
    };
  }
}
