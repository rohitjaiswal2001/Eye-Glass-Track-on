import * as THREE from 'three';
import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { getVisionFileset, loadModelBuffer } from './faceTracker';

const BASE = import.meta.env.BASE_URL;
const MODEL_LOCAL = `${BASE}models/hair_segmenter.tflite`;
const MODEL_REMOTE =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite';

/** Low-resolution width fed to the segmenter; hair edges are soft so this is plenty. */
const MASK_WIDTH = 256;

/**
 * Hair mask (MediaPipe hair segmenter) used to hide temple arms that go under the hair.
 * Runs on a downscaled copy of the frame so the GPU→CPU mask readback stays tiny.
 */
export class HairSegmenter {
  texture: THREE.DataTexture;
  private data: Uint8Array;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private lastTs = 0;

  private constructor(private readonly segmenter: ImageSegmenter) {
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.data = new Uint8Array(4);
    this.texture = this.makeTexture(1, 1);
  }

  static async create(): Promise<HairSegmenter> {
    const [fileset, model] = await Promise.all([getVisionFileset(), loadModelBuffer(MODEL_LOCAL, MODEL_REMOTE)]);
    const make = (delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    try {
      return new HairSegmenter(await make('GPU'));
    } catch {
      return new HairSegmenter(await make('CPU'));
    }
  }

  private makeTexture(w: number, h: number): THREE.DataTexture {
    this.data = new Uint8Array(w * h);
    const t = new THREE.DataTexture(this.data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  }

  process(video: HTMLVideoElement, timestampMs: number): void {
    const w = MASK_WIDTH;
    const h = Math.max(2, Math.round((MASK_WIDTH * video.videoHeight) / video.videoWidth));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.texture.dispose();
      this.texture = this.makeTexture(w, h);
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    const ts = Math.max(Math.round(timestampMs), this.lastTs + 1);
    this.lastTs = ts;
    this.segmenter.segmentForVideo(this.canvas, ts, (result) => {
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) return;
      const hair = masks[masks.length - 1].getAsFloat32Array();
      const n = Math.min(hair.length, this.data.length);
      for (let i = 0; i < n; i++) this.data[i] = hair[i] * 255;
      this.texture.needsUpdate = true;
    });
  }

  close(): void {
    this.segmenter.close();
    this.texture.dispose();
  }
}
