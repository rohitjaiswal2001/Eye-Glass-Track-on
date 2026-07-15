/**
 * GlassesScene.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   This is the ONE place `useFrame` is called for glasses positioning — the
 *   entire point of the architecture's imperative core (FrameManager,
 *   smoothing, CalibrationEngine) is that this callback can read a plain
 *   `TrackingResult` and mutate a Three.js object directly, every frame,
 *   WITHOUT going through React's reconciliation. This is what keeps the
 *   render loop capable of 60fps: no component re-renders, no diffing —
 *   just a direct `group.position.set(...)` / `group.quaternion.set(...)`.
 *
 * WHAT IT DOES
 *   - Holds a `<group>` ref wrapping the loaded glasses `THREE.Group`
 *     (attached via `<primitive object={modelGroup} />`).
 *   - Each `useFrame` tick: reads `getLatestResult()`, and if
 *     `glassesTransform` is present, applies position/quaternion/scale to
 *     the group directly. If tracking quality is `'none'` (face genuinely
 *     lost), hides the group instead of leaving it frozen in its last pose.
 *   - Reports render-loop timing to `PerformanceMonitor` if provided.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` supplies `modelGroup` (from
 *     `useGlassesModel`) and `getLatestResult` (from `useFrameLoop`).
 * ---------------------------------------------------------------------------
 */

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TrackingResult } from '../core/types/tracking.types';
import type { PerformanceMonitor } from '../modules/performance/PerformanceMonitor';
import type { CalibrationData } from '../core/types/calibration.types';
import { buildTempleRig, updateTempleSide, type TempleRig, type TempleSide } from '../modules/renderer/templeRig';

/**
 * Ear-target trust gate: MediaPipe's face-edge landmarks (234/454, the
 * tragion area) are only laterally/depth-accurate while the head is close to
 * frontal — mid-turn, the far-side landmark is foreshortened and its Z swings
 * wildly. Beyond this yaw the rig HOLDS its last smoothed fit instead of
 * chasing noise (mirrors CalibrationEngine's own depth-update gate).
 */
const MAX_EAR_UPDATE_YAW_RAD = (14 * Math.PI) / 180;
/** The temple rests on the ear-top saddle, a few mm ABOVE the tragion landmark... */
const EAR_TOP_LIFT_MM = 7;
/** ...and slightly BEHIND it (the tragion sits at the front of the ear). */
const EAR_BEHIND_MM = 8;

// Scratch objects reused every frame — never allocate inside useFrame.
const _earLeftWorld = new THREE.Vector3();
const _earRightWorld = new THREE.Vector3();
const _headUp = new THREE.Vector3();
const _headBack = new THREE.Vector3();

export interface GlassesSceneProps {
  modelGroup: THREE.Group | null;
  getLatestResult: () => TrackingResult;
  performanceMonitor?: PerformanceMonitor;
  calibration: CalibrationData | null;
}

