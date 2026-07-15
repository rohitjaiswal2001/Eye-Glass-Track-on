/**
 * useGlassesModel.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Switching the active eyewear frame involves two async, cacheable
 *   operations (fetch+validate JSON, load+clone GLB) that shouldn't block
 *   rendering and shouldn't leak GPU memory across hundreds of switches.
 *   This hook is the React-facing wrapper around `ModelLoader` that also
 *   keeps `FrameManager`'s active calibration in sync automatically.
 *
 * WHAT IT DOES
 *   - Owns one `ModelLoader` instance (lazy ref) for the component's lifetime.
 *   - On `entry` change: loads the calibration JSON + a fresh GLB clone,
 *     exposes the resulting `THREE.Group` plus loading/error state.
 *   - Calls `onCalibrationChange` (typically `useFrameLoop`'s
 *     `setActiveCalibration`) whenever the resolved calibration changes, so
 *     `CalibrationEngine` always has the right data for the frame currently
 *     on screen — including clearing it back to `null` if `entry` is `null`.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` passes the user's selected `FrameManifestEntry`
 *     (from `FrameSelector`) and `useFrameLoop`'s `setActiveCalibration`.
 *   - The returned `modelGroup` is attached to the scene by `GlassesScene`.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import { ModelLoader } from '../modules/modelLoader/ModelLoader';
import type { CalibrationData, FrameManifestEntry } from '../core/types/calibration.types';

export interface UseGlassesModelResult {
  modelGroup: THREE.Group | null;
  calibration: CalibrationData | null;
  isLoading: boolean;
  error: string | null;
}

export function useGlassesModel(
  entry: FrameManifestEntry | null,
  onCalibrationChange?: (calibration: CalibrationData | null) => void,
): UseGlassesModelResult {
  const loaderRef = useRef<ModelLoader | null>(null);
  if (loaderRef.current === null) {
    loaderRef.current = new ModelLoader();
  }
  const loader = loaderRef.current;

  const [modelGroup, setModelGroup] = useState<THREE.Group | null>(null);
  const [calibration, setCalibration] = useState<CalibrationData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entry) {
      setModelGroup(null);
      setCalibration(null);
      onCalibrationChange?.(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    Promise.all([loader.loadFrame(entry), loader.getModelInstance(entry)])
      .then(([asset, group]) => {
        if (cancelled) return;
        setModelGroup(group);
        setCalibration(asset.calibration);
        onCalibrationChange?.(asset.calibration);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load the selected frame.');
        setModelGroup(null);
        setCalibration(null);
        onCalibrationChange?.(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Re-run only when the selected frame's identity actually changes.
  }, [entry?.frameId, entry?.glbUrl, entry?.jsonUrl, loader, onCalibrationChange]);

  useEffect(() => {
    return () => {
      loader.disposeAll();
    };
  }, [loader]);

  return { modelGroup, calibration, isLoading, error };
}
