import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

const BASE = import.meta.env.BASE_URL;
const LOCAL_WASM = `${BASE}mediapipe/wasm`;
const REMOTE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const FACE_MODEL_LOCAL = `${BASE}models/face_landmarker.task`;
const FACE_MODEL_REMOTE =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export type Delegate = 'GPU' | 'CPU';

let filesetPromise: Promise<WasmFileset> | null = null;

/** Shared WASM fileset (self-hosted copy from /public, CDN fallback). */
export function getVisionFileset(): Promise<WasmFileset> {
  filesetPromise ??= (async () => {
    const probe = await fetch(`${LOCAL_WASM}/vision_wasm_internal.wasm`, { method: 'HEAD' }).catch(() => null);
    const type = probe?.headers.get('content-type') ?? '';
    const local = !!probe?.ok && !type.includes('text/html');
    return FilesetResolver.forVisionTasks(local ? LOCAL_WASM : REMOTE_WASM);
  })();
  return filesetPromise;
}

/**
 * Loads a model file, preferring the self-hosted copy. Vite's dev server answers unknown
 * paths with index.html, so the payload is validated before use.
 */
export async function loadModelBuffer(localUrl: string, remoteUrl: string): Promise<Uint8Array> {
  for (const url of [localUrl, remoteUrl]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      const looksLikeHtml = buf.length > 0 && buf[0] === 0x3c; // '<'
      if (buf.length > 1024 && !looksLikeHtml) return buf;
    } catch {
      /* try next source */
    }
  }
  throw new Error('Could not download the MediaPipe model. Check your internet connection.');
}

export class FaceTracker {
  private lastTs = 0;
  private constructor(
    private landmarker: FaceLandmarker,
    readonly delegate: Delegate,
  ) {}

  static async create(): Promise<FaceTracker> {
    const [fileset, model] = await Promise.all([
      getVisionFileset(),
      loadModelBuffer(FACE_MODEL_LOCAL, FACE_MODEL_REMOTE),
    ]);
    const make = (delegate: Delegate) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
    try {
      return new FaceTracker(await make('GPU'), 'GPU');
    } catch (err) {
      console.warn('[FaceTracker] GPU delegate unavailable, falling back to CPU.', err);
      return new FaceTracker(await make('CPU'), 'CPU');
    }
  }

  /** Runs the landmarker on the current video frame. Timestamps must be strictly increasing. */
  detect(video: HTMLVideoElement, timestampMs: number): FaceLandmarkerResult {
    const ts = Math.max(Math.round(timestampMs), this.lastTs + 1);
    this.lastTs = ts;
    return this.landmarker.detectForVideo(video, ts);
  }

  close(): void {
    this.landmarker.close();
  }
}

let trackerPromise: Promise<FaceTracker> | null = null;

/** App-wide singleton: survives React StrictMode double-mounts and component remounts. */
export function getFaceTracker(): Promise<FaceTracker> {
  trackerPromise ??= FaceTracker.create().catch((err) => {
    trackerPromise = null;
    throw err;
  });
  return trackerPromise;
}
