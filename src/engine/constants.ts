/**
 * Geometry constants. All lengths are in centimetres of MediaPipe's canonical face space
 * (an average adult face: canonical PD = 63.2 mm), unless noted otherwise.
 */

/** Vertical FOV assumed by MediaPipe's face-geometry pipeline; our camera must match it. */
export const FOV_Y_DEG = 63;
export const CAMERA_NEAR = 1;
export const CAMERA_FAR = 2000;

/** Horizontal visible iris diameter is ~11.7 mm for almost all adults: our real-world ruler. */
export const IRIS_DIAMETER_CM = 1.17;

/** Distance from the corneal apex to the back of the lens (optometric vertex distance). */
export const VERTEX_DISTANCE_CM = 1.2;
/** Corneal apex relative to the mean depth of the eyelid contour landmarks. */
export const CORNEA_OFFSET_CM = 0.45;

/** Face occluder is pushed this far back so frame parts touching the skin are not clipped. */
export const OCCLUSION_BIAS_CM = 0.35;

/**
 * Temple rest point ("ear root", where the temple sits on top of the ear) relative to the
 * face-contour landmark in front of the ear (127 / 356). That landmark lies on the cheek
 * ~1.5 cm in front of the ear and a little below the ear's top attachment, so the rest point is
 * further back (~9.5 cm behind the lenses, a real temple's "length to bend") and at about the
 * height of the outer eye corner.
 */
export const EAR_ROOT_OFFSET = { out: 0.1, up: 0.4, back: 1.6 };

/** A modelled ear bend starts this far behind the rest point: over the top of the ear. */
export const EAR_BEND_BEHIND_ROOT_CM = 1.0;

/** A well-fitting frame is ~90% as wide as the face measured at landmarks 127↔356. */
export const IDEAL_FRAME_TO_FACE = 0.9;

/** Frame box centre sits this fraction of the frame height below the pupils. */
export const PUPIL_TO_FRAME_CENTER = 0.07;

/** MediaPipe Face Landmarker indices (478-point model with irises). */
export const LM = {
  noseBridgeTop: 168,
  noseBridge: 6,
  noseUpper: 197,
  noseMid: 195,
  glabella: 8,
  rightEyeOuter: 33,
  rightEyeInner: 133,
  rightEyeUpper: 159,
  rightEyeLower: 145,
  leftEyeOuter: 263,
  leftEyeInner: 362,
  leftEyeUpper: 386,
  leftEyeLower: 374,
  rightIrisCenter: 468,
  leftIrisCenter: 473,
  /** Face contour right in front of the ears, at eye height. */
  rightEarFront: 127,
  leftEarFront: 356,
} as const;

export const RIGHT_IRIS_RING = [469, 470, 471, 472] as const;
export const LEFT_IRIS_RING = [474, 475, 476, 477] as const;
export const RIGHT_EYE_CONTOUR = [33, 133, 159, 145] as const;
export const LEFT_EYE_CONTOUR = [263, 362, 386, 374] as const;
/** Nose midline from glabella down, used to keep the bridge from sinking into the nose. */
export const NOSE_MIDLINE = [8, 168, 6, 197, 195] as const;
