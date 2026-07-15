/**
 * math.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Every module in this app (MediaPipe output, smoothing filters, calibration,
 *   rendering) needs to pass around positions, rotations and scales. If each
 *   module imports `THREE.Vector3` / `THREE.Quaternion` directly, the math
 *   layer becomes coupled to Three.js and can never be reused outside the web
 *   (e.g. ported to Dart/Flutter later, per the project's long-term goal).
 *
 * WHAT IT DOES
 *   Defines plain-data ("POJO") structural types for 3D vectors, quaternions,
 *   Euler angles and 4x4 matrices. These are just `{ x, y, z }`-shaped objects
 *   with no methods and no library dependency.
 *
 * HOW IT COMMUNICATES
 *   - `core/math/*` utilities operate ON these types and return these types.
 *   - `modules/*` (FaceTracker, HeadPoseEstimator, CalibrationEngine, etc.)
 *     exchange data using these types.
 *   - Only at the very last step (inside `modules/renderer`) do we convert a
 *     `TransformLike` into a real `THREE.Object3D` mutation. Every other layer
 *     stays framework-agnostic.
 * ---------------------------------------------------------------------------
 */

/** A structural 3D vector. Intentionally NOT `THREE.Vector3` (see file header). */
export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

/** A structural quaternion (Hamilton convention, right-handed). */
export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Euler angles in radians. Order matches Three.js default 'XYZ' unless noted. */
export interface EulerAnglesLike {
  /** Rotation around X axis (looking up/down) */
  pitch: number;
  /** Rotation around Y axis (turning left/right) */
  yaw: number;
  /** Rotation around Z axis (tilting head side to side) */
  roll: number;
}

/**
 * A flat, row-major-agnostic 4x4 matrix represented as a 16-length array,
 * matching the layout MediaPipe Tasks Vision returns for
 * `facialTransformationMatrixes` and the layout `THREE.Matrix4.fromArray`
 * expects (both are column-major column-vector convention).
 */
export type Matrix4Array = Float32Array | number[];

/** Uniform or non-uniform scale factors applied to a model. */
export interface Scale3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * A complete rigid-body + scale transform, structural and library-agnostic.
 * This is the "final answer" that flows from CalibrationEngine to the
 * renderer every frame.
 */
export interface TransformLike {
  position: Vector3Like;
  quaternion: QuaternionLike;
  scale: Scale3Like;
  /**
   * Per-user temple-length correction ratio (1.0 = authored length unchanged).
   * Only meaningful for the glasses transform produced by `CalibrationEngine`
   * (absent/ignored for other `TransformLike` producers like `decomposeMatrix4`).
   * Unlike `scale`, this must NOT be applied to the whole model — it's meant
   * for `modules/renderer`'s temple rig, which stretches only the temple arm
   * geometry from its hinge pivot so the front (lenses/bridge) never distorts.
   * See `modules/renderer/templeRig.ts` for why this can't just be `scale.z`.
   */
  templeLengthRatio?: number;
}

/** A 2D point, used for normalized image-space landmark coordinates. */
export interface Point2D {
  x: number;
  y: number;
}

/** A 3D point in MediaPipe's normalized landmark space (x,y in [0,1], z relative depth). */
export interface Point3D extends Point2D {
  z: number;
}
