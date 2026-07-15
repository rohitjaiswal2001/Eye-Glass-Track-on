/**
 * useFrameLoop.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   This is the hook that owns `FrameManager` — the imperative 60fps
 *   orchestrator. It deliberately does NOT surface per-frame tracking data
 *   as React state (that would mean 60 re-renders/sec). Instead it exposes
 *   `getLatestResult()`, a plain synchronous function meant to be called
 *   from inside an R3F `useFrame` callback, which runs outside React's
 *   render cycle entirely.
 *
 * WHAT IT DOES
 *   - Constructs one `FrameManager` (lazy ref), calls `initialize()` once.
 *   - Starts/stops the detection loop as `videoElement`/`cameraReady`
 *     become available or go away.
 *   - Exposes `setActiveCalibration` so `useGlassesModel` can push the
 *     currently-selected frame's calibration data in without re-creating
 *     the FrameManager.
 *   - Disposes everything on unmount.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` wires this hook's `videoElement` input from
 *     `useCamera`, and passes `getLatestResult`/`setActiveCalibration` down
 *     to `GlassesScene` and `useGlassesModel` respectively.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FrameManager, type FrameManagerOptions } from '../modules/frameManager/FrameManager';
import type { CalibrationData } from '../core/types/calibration.types';
import type { TrackingResult } from '../core/types/tracking.types';

export interface UseFrameLoopResult {
  /** Reads the latest tracking result. Call this inside `useFrame`, never inside component render. */
  getLatestResult: () => TrackingResult;
  setActiveCalibration: (calibration: CalibrationData | null) => void;
  /** True once the MediaPipe WASM runtime/model has finished loading. */
  isInitialized: boolean;
  /**
   * Set if `MediaPipeService.initialize()` rejected (WASM/model fetch failed —
   * commonly a network issue or a CORS/ad-blocker problem with the CDN in
   * `MediaPipeServiceOptions`). Previously this failure was silently
   * swallowed, leaving `isInitialized` stuck at `false` forever with no
   * visible error — this surfaces it so the UI can show something actionable
   * instead of just never showing the glasses.
   */
  initError: string | null;
}

export function useFrameLoop(
  videoElement: HTMLVideoElement | null,
  cameraReady: boolean,
  options?: FrameManagerOptions,
): UseFrameLoopResult {
  const managerRef = useRef<FrameManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new FrameManager(options);
  }
  const manager = managerRef.current;

  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    manager
      .initialize()
      .then(() => {
        if (!cancelled) setIsInitialized(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to load the face-tracking model. Check your network connection and try reloading.';
        console.error('FrameManager initialization failed:', err);
        setInitError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [manager]);

  useEffect(() => {
    if (isInitialized && cameraReady && videoElement) {
      manager.start(videoElement);
    }
    return () => {
      manager.stop();
    };
  }, [manager, isInitialized, cameraReady, videoElement]);

  useEffect(() => {
    return () => {
      manager.dispose();
    };
  }, [manager]);

  // Stable identities across renders — both `manager` itself and these
  // wrappers must not change reference on every render, or effects that
  // depend on them (e.g. useGlassesModel's calibration-sync effect) would
  // needlessly re-fire and reload assets on every unrelated re-render.
  const getLatestResult = useCallback(() => manager.getLatestResult(), [manager]);
  const setActiveCalibration = useCallback(
    (calibration: CalibrationData | null) => manager.setActiveCalibration(calibration),
    [manager],
  );

  return {
    getLatestResult,
    setActiveCalibration,
    isInitialized,
    initError,
  };
}
