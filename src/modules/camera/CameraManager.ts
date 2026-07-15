/**
 * CameraManager.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Camera access is the entry point of the whole app, and it's inherently
 *   stateful/asynchronous (permission prompt, device errors, stream
 *   lifecycle) in a way that doesn't belong inside a React component body.
 *   Isolating it here means:
 *     - There is exactly ONE `<video>` element and ONE `MediaStream` for the
 *       whole app, shared by both `MediaPipeService` (for landmark detection)
 *       and the on-screen webcam layer (for the visual background) — no
 *       duplicate camera opens, no duplicate decode cost.
 *     - The permission/error state machine is unit-testable independent of
 *       React or the DOM (see `classifyGetUserMediaError`, a pure function).
 *
 * WHAT IT DOES
 *   - `start()`: requests camera permission, opens a stream matching
 *     `CameraConfig`, attaches it to an internally-owned `<video>` element,
 *     and waits until the video actually has decodable frames before
 *     reporting `status: 'streaming'`.
 *   - `stop()`: stops all tracks and detaches the stream (call on unmount to
 *     release the camera light / hardware).
 *   - `subscribe(listener)`: a plain pub/sub so `useCamera` (a React hook) can
 *     mirror `CameraState` into component state without CameraManager itself
 *     depending on React.
 *   - `getVideoElement()`: exposes the single shared `<video>` element so
 *     `MediaPipeService` can read frames from it and the webcam UI layer can
 *     render it.
 *
 * HOW IT COMMUNICATES
 *   - `hooks/useCamera.ts` constructs one `CameraManager`, calls `start()`
 *     on mount and `stop()`/`dispose()` on unmount, and subscribes for state.
 *   - `modules/mediapipe/MediaPipeService.ts` receives the shared video
 *     element (via `getVideoElement()`) as its detection source — it does
 *     NOT open its own camera stream.
 *   - `components/WebcamLayer.tsx` also renders the same video element
 *     directly (or a video tag pointed at the same stream) as the visual
 *     backdrop the user sees themselves against.
 * ---------------------------------------------------------------------------
 */

import type { CameraConfig, CameraState, CameraStatus } from '../../core/types/camera.types';
import { DEFAULT_CAMERA_CONFIG } from '../../core/types/camera.types';

const INITIAL_STATE: CameraState = {
  status: 'idle',
  errorMessage: null,
  resolvedWidth: null,
  resolvedHeight: null,
};

/**
 * Maps a `getUserMedia` rejection to a `CameraStatus` + human-readable
 * message. Pure and DOM-free (other than reading `DOMException`/`Error`
 * shapes), so it can be unit-tested with synthetic error objects.
 */
export function classifyGetUserMediaError(err: unknown): { status: CameraStatus; message: string } {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return { status: 'denied', message: 'Camera permission was denied.' };
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return { status: 'unavailable', message: 'No camera device was found on this system.' };
      case 'NotReadableError':
      case 'TrackStartError':
        return { status: 'error', message: 'The camera is already in use by another application.' };
      case 'OverconstrainedError':
        return { status: 'error', message: 'No camera on this device supports the requested resolution.' };
      case 'SecurityError':
        return { status: 'error', message: 'Camera access is blocked in this context (requires HTTPS).' };
      default:
        return { status: 'error', message: err.message || 'Unable to access the camera.' };
    }
  }
  if (err instanceof Error) {
    return { status: 'error', message: err.message };
  }
  return { status: 'error', message: 'Unable to access the camera.' };
}

type CameraStateListener = (state: CameraState) => void;

export class CameraManager {
  private readonly config: CameraConfig;
  private state: CameraState = { ...INITIAL_STATE };
  private readonly listeners = new Set<CameraStateListener>();
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  /**
   * Incremented on every `start()`/`stop()`/`dispose()` call. An in-flight
   * `start()`'s async continuation compares its captured generation against
   * the current one before committing any state — if they differ, a
   * `stop()`/`dispose()` (or a newer `start()`) happened while we were
   * waiting on `getUserMedia()`, and this result is stale. Without this
   * guard, React 19 StrictMode's dev-only double-invoke of effects (mount
   * → cleanup → mount) can call `dispose()` while the FIRST mount's
   * `start()` is still awaiting the permission prompt, and when that
   * promise later resolves it would otherwise blindly assign a stream and
   * report "streaming" on a manager that was already told to tear down —
   * leaving an orphaned camera stream and inconsistent state.
   */
  private generation = 0;

