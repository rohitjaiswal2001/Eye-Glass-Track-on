/**
 * landmarkIndices.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   MediaPipe's 478-point face mesh topology is a fixed, published spec —
 *   not an SDK implementation detail — so these indices are safe to treat as
 *   stable constants in the framework-agnostic math layer (rather than
 *   living inside `modules/mediapipe`, which only wraps the live SDK calls).
 *   `modules/mediapipe` re-exports these for anything UI-related that needs
 *   them (e.g. drawing a debug mesh overlay).
 *
 * WHAT IT DOES
 *   Names the specific landmark indices `faceMetrics.ts` needs: eye corners
 *   (to derive eye centers), nose bridge, chin, and face-width reference
 *   points.
 *
 * HOW IT COMMUNICATES
 *   Consumed exclusively by `core/math/faceMetrics.ts`.
 *
 * NOTE ON LEFT/RIGHT
 *   Naming follows MediaPipe's own convention, which is anatomical
 *   (subject-relative), not screen-relative: "right eye" is the subject's
 *   actual right eye, which appears on the LEFT side of a mirrored selfie
 *   view. This matches MediaPipe's official documentation and avoids
 *   double-flipping bugs.
 * ---------------------------------------------------------------------------
 */

/** Subject's right eye: outer corner, inner corner, top lid, bottom lid. */
export const RIGHT_EYE_OUTER_CORNER = 33;
export const RIGHT_EYE_INNER_CORNER = 133;
export const RIGHT_EYE_TOP = 159;
export const RIGHT_EYE_BOTTOM = 145;

/** Subject's left eye: outer corner, inner corner, top lid, bottom lid. */
export const LEFT_EYE_OUTER_CORNER = 263;
export const LEFT_EYE_INNER_CORNER = 362;
export const LEFT_EYE_TOP = 386;
export const LEFT_EYE_BOTTOM = 374;

/** Iris centers — only populated when the FaceLandmarker model outputs the full 478-point set. */
export const RIGHT_IRIS_CENTER = 468;
export const LEFT_IRIS_CENTER = 473;

/** Nose bridge (sellion) — the point between the eyes at the top of the nose. Primary glasses anchor. */
export const NOSE_BRIDGE = 168;

/** Nose tip, used as a secondary depth/orientation reference. */
export const NOSE_TIP = 4;

/** Chin (bottom of jaw), used for face-height measurement. */
export const CHIN = 152;

/** Left/right face edge (roughly temple/cheek boundary), used for face-width measurement. */
export const RIGHT_FACE_EDGE = 234;
export const LEFT_FACE_EDGE = 454;

/** Forehead center, used only for optional debug visualization. */
export const FOREHEAD_CENTER = 10;
