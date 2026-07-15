/**
 * PngFrameOverlay.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Rendering a product photo as a Three.js textured plane in 3D space causes
 *   perspective distortion — the image appears to "float" rather than sit on
 *   the face. For photo-based frames, the correct approach is to render the
 *   PNG as an HTML <img> element positioned in 2D SCREEN SPACE using the same
 *   face-tracking data that drives the 3D pipeline.
 *
 * WHAT IT DOES
 *   - Runs a requestAnimationFrame loop that reads `getLatestResult()` each
 *     frame and directly mutates the <img> DOM element (no React setState,
 *     no re-renders — same performance model as GlassesScene's useFrame pattern).
 *   - Projects the 3D glasses position (from CalibrationEngine, in meters,
 *     camera-space) to 2D screen coordinates using the pinhole-camera math that
 *     matches RendererCore's FOV assumption.
 *   - Scales the image width based on the user's measured IPD and the frame's
 *     `frameWidth` calibration value, so glasses are the right apparent size on
 *     every face regardless of their distance from the camera.
 *   - Rotates the image by the head's roll angle (extracted from the tracked
 *     quaternion) so the glasses naturally tilt with the user's head.
 *   - Hides (opacity: 0) when face quality is 'none' or transform is unavailable,
 *     exactly as GlassesScene hides the 3D model.
 *
 * HOW IT COMMUNICATES
 *   - `TryOnApp` renders this alongside RendererCore, but passes `modelGroup=null`
 *     to GlassesScene for PNG-backed frames (so Three.js renders nothing and this
 *     overlay provides the visual instead).
 *   - MUST be placed INSIDE the same `scaleX(-1)` container as the webcam video
 *     so that the mirroring is applied consistently to both.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useRef } from 'react';
import type { TrackingResult } from '../core/types/tracking.types';
import type { CalibrationData } from '../core/types/calibration.types';
import { DEFAULT_VERTICAL_FOV_DEGREES } from '../core/math/projection';

/** Reference adult IPD used to normalise the frame width scale factor (mm). */
const REFERENCE_ADULT_IPD_MM = 63;

/** Extracts the head roll angle in degrees from a unit quaternion. */
function getRollDeg(q: { x: number; y: number; z: number; w: number }): number {
  // Roll = rotation around Z axis (head tilt left/right)
  const sinrCosp = 2 * (q.w * q.z + q.x * q.y);
  const cosrCosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  return (Math.atan2(sinrCosp, cosrCosp) * 180) / Math.PI;
}

export interface PngFrameOverlayProps {
  /** URL of the transparent-background glasses PNG to display. */
  pngUrl: string;
  /** The active calibration for this frame (determines width/scale). */
  calibration: CalibrationData;
  /** The imperative result getter — called every RAF tick, never triggering re-renders. */
  getLatestResult: () => TrackingResult;
}

export function PngFrameOverlay({ pngUrl, calibration, getLatestResult }: PngFrameOverlayProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const rafRef = useRef<number | null>(null);

  // Use a ref for props so the RAF closure always reads the latest values
  // without being re-created (and re-registered) on every render.
  const propsRef = useRef({ calibration, getLatestResult });
  propsRef.current = { calibration, getLatestResult };

  useEffect(() => {
    // Pre-compute the vertical focal length factor (constant unless FOV changes)
    const fovVRad = (DEFAULT_VERTICAL_FOV_DEGREES * Math.PI) / 180;
    const halfFovTan = Math.tan(fovVRad / 2);

    function update() {
      rafRef.current = requestAnimationFrame(update);
      const img = imgRef.current;
      if (!img) return;

      const { calibration: cal, getLatestResult: getResult } = propsRef.current;
      const result = getResult();

      // Hide when face is lost or calibration hasn't produced a transform yet
      if (result.quality === 'none' || !result.glassesTransform || !result.faceMetrics) {
        img.style.opacity = '0';
        return;
      }

      const { position, quaternion } = result.glassesTransform;
      const { interPupillaryDistance } = result.faceMetrics;

      // depth = distance from camera to the glasses centre (positive metres)
      const depth = -position.z;
      if (depth < 0.05) {
        img.style.opacity = '0';
        return;
      }

      // Container = the full-viewport overlay div (100vw × 100vh)
      const cw = window.innerWidth;
      const ch = window.innerHeight;

      // Focal length in pixels (square pixels — same value for H and V axes)
      const focal = ch / 2 / halfFovTan;

      // ── Project 3D glasses centre → 2D screen pixel ─────────────────────
      // Camera is at origin, looking down -Z.  +X is right, +Y is up.
      // screenX = (worldX / depth) * focal + cw/2
      // screenY = -(worldY / depth) * focal + ch/2   (image Y grows downward)
      const screenX = (position.x / depth) * focal + cw / 2;
      const screenY = -(position.y / depth) * focal + ch / 2;

      // ── Compute glasses pixel width ──────────────────────────────────────
      // 1. User's IPD projected to screen pixels at this depth
      const ipdPx = (interPupillaryDistance / 1000 / depth) * focal;
      // 2. Scale frame width relative to the reference adult IPD (63 mm)
      //    and apply the per-frame defaultScale correction factor.
      const glassesWidthPx = (cal.frameWidth / REFERENCE_ADULT_IPD_MM) * ipdPx * cal.defaultScale;

      // ── Head roll for tilt ───────────────────────────────────────────────
      const roll = getRollDeg(quaternion);

      // ── Apply directly to DOM — NO setState, same 60fps pattern as GlassesScene ─
      img.style.opacity = '1';
      img.style.width = `${Math.max(60, glassesWidthPx)}px`;
      img.style.height = 'auto';
      img.style.left = `${screenX}px`;
      img.style.top = `${screenY}px`;
      // translate(-50%, -50%) centres the image on the projected point;
      // rotate(${roll}deg) tilts it with the head. scaleX(-1) on the parent
      // container already handles the left/right mirror flip.
      img.style.transform = `translate(-50%, -50%) rotate(${roll}deg)`;
    }

    rafRef.current = requestAnimationFrame(update);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []); // Intentionally empty — propsRef.current provides fresh values without re-registering

  return (
    <img
      ref={imgRef}
      src={pngUrl}
      alt=""
      draggable={false}
      style={{
        position: 'absolute',
        opacity: 0,
        pointerEvents: 'none',
        userSelect: 'none',
        // maxWidth: none so the computed width is never clamped by container CSS
        maxWidth: 'none',
        // Remove any default browser image border/outline
        border: 'none',
        outline: 'none',
      }}
    />
  );
}
