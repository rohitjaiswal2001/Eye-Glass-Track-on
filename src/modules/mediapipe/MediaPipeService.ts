/**
 * MediaPipeService.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   `@mediapipe/tasks-vision`'s `FaceLandmarker` has real setup cost (WASM
 *   runtime + model download), a synchronous per-frame call convention tied
 *   to strictly increasing timestamps, and a raw result shape we don't want
 *   leaking into the rest of the app (see `landmarks.types.ts`). This class
 *   is the ONLY place that imports `@mediapipe/tasks-vision` directly.
 *
 * WHAT IT DOES
 *   - `initialize()`: loads the WASM fileset and creates the `FaceLandmarker`
 *     configured for VIDEO mode with blendshapes and the facial
 *     transformation matrix both enabled (the latter is what lets
 *     `HeadPoseEstimator` skip a hand-rolled PnP solve).
 *   - `detectForVideo(video, timestampMs)`: runs detection on the current
 *     video frame and returns our normalized `FaceLandmarkerFrame` type.
 *   - `dispose()`: releases the WASM/model resources.
 *
 * HOW IT COMMUNICATES
 *   - `modules/frameManager/FrameManager.ts` owns one instance, calls
 *     `initialize()` once, then calls `detectForVideo()` once per
 *     `requestVideoFrameCallback` tick using `CameraManager`'s shared video
 *     element — decoupled from React's render cycle for performance.
 *   - Output (`FaceLandmarkerFrame`) flows to `FaceTracker` and
 *     `HeadPoseEstimator`.
 * ---------------------------------------------------------------------------
 */

import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { BlendshapeScore, FaceLandmarkerFrame } from '../../core/types/landmarks.types';

export interface MediaPipeServiceOptions {
  /**
   * Base path/URL for the tasks-vision WASM fileset. Defaults to jsDelivr's
   * CDN build matching the installed package version. For production,
   * consider self-hosting this under `/public/wasm` to avoid a third-party
   * runtime dependency at page-load time.
   */
  wasmBasePath?: string;
  /**
   * Path/URL to the `face_landmarker.task` model asset. Defaults to
   * Google's model CDN. For production, self-host under `/public/models`.
   */
  modelAssetPath?: string;
  /** Max simultaneous faces to track. This app only ever uses the first. */
  numFaces?: number;
  /** 'GPU' is faster where WebGL is available; falls back gracefully is NOT automatic — set 'CPU' if you see GPU delegate errors on a target device. */
  delegate?: 'CPU' | 'GPU';
}

const DEFAULT_OPTIONS: Required<MediaPipeServiceOptions> = {
  wasmBasePath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  modelAssetPath:
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  numFaces: 1,
  delegate: 'GPU',
};

export class MediaPipeService {
  private readonly options: Required<MediaPipeServiceOptions>;
  private landmarker: FaceLandmarker | null = null;
  private initPromise: Promise<void> | null = null;
  /**
   * Same StrictMode-safety rationale as `CameraManager`'s `generation` field
   * — see that file's doc comment. If `dispose()` (or a newer `initialize()`)
   * runs while a previous `initialize()` call is still awaiting the WASM
   * fileset/model download, the stale result must be discarded (and its
   * now-unwanted `FaceLandmarker` closed) instead of being assigned.
   */
  private generation = 0;

  constructor(options: MediaPipeServiceOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** True once the WASM runtime + model are loaded and `detectForVideo` is safe to call. */
  isReady(): boolean {
    return this.landmarker !== null;
  }

  /**
   * Loads the WASM runtime and model. Safe to call multiple times — later
   * calls await the same in-flight promise rather than re-initializing.
   */
  async initialize(): Promise<void> {
    if (this.landmarker) return;
    if (!this.initPromise) {
      const generation = ++this.generation;
      this.initPromise = this.doInitialize(generation);
    }
    return this.initPromise;
  }

  private async doInitialize(generation: number): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(this.options.wasmBasePath);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: this.options.modelAssetPath,
        delegate: this.options.delegate,
      },
      runningMode: 'VIDEO',
      numFaces: this.options.numFaces,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

    if (generation !== this.generation) {
      // dispose() (or a newer initialize()) happened while we were loading —
      // this result is stale. Close it immediately rather than leaving an
      // orphaned FaceLandmarker instance holding WASM/GPU resources.
      landmarker.close();
      return;
    }

    this.landmarker = landmarker;
  }

  /**
   * Runs face landmark detection on the current frame of `video`.
   *
   * IMPORTANT: `timestampMs` must be strictly increasing across calls (a
   * VIDEO-mode requirement of the underlying SDK) — pass the same timestamp
   * source consistently (e.g. `performance.now()` or the video frame
   * callback's `mediaTime * 1000`).
   */
  detectForVideo(video: HTMLVideoElement, timestampMs: number): FaceLandmarkerFrame {
    if (!this.landmarker) {
      throw new Error('MediaPipeService.detectForVideo() called before initialize() completed.');
    }
    const result = this.landmarker.detectForVideo(video, timestampMs);
    return this.toFaceLandmarkerFrame(result, timestampMs, video.videoWidth, video.videoHeight);
  }

  private toFaceLandmarkerFrame(
    result: FaceLandmarkerResult,
    timestampMs: number,
    frameWidth: number,
    frameHeight: number,
  ): FaceLandmarkerFrame {
    const faceDetected = result.faceLandmarks.length > 0;

    if (!faceDetected) {
      return {
        timestampMs,
        faceDetected: false,
        landmarks: [],
        facialTransformationMatrix: null,
        blendshapes: [],
        frameWidth,
        frameHeight,
      };
    }

    const landmarks = result.faceLandmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z }));

    const matrix = result.facialTransformationMatrixes?.[0];
    const facialTransformationMatrix = matrix ? Float32Array.from(matrix.data) : null;

    const blendshapeClassification = result.faceBlendshapes?.[0];
    const blendshapes: BlendshapeScore[] = blendshapeClassification
      ? blendshapeClassification.categories.map((c) => ({ categoryName: c.categoryName, score: c.score }))
      : [];

    return {
      timestampMs,
      faceDetected: true,
      landmarks,
      facialTransformationMatrix,
      blendshapes,
      frameWidth,
      frameHeight,
    };
  }

  /** Releases the WASM/model resources. Call on final app teardown. */
  dispose(): void {
    this.generation++; // invalidates any in-flight initialize() call's pending continuation
    this.landmarker?.close();
    this.landmarker = null;
    this.initPromise = null;
  }
}
