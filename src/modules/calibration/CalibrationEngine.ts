/**
 * CalibrationEngine.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   This is the module that answers "given THIS user's face and THIS
 *   frame's authored dimensions, exactly where/how big/how rotated should
 *   the glasses render, right now?" It's the one place all three inputs —
 *   tracked head pose, live face measurements, and static per-model
 *   calibration JSON — meet. Isolating it here means adding a new frame to
 *   the catalog never requires touching tracking or rendering code, and
 *   tuning the scale/fit heuristic never requires touching MediaPipe code.
 *
 * WHAT IT DOES
 *   `calibrate(headPose, faceMetrics, calibrationData)`:
 *     1. Computes a uniform scale factor: the frame's authored
 *        `defaultScale` adjusted by the ratio of this user's measured IPD to
 *        a reference average adult IPD (63mm). A user with wider-than-average
 *        eyes gets correspondingly larger glasses, and vice versa.
 *     2. Rotates the frame's authored `offsetX/Y/Z` (mm, in the head's local
 *        space) into world space using the tracked head orientation, so the
 *        offset "rides along" with head rotation instead of staying
 *        world-axis-aligned.
 *     3. Adds that rotated offset to `faceMetrics.noseBridgeMetric` — the
 *        ACTUAL tracked nose bridge landmark, back-projected into metric
 *        space (see `core/math/projection.ts`'s `unprojectToMetricSpace`
 *        doc comment) — rather than to `headPose.position`. This distinction
 *        matters: `headPose.position` is MediaPipe's whole-face Procrustes
 *        rigid-fit origin, which is NOT the same point as the nose bridge
 *        and (empirically, and by the nature of a whole-mesh fit) sits
 *        measurably below eye level. Anchoring to the actual tracked nose
 *        bridge landmark is what puts glasses at the correct height by
 *        default, before any per-frame `offsetY` fine-tuning.
 *     4. Composes the frame's authored `rotationX/Y/Z` correction (for
 *        fixing modeling-tool axis mismatches) with the tracked head
 *        rotation (still from `headPose.quaternion` — rotation IS reliably
 *        given by the whole-face fit, unlike position).
 *     5. Converts the final position from millimeters (this module's
 *        internal working unit) to meters (the Three.js/glTF scene
 *        convention) — see `MILLIMETERS_TO_SCENE_UNITS`.
 *
 * HOW IT COMMUNICATES
 *   - `modules/frameManager/FrameManager.ts` owns one instance and calls
 *     `calibrate()` once per tick with the smoothed `HeadPose` (for
 *     rotation), the latest `FaceMetrics` with a SMOOTHED
 *     `noseBridgeMetric` (for position — see `FrameManager`'s own
 *     `noseBridgeFilter`), and the `CalibrationData` for the currently
 *     selected `FrameAsset`.
 *   - Output (`TransformLike`) is applied directly to the glasses
 *     `Object3D` inside `modules/renderer`.
 * ---------------------------------------------------------------------------
 */

import type { HeadPose } from '../../core/types/headPose.types';
import type { FaceMetrics } from '../../core/types/faceMetrics.types';
import type { CalibrationData } from '../../core/types/calibration.types';
import type { TransformLike, Vector3Like } from '../../core/types/math.types';
import { add, scale as scaleVec3 } from '../../core/math/vector3';
import { fromEulerYXZ, multiplyQuaternions, rotateVector3ByQuaternion } from '../../core/math/quaternion';
import { clamp, degToRad } from '../../core/math/scalar';

/**
 * Average adult interpupillary distance (mm), used as the baseline against
 * which a user's measured IPD is compared to derive a per-user scale
 * multiplier. Sourced from widely-cited anthropometric ranges (~54-68mm for
 * adults); 63mm is a standard reference midpoint used in eyewear fitting.
 */
export const REFERENCE_ADULT_IPD_MM = 63;

