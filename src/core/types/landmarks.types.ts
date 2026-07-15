/**
 * landmarks.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   MediaPipe's FaceLandmarker returns a raw, loosely-typed result object.
 *   We wrap the parts we actually use in strict, named types so the rest of
 *   the app never touches the MediaPipe SDK shape directly. If MediaPipe
 *   changes its API surface, only `modules/mediapipe` needs to adapt this
 *   shape — nothing downstream breaks.
 *
 * WHAT IT DOES
 *   Defines the 478-point face mesh landmark array type, the raw detection
 *   result envelope, and named indices for landmarks we care about.
 *
 * HOW IT COMMUNICATES
 *   - `modules/mediapipe/MediaPipeService.ts` produces `FaceLandmarkerFrame`.
 *   - `modules/faceTracker/FaceTracker.ts` consumes it to compute FaceMetrics.
 *   - `modules/headPose/HeadPoseEstimator.ts` consumes the transformation
 *     matrix portion of the same frame.
 * ---------------------------------------------------------------------------
 */

import type { Matrix4Array, Point3D } from './math.types';

/**
 * The full 478-point face mesh landmark set, in MediaPipe's canonical order.
 * Each entry is a normalized point: x,y in [0,1] relative to image width/height,
 * z is a relative depth (smaller = closer to camera).
 */
export type FaceLandmarkList = Point3D[];

/**
 * Blendshape (ARKit-style) coefficients, keyed by category name
 * (e.g. "eyeBlinkLeft", "jawOpen"). Optional — only present if the
 * FaceLandmarker was configured with `outputFaceBlendshapes: true`.
 */
export interface BlendshapeScore {
  categoryName: string;
  score: number;
}

/**
 * One frame's worth of detection output from MediaPipeService.
 * This is the canonical "raw tracking frame" that flows into FaceTracker
 * and HeadPoseEstimator.
 */
export interface FaceLandmarkerFrame {
  /** Monotonically increasing timestamp (ms) matching the source video frame. */
  timestampMs: number;
  /** True if a face was detected this frame. When false, all other fields are empty/undefined. */
  faceDetected: boolean;
  /** 478 normalized landmarks for the primary (first) detected face. */
  landmarks: FaceLandmarkList;
  /**
   * 4x4 facial transformation matrix for the primary face, as returned by
   * MediaPipe when `outputFacialTransformationMatrixes: true`. Encodes head
   * position + rotation in a metric (roughly cm-scale) space anchored at
   * the camera. This is what HeadPoseEstimator decomposes into
   * position/quaternion — we deliberately do NOT hand-roll a PnP solver.
   */
  facialTransformationMatrix: Matrix4Array | null;
  /** Optional blendshapes, useful later for expression-aware effects. */
  blendshapes: BlendshapeScore[];
  /** Width/height of the source video frame in pixels, needed to unnormalize points. */
  frameWidth: number;
  frameHeight: number;
}

/**
 * Named indices into the 478-point MediaPipe Face Mesh topology.
 * Only the subset actually used by this app is enumerated (kept in
 * modules/mediapipe/landmarkIndices.ts) — this file just documents the
 * canonical landmark count and the type they populate.
 */
export const FACE_MESH_LANDMARK_COUNT = 478;
