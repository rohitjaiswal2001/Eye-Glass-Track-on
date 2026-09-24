import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CANONICAL_POSITIONS, CANONICAL_VERTEX_COUNT } from './canonicalFace';
import { FOV_Y_DEG, LEFT_EYE_CONTOUR, RIGHT_EYE_CONTOUR } from './constants';

export const LANDMARK_COUNT = 478;
const MESH_COUNT = CANONICAL_VERTEX_COUNT;

const CANONICAL_CENTROID = (() => {
  const c = new THREE.Vector3();
  for (let i = 0; i < MESH_COUNT; i++) {
    c.x += CANONICAL_POSITIONS[i * 3];
    c.y += CANONICAL_POSITIONS[i * 3 + 1];
    c.z += CANONICAL_POSITIONS[i * 3 + 2];
  }
  return c.divideScalar(MESH_COUNT);
})();

const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV_Y_DEG) / 2);

/**
 * Metric 3D reconstruction of the live face in camera space (cm, OpenGL convention:
 * camera at origin looking down −Z, +Y up), consistent with MediaPipe's facial
 * transformation matrix.
 *
 * The matrix fixes the head's depth/scale; each landmark's normalised z (same scale as x)
 * supplies the user's own relief (nose height, eye depth…). Projected back through the
 * camera, every point lands exactly on its detected 2D pixel.
 */
export class FaceReconstruction {
  /** Camera-space positions, 478 × xyz (cm). */
  readonly camera = new Float32Array(LANDMARK_COUNT * 3);
  /** Pixel positions, 478 × xy. */
  readonly pixels = new Float32Array(LANDMARK_COUNT * 2);
  /** Facial transformation (canonical → camera) and its inverse, for this frame. */
  readonly matrix = new THREE.Matrix4();
  readonly inverse = new THREE.Matrix4();
  width = 1;
  height = 1;
  focalPx = 1;
  private v = new THREE.Vector3();

  update(lms: NormalizedLandmark[], matrix: THREE.Matrix4, width: number, height: number): void {
    this.matrix.copy(matrix);
    this.inverse.copy(matrix).invert();
    this.width = width;
    this.height = height;
    const f = height / 2 / TAN_HALF_FOV;
    this.focalPx = f;

    const dRef = Math.max(-this.v.copy(CANONICAL_CENTROID).applyMatrix4(matrix).z, 5);
    let zMean = 0;
    for (let i = 0; i < MESH_COUNT; i++) zMean += lms[i].z;
    zMean /= MESH_COUNT;
    const zScale = (width * dRef) / f;

    const n = Math.min(lms.length, LANDMARK_COUNT);
    for (let i = 0; i < n; i++) {
      const l = lms[i];
      const u = l.x * width;
      const v = l.y * height;
      this.pixels[i * 2] = u;
      this.pixels[i * 2 + 1] = v;
      this.setFromPixel(i, u, v, Math.max(dRef + (l.z - zMean) * zScale, 5));
    }
    if (n >= LANDMARK_COUNT) {
      // Iris points: use the depth of their eye's lid contour (more reliable than their own z).
      const dR = this.meanDepth(RIGHT_EYE_CONTOUR);
      const dL = this.meanDepth(LEFT_EYE_CONTOUR);
      for (let i = 468; i < 473; i++) this.setFromPixel(i, this.pixels[i * 2], this.pixels[i * 2 + 1], dR);
      for (let i = 473; i < 478; i++) this.setFromPixel(i, this.pixels[i * 2], this.pixels[i * 2 + 1], dL);
    }
  }

  private setFromPixel(i: number, u: number, v: number, depth: number): void {
    const f = this.focalPx;
    this.camera[i * 3] = ((u - this.width / 2) * depth) / f;
    this.camera[i * 3 + 1] = (-(v - this.height / 2) * depth) / f;
    this.camera[i * 3 + 2] = -depth;
  }

  meanDepth(ids: readonly number[]): number {
    let d = 0;
    for (const i of ids) d -= this.camera[i * 3 + 2];
    return d / ids.length;
  }

  /** Camera-space position of landmark `i`. */
  getCamera(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.fromArray(this.camera, i * 3);
  }

  /** Position of landmark `i` in canonical (head-fixed, face-normalised) space. */
  getCanonical(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.fromArray(this.camera, i * 3).applyMatrix4(this.inverse);
  }

  /** 2D pixel distance between two landmarks. */
  pixelDistance(a: number, b: number): number {
    const dx = this.pixels[a * 2] - this.pixels[b * 2];
    const dy = this.pixels[a * 2 + 1] - this.pixels[b * 2 + 1];
    return Math.hypot(dx, dy);
  }
}