/**
 * Three.js/glTF scenes conventionally use meters as the base unit, while all
 * of this module's internal math (calibration offsets, face measurements)
 * is authored/reasoned about in millimeters for intuitive tuning. This is
 * the single conversion point between the two.
 */
export const MILLIMETERS_TO_SCENE_UNITS = 0.001;

export interface CalibrationEngineOptions {
  /** Override the reference IPD used for scale normalization (mm). */
  referenceIpdMm?: number;
  /**
   * How far the measured-IPD-based correction is allowed to move scale away
   * from `calibration.defaultScale`, as a ratio (0.15 = ±15%). MediaPipe's
   * transform is rigid (no baked-in scale — see `DEFAULT_VERTICAL_FOV_DEGREES`'s
   * doc comment), so `defaultScale` is the primary, directly-tunable lever;
   * this per-user IPD adjustment is a secondary refinement and is clamped so
   * that an imperfect depth/FOV estimate can only nudge it, never
   * drastically mis-scale the model the way an unclamped ratio could.
   */
  maxScaleCorrectionRatio?: number;
}

const DEFAULT_MAX_SCALE_CORRECTION_RATIO = 0.15;

/**
 * Nose-to-ear depth (`nb.z - cheekEdge.z`) is a single-camera Z estimate — the
 * least reliable axis MediaPipe reports, and it gets substantially worse as the
 * head yaws (the far cheek landmark is foreshortened/partially occluded and its
 * Z reading swings wildly). Recomputing `templeLengthRatio` fresh every frame
 * from that raw signal made the temple arm visibly balloon or retract during
 * head turns — exactly the "goes into the eye on the far side" symptom. Two
 * guards fix this:
 *   1. Only trust a NEW reading when the head is close to frontal (`MAX_YAW...`).
 *      While turned, keep the last trusted value instead of chasing noise.
 *   2. Even trusted readings are folded in with a slow exponential moving
 *      average (`DEPTH_RATIO_SMOOTHING_ALPHA`), since this is a per-user
 *      physical constant (nose-to-ear depth doesn't change frame to frame) —
 *      it should converge over ~1-2 seconds, not snap.
 */
const MAX_YAW_FOR_DEPTH_UPDATE_RAD = degToRad(12);
const DEPTH_RATIO_SMOOTHING_ALPHA = 0.1;
/** Tighter than the old ±25% — real adult nose-to-ear depth doesn't vary enough to justify a visibly longer/shorter arm. */
const TEMPLE_LENGTH_RATIO_MIN = 0.85;
const TEMPLE_LENGTH_RATIO_MAX = 1.15;

export class CalibrationEngine {
  private readonly maxScaleCorrectionRatio: number;
  private smoothedTempleLengthRatio = 1;

  constructor(options: CalibrationEngineOptions = {}) {
    this.maxScaleCorrectionRatio = options.maxScaleCorrectionRatio ?? DEFAULT_MAX_SCALE_CORRECTION_RATIO;
  }


