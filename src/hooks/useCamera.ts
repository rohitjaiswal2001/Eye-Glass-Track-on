/**
 * useCamera.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   `CameraManager` (modules/camera) is a plain class with a pub/sub — this
 *   hook is the thin adapter that mirrors its state into React so a
 *   component can render "requesting permission…" / "camera denied" / etc.
 *   The manager instance itself is created once (via a lazy ref) and lives
 *   for the component's lifetime; only its STATUS changes trigger re-renders
 *   here — the actual video frames never touch React.
 *
 * WHAT IT DOES
 *   - Constructs one `CameraManager`, starts it, subscribes to state changes.
 *   - Disposes the manager (stopping the camera hardware) on unmount.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` calls this once; passes `videoElement` down
 *     to both `useFrameLoop` (for MediaPipe detection) and `WebcamLayer`
 *     (for the visual backdrop) — the same shared element, per the
 *     single-camera-open design in `CameraManager`'s own doc comment.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraManager } from '../modules/camera/CameraManager';
import type { CameraConfig, CameraState } from '../core/types/camera.types';

export interface UseCameraResult extends CameraState {
  videoElement: HTMLVideoElement;
  start: () => void;
  stop: () => void;
}

export function useCamera(config?: Partial<CameraConfig>): UseCameraResult {
  // Lazy-initialized once; `config` is only read on first render by design —
  // camera constraints aren't expected to change mid-session.
  const managerRef = useRef<CameraManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new CameraManager(config);
  }
  const manager = managerRef.current;

  const [state, setState] = useState<CameraState>(() => manager.getState());

  useEffect(() => {
    const unsubscribe = manager.subscribe(setState);
    manager.start();
    return () => {
      unsubscribe();
      manager.dispose();
    };
    // `manager` is stable for the component's lifetime (see lazy ref above).
  }, [manager]);

  const start = useCallback(() => {
    void manager.start();
  }, [manager]);
  const stop = useCallback(() => manager.stop(), [manager]);

  return {
    ...state,
    videoElement: manager.getVideoElement(),
    start,
    stop,
  };
}