  constructor(config: Partial<CameraConfig> = {}) {
    this.config = { ...DEFAULT_CAMERA_CONFIG, ...config };
  }

  /** Current snapshot of camera state (status, error, resolved resolution). */
  getState(): CameraState {
    return this.state;
  }

  /** Subscribes to state changes. Returns an unsubscribe function. */
  subscribe(listener: CameraStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The single shared `<video>` element for the whole app. Lazily created on
   * first access so this class can be constructed safely even outside a
   * browser context (e.g. in tests) without touching `document`.
   */
  getVideoElement(): HTMLVideoElement {
    if (!this.videoElement) {
      this.videoElement = document.createElement('video');
      this.videoElement.autoplay = true;
      this.videoElement.muted = true;
      this.videoElement.playsInline = true;
      // Not attached to the DOM by default — WebcamLayer decides whether/how
      // to render it. MediaPipe only needs the element as a frame source.
    }
    return this.videoElement;
  }

  /**
   * Requests camera permission and starts streaming. Safe to call multiple
   * times — no-ops if already streaming or a request is already in flight.
   */
  async start(): Promise<void> {
    if (this.state.status === 'streaming' || this.state.status === 'requesting-permission') {
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.setState({
        status: 'unavailable',
        errorMessage: 'This browser does not support camera access.',
        resolvedWidth: null,
        resolvedHeight: null,
      });
      return;
    }

    const startGeneration = ++this.generation;
    this.setState({ status: 'requesting-permission', errorMessage: null, resolvedWidth: null, resolvedHeight: null });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.config.width },
          height: { ideal: this.config.height },
          facingMode: this.config.facingMode,
          frameRate: { ideal: this.config.frameRate },
        },
        audio: false,
      });

      if (startGeneration !== this.generation) {
        // A stop()/dispose()/newer start() happened while we were waiting
        // for permission. Release this now-unwanted stream immediately
        // rather than leaving it orphaned holding the camera hardware.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;
      const video = this.getVideoElement();
      video.srcObject = stream;

      // Some browsers require an explicit play() even with `autoplay` set,
      // and may reject with AbortError if a competing play/pause race
      // happens during fast mount/unmount — safe to ignore that specific case.
      try {
        await video.play();
      } catch (playErr) {
        if (!(playErr instanceof DOMException && playErr.name === 'AbortError')) {
          throw playErr;
        }
      }

      await this.waitUntilVideoHasFrame(video);

      if (startGeneration !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();

      this.setState({
        status: 'streaming',
        errorMessage: null,
        resolvedWidth: video.videoWidth || settings?.width || null,
        resolvedHeight: video.videoHeight || settings?.height || null,
      });
    } catch (err) {
      if (startGeneration !== this.generation) {
        // A stop()/dispose() already happened; this error belongs to a
        // start() attempt we no longer care about — don't overwrite
        // whatever the current (more recent) state legitimately is.
        return;
      }
      const { status, message } = classifyGetUserMediaError(err);
      this.setState({ status, errorMessage: message, resolvedWidth: null, resolvedHeight: null });
    }
  }

  /** Stops all tracks and releases the camera hardware. Safe to call repeatedly. */
  stop(): void {
    this.generation++; // invalidates any in-flight start() call's pending continuation
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }
    this.setState({ status: 'idle', errorMessage: null, resolvedWidth: null, resolvedHeight: null });
  }

  /** Full teardown — stops the stream and clears all listeners. Call on final unmount. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private waitUntilVideoHasFrame(video: HTMLVideoElement): Promise<void> {
    // readyState >= 2 (HAVE_CURRENT_DATA) means at least one frame is decoded.
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      const onLoadedData = () => {
        video.removeEventListener('loadeddata', onLoadedData);
        resolve();
      };
      video.addEventListener('loadeddata', onLoadedData);
    });
  }

  private setState(partial: CameraState): void {
    this.state = partial;
    this.listeners.forEach((listener) => listener(this.state));
  }
}
