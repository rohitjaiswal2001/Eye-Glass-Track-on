/**
 * camera.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Camera permission/lifecycle state needs to be observable by React (to
 *   show "requesting permission" / "denied" / "ready" UI) while the actual
 *   `MediaStream` and `<video>` element are managed imperatively. This file
 *   defines the boundary between the two.
 *
 * WHAT IT DOES
 *   Declares `CameraStatus`, `CameraConfig`, and `CameraState`.
 *
 * HOW IT COMMUNICATES
 *   - `modules/camera/CameraManager.ts` produces `CameraState` transitions.
 *   - `hooks/useCamera.ts` subscribes and mirrors `CameraStatus` into React
 *     state (cheap, low-frequency updates only — NOT per-frame data).
 * ---------------------------------------------------------------------------
 */

export type CameraStatus =
  | 'idle'
  | 'requesting-permission'
  | 'streaming'
  | 'denied'
  | 'unavailable'
  | 'error';

export interface CameraConfig {
  /** Preferred capture width (device may return a different size). */
  width: number;
  /** Preferred capture height. */
  height: number;
  /** Preferred facing mode; 'user' = front-facing camera. */
  facingMode: 'user' | 'environment';
  /** Preferred frame rate hint passed to getUserMedia constraints. */
  frameRate: number;
}

export interface CameraState {
  status: CameraStatus;
  /** Human-readable error message when status is 'error' or 'denied'. */
  errorMessage: string | null;
  /** Actual negotiated stream resolution once streaming starts. */
  resolvedWidth: number | null;
  resolvedHeight: number | null;
}

export const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  width: 1280,
  height: 720,
  facingMode: 'user',
  frameRate: 30,
};
