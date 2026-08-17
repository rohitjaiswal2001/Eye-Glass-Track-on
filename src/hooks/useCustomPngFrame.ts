/**
 * useCustomPngFrame.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   React-facing wrapper around `PngGlassesBuilder` — mirrors
 *   `useGlassesModel`'s shape (`modelGroup`, `calibration`, `isLoading`,
 *   `error`) so `TryOnApp` can switch between "catalog GLB" and "custom
 *   PNG upload" sources with the same downstream wiring (both ultimately
 *   just produce a `THREE.Group` + `CalibrationData` for `GlassesScene` and
 *   `FrameManager` to use — neither of those modules needs to know which
 *   source it came from).
 *
 * WHAT IT DOES
 *   - `uploadPng(file)`: loads the image, builds the plane group, and
 *     synthesizes a reasonable default `CalibrationData` (no per-model
 *     JSON exists for a user upload — these are deliberately conservative
 *     starting values meant to be refined with `CalibrationPanel`, exactly
 *     like a brand-new catalog frame would be).
 *   - `clear()`: disposes the current group's GPU resources and resets state.
 *   - Automatically disposes the current group when a new one is uploaded
 *     or the hook unmounts.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` owns the upload UI trigger and switches its
 *     active model source to this hook's output when a file is uploaded.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import { buildPngGlassesGroup, disposePngGlassesGroup, loadPngAsTexture } from '../modules/modelLoader/PngGlassesBuilder';
import type { CalibrationData } from '../core/types/calibration.types';

export interface UseCustomPngFrameResult {
  modelGroup: THREE.Group | null;
  calibration: CalibrationData | null;
  isLoading: boolean;
  error: string | null;
  uploadPng: (file: File) => void;
  clear: () => void;
}

/**
 * Default calibration for a fresh PNG upload — no sidecar JSON exists for a
 * user's own photo, so these are the starting values, still tunable live via
 * `CalibrationPanel`.
 *
 * `offsetY`/`offsetZ` are not zeroed out: they're the values that came out of
 * tuning real uploads, and they are systematic rather than per-photo. A glasses
 * PHOTO is framed differently from a 3D model — it's cropped to the frame's
 * own bounding box, so its centre sits at the middle of the lenses rather than
 * at the bridge, which reads ~10mm high against the tracked nose bridge, and it
 * needs more clearance off the face because a flat plane can't wrap around it.
 * Starting from a fit that's roughly right beats starting from a fit that's
 * reliably wrong in the same direction every time.
 */
function makeDefaultCalibration(fileName: string): CalibrationData {
  return {
    frameId: `custom:${fileName}`,
    frameWidth: 140,
    bridgeWidth: 18,
    lensWidth: 54,
    offsetX: 0,
    offsetY: -10,
    offsetZ: 8.5,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    defaultScale: 1,
    scaleX: 1,
    scaleZ: 1,
  };
}

export function useCustomPngFrame(onCalibrationChange?: (calibration: CalibrationData | null) => void): UseCustomPngFrameResult {
  const [modelGroup, setModelGroup] = useState<THREE.Group | null>(null);
  const [calibration, setCalibration] = useState<CalibrationData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentGroupRef = useRef<THREE.Group | null>(null);

  const disposeCurrent = useCallback(() => {
    if (currentGroupRef.current) {
      disposePngGlassesGroup(currentGroupRef.current);
      currentGroupRef.current = null;
    }
  }, []);

  const uploadPng = useCallback(
    (file: File) => {
      setIsLoading(true);
      setError(null);

      loadPngAsTexture(file)
        .then(({ texture, width, height }) => {
          disposeCurrent();
          const group = buildPngGlassesGroup(texture, width, height);
          currentGroupRef.current = group;
          const newCalibration = makeDefaultCalibration(file.name);
          setModelGroup(group);
          setCalibration(newCalibration);
          onCalibrationChange?.(newCalibration);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load the uploaded image.');
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [disposeCurrent, onCalibrationChange],
  );

  const clear = useCallback(() => {
    disposeCurrent();
    setModelGroup(null);
    setCalibration(null);
    onCalibrationChange?.(null);
  }, [disposeCurrent, onCalibrationChange]);

  useEffect(() => {
    return () => {
      disposeCurrent();
    };
  }, [disposeCurrent]);

  return { modelGroup, calibration, isLoading, error, uploadPng, clear };
}