export function GlassesScene({ modelGroup, getLatestResult, performanceMonitor, calibration }: GlassesSceneProps) {
  const anchorRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const templeRigRef = useRef<TempleRig | null>(null);

  // Classify the model's temple geometry once per model load — not per frame — so
  // `useFrame` below only ever does cheap scale/position writes on cached mesh refs.
  useEffect(() => {
    templeRigRef.current = modelGroup ? buildTempleRig(modelGroup) : null;
  }, [modelGroup]);

  useFrame((state) => {
    performanceMonitor?.recordRenderFrame(state.clock.elapsedTime * 1000);

    const anchor = anchorRef.current;
    const head = headRef.current;
    if (!anchor) return;

    const result = getLatestResult();

    if (result.quality === 'none' || !result.glassesTransform) {
      anchor.visible = false;
      if (head) head.visible = false;
      return;
    }

    anchor.visible = true;
    const { position, quaternion, scale, templeLengthRatio } = result.glassesTransform;
    anchor.position.set(position.x, position.y, position.z);
    anchor.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    anchor.scale.set(scale.x, scale.y, scale.z);

    // Per-side temple ear fitting (see templeRig.ts): aim each arm from its
    // hinge at the user's ACTUAL tracked ear point — outward splay, drop onto
    // the ear, and length all follow the real ear. Never distorts the front frame.
    const rig = templeRigRef.current;
    if (rig && (rig.left || rig.right) && modelGroup) {
      const fm = result.faceMetrics;
      let earA: THREE.Vector3 | null = null;
      let earB: THREE.Vector3 | null = null;
      let trust = false;

      if (fm?.leftFaceEdgeMetric && fm.rightFaceEdgeMetric) {
        const yaw = result.headPose?.euler.yaw ?? Number.POSITIVE_INFINITY;
        trust = result.quality === 'good' && Math.abs(yaw) <= MAX_EAR_UPDATE_YAW_RAD;

        // Anchor transform was just written above — refresh world matrices so
        // worldToLocal below sees THIS frame's pose, not last frame's.
        anchor.updateMatrixWorld(true);

        // Head-local up/back directions in world space, for the small
        // tragion→ear-top-saddle anatomical offset.
        _headUp.set(0, 1, 0).applyQuaternion(anchor.quaternion);
        _headBack.set(0, 0, -1).applyQuaternion(anchor.quaternion);

        const toModelLocal = (p: { x: number; y: number; z: number }, out: THREE.Vector3): THREE.Vector3 => {
          out.set(p.x, p.y, p.z).multiplyScalar(0.001); // mm → scene meters (camera space == world space)
          out.addScaledVector(_headUp, EAR_TOP_LIFT_MM * 0.001);
          out.addScaledVector(_headBack, EAR_BEHIND_MM * 0.001);
          return modelGroup.worldToLocal(out);
        };

        earA = toModelLocal(fm.leftFaceEdgeMetric, _earLeftWorld);
        earB = toModelLocal(fm.rightFaceEdgeMetric, _earRightWorld);
      }

      const fallbackRatio = templeLengthRatio ?? 1;
      const pickTarget = (side: TempleSide | null): THREE.Vector3 | null => {
        if (!side || !earA || !earB) return null;
        // Match tracked ears to rig sides purely by X sign in model space —
        // robust to any left/right naming convention mismatch between
        // MediaPipe (anatomical) and the model (authoring-dependent).
        return (side.sideSign > 0) === (earA.x > earB.x) ? earA : earB;
      };

      updateTempleSide(rig.left, pickTarget(rig.left), fallbackRatio, trust);
      updateTempleSide(rig.right, pickTarget(rig.right), fallbackRatio, trust);
    }

    // Position and scale the invisible head occluder to match the user's actual head.

    // Aligned to the glasses coordinates but offset to cancel out the calibration delta.
    if (head && result.faceMetrics && calibration) {
      head.visible = true;
      head.position.set(position.x, position.y, position.z);
      head.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);

      const faceWidth = result.faceMetrics.faceWidth; // in mm
      const faceWidthM = faceWidth * 0.001;
      const s = faceWidth * 1.25; // group scale in mm

      head.scale.set(faceWidthM, faceWidthM * 1.25, faceWidthM * 1.25);

      // Compute local position of the sphere to cancel out glasses offsets and place it at head center
      const localX = -calibration.offsetX / s;
      const localY = (-14 - calibration.offsetY) / s;
      const localZ = (-105 - calibration.offsetZ) / s;

      const mesh = head.children[0] as THREE.Mesh;
      if (mesh) {
        mesh.position.set(localX, localY, localZ);
      }
    }
  });

  if (!modelGroup) return null;

  return (
    <>
      <group ref={anchorRef} visible={false}>
        <primitive object={modelGroup} />
      </group>

      {/* Invisible Head Occluder: Keeps only the back-head/ear occluder to prevent clipping the front frame */}
      <group ref={headRef} visible={false} renderOrder={-1}>
        {/* 1. Main Skull Sphere */}
        <mesh>
          <sphereGeometry args={[0.5, 32, 32]} />
          <meshBasicMaterial colorWrite={false} depthWrite={true} />

          {/* 2. Left Ear Occluder (ellipsoid sitting on the left side of the skull) */}
          <mesh position={[0.51, -0.05, -0.05]} scale={[0.15, 0.35, 0.25]}>
            <sphereGeometry args={[1.0, 16, 16]} />
            <meshBasicMaterial colorWrite={false} depthWrite={true} />
          </mesh>

          {/* 3. Right Ear Occluder (ellipsoid sitting on the right side of the skull) */}
          <mesh position={[-0.51, -0.05, -0.05]} scale={[0.15, 0.35, 0.25]}>
            <sphereGeometry args={[1.0, 16, 16]} />
            <meshBasicMaterial colorWrite={false} depthWrite={true} />
          </mesh>
        </mesh>
      </group>
    </>
  );
}