  /**
   * Computes the final render transform for the glasses model.
   *
   * @param headPose        Smoothed head pose (position in mm, quaternion).
   * @param faceMetrics      Live face measurements (interPupillaryDistance in mm).
   * @param calibrationData  The selected frame's authored calibration JSON.
   */
  calibrate(headPose: HeadPose, faceMetrics: FaceMetrics, calibrationData: CalibrationData): TransformLike {
    const uniformScale = this.computeScale(faceMetrics, calibrationData);

    // Dynamic Ear-Fitting: calculate the physical nose-to-ear depth in millimeters
    // by comparing the 3D Z coordinate of the nose bridge and the sides of the head.
    // NOTE: this ratio is deliberately NOT folded into `scale.z` below — doing so
    // would stretch the whole model (lenses/bridge included). It's returned as
    // `templeLengthRatio` so the renderer's temple rig (modules/renderer/templeRig.ts)
    // can stretch only the temple-arm geometry, pivoting at the hinge.
    const nb = faceMetrics.noseBridgeMetric;
    const left = faceMetrics.leftFaceEdgeMetric;
    const right = faceMetrics.rightFaceEdgeMetric;

    // In camera space, Z is negative and goes deeper into the screen.
    // So (nb.z - cheek.z) gives a positive physical depth in millimeters.
    const depthLeft = left ? nb.z - left.z : 0;
    const depthRight = right ? nb.z - right.z : 0;

    // Use the maximum depth to account for head rotation profile accuracy.
    // Default reference nose-to-ear depth is 95mm.
    const physicalDepth = Math.max(depthLeft, depthRight);
    const depthRatio = physicalDepth > 0 ? physicalDepth / 95 : 1.0;
    const clampedRawRatio = clamp(depthRatio, TEMPLE_LENGTH_RATIO_MIN, TEMPLE_LENGTH_RATIO_MAX);

    // Only fold in a fresh reading near-frontal; otherwise hold the last trusted
    // value (see this file's header note on why the raw per-frame signal is unsafe
    // to use directly, especially mid-rotation).
    if (Math.abs(headPose.euler.yaw) <= MAX_YAW_FOR_DEPTH_UPDATE_RAD) {
      this.smoothedTempleLengthRatio +=
        DEPTH_RATIO_SMOOTHING_ALPHA * (clampedRawRatio - this.smoothedTempleLengthRatio);
    }
    const templeLengthRatio = this.smoothedTempleLengthRatio;

    const offsetMm: Vector3Like = {
      x: calibrationData.offsetX,
      y: calibrationData.offsetY,
      z: calibrationData.offsetZ,
    };
    const rotatedOffsetMm = rotateVector3ByQuaternion(offsetMm, headPose.quaternion);
    // Anchored to the tracked nose bridge landmark, NOT headPose.position —
    // see this file's header comment for why that distinction matters.
    const positionMm = add(faceMetrics.noseBridgeMetric, rotatedOffsetMm);
    const position = scaleVec3(positionMm, MILLIMETERS_TO_SCENE_UNITS);

    const scaleX = uniformScale * (calibrationData.scaleX ?? 1);
    const scaleY = uniformScale;
    // Whole-model Z scale stays proportional (matches X/Y) — no depth distortion here.
    // Per-user temple length is handled separately via `templeLengthRatio`.
    const scaleZ = uniformScale * (calibrationData.scaleZ ?? 1);

    const offsetRotation = fromEulerYXZ({
      pitch: degToRad(calibrationData.rotationX),
      yaw: degToRad(calibrationData.rotationY),
      roll: degToRad(calibrationData.rotationZ),
    });
    // Apply the model's own corrective rotation first (local space), then the tracked head orientation.
    const quaternion = multiplyQuaternions(offsetRotation, headPose.quaternion);

    return {
      position,
      quaternion,
      scale: { x: scaleX, y: scaleY, z: scaleZ },
      templeLengthRatio,
    };
  }


  /** Clears the smoothed temple-length estimate — call when deliberately switching users/sessions. */
  reset(): void {
    this.smoothedTempleLengthRatio = 1;
  }

  /**
   * Derives the uniform scale multiplier for this user + this frame.
   * Exposed separately (not just inlined) so it's independently testable
   * and tunable without touching the position/rotation composition above.
   */
  private computeScale(faceMetrics: FaceMetrics, calibrationData: CalibrationData): number {
    // primary scaling based on the user's physical face width (temple-to-temple)
    // relative to the reference average adult face width (140mm). This guarantees
    // the temple arms fit the sides of the head snugly.
    const referenceFaceWidthMm = 140;
    const measuredFaceWidth = faceMetrics.faceWidth > 0 ? faceMetrics.faceWidth : referenceFaceWidthMm;

    const rawRatio = measuredFaceWidth / referenceFaceWidthMm;
    const clampedRatio = clamp(
      rawRatio,
      1 - this.maxScaleCorrectionRatio,
      1 + this.maxScaleCorrectionRatio,
    );
    return calibrationData.defaultScale * clampedRatio;
  }
}

