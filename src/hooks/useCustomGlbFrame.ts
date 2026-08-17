/**
 * useCustomGlbFrame.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   The 3D counterpart to `useCustomPngFrame`, and deliberately the same shape
 *   (`modelGroup`, `calibration`, `isLoading`, `error`) so `TryOnApp` can treat
 *   "catalog GLB", "uploaded GLB" and "uploaded PNG" as three interchangeable
 *   sources of one `THREE.Group` + `CalibrationData` pair. Nothing downstream —
 *   `GlassesScene`, `FrameManager`, `CalibrationEngine`, `CalibrationPanel` —
 *   needs to know which one is active.
 *
 * WHAT IT DOES
 *   - `uploadModel(files)`: parses the upload (`UploadedModelLoader`) and turns
 *     its derived auto-fit into a full `CalibrationData`, so the model arrives
 *     already centred on eye level at a sane physical width instead of wherever
 *     its author left it.
 *   - Surfaces `notice`: the non-fatal things worth telling the user about — a
 *     texture the model wanted but wasn't given, or a low-confidence
 *     orientation guess that may need a nudge in the fit panel.
 *   - `clear()` and unmount both dispose the current group's GPU resources.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` owns the file input and switches its active
 *     model source to this hook's output on upload.
 *   - The synthesized calibration flows into `CalibrationPanel`, whose "Copy
 *     JSON" then emits a complete sidecar (auto-fit included) that can be
 *     committed next to the GLB to promote the upload into the catalog.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import { disposeUploadedModel, loadUploadedModel } from '../modules/modelLoader/UploadedModelLoader';
import type { CalibrationData } from '../core/types/calibration.types';
import type { AutoFitResult } from '../modules/modelLoader/autoFitModel';

/**
 * Physical width an uploaded frame is fitted to (mm), temple tip to temple tip.
 * Matches `CalibrationEngine`'s reference adult face width, so a fresh upload
 * starts at "fits an average face" rather than at the model's authored scale,
 * which carries no reliable unit.
 */
const ASSUMED_FRAME_WIDTH_MM = 140;
/** Below this auto-fit score the front/back guess is shaky enough to warn about. */
const LOW_CONFIDENCE_THRESHOLD = 0.25;

export interface UseCustomGlbFrameResult {
  modelGroup: THREE.Group | null;
  calibration: CalibrationData | null;
  isLoading: boolean;
  error: string | null;
  /** Non-fatal warnings about the last upload (missing textures, shaky orientation). */
  notice: string | null;
  uploadModel: (files: File[]) => void;
  /** Turns the current upload upside down — the manual fix when auto-detection guesses wrong. */
  flipVertically: () => void;
  /** True when the current upload is showing flipped relative to what auto-fit chose. */
  isFlipped: boolean;
  clear: () => void;
}

function makeCalibration(fileName: string, autoFit: AutoFitResult): CalibrationData {
  const mmPerUnit = ASSUMED_FRAME_WIDTH_MM / autoFit.measured.width;
  return {
    frameId: `upload:${fileName}`,
    frameWidth: ASSUMED_FRAME_WIDTH_MM,
    // Derived from the model instead of guessed: these are display metadata,
    // but reporting the upload's real proportions is more useful than a stub.
    bridgeWidth: 18,
    lensWidth: Math.round(((autoFit.measured.width * mmPerUnit) - 18) / 2),
    offsetX: 0,
    offsetY: 0,
    // The auto-fit puts the frame's front plane at the anchor, so this is pure
    // clearance off the nose bridge — same starting value the catalog uses.
    offsetZ: 4,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    defaultScale: autoFit.defaultScale,
    modelPreTransform: autoFit.preTransform,
  };
}

export function useCustomGlbFrame(): UseCustomGlbFrameResult {
  const [modelGroup, setModelGroup] = useState<THREE.Group | null>(null);
  const [calibration, setCalibration] = useState<CalibrationData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isFlipped, setIsFlipped] = useState(false);
  const currentGroupRef = useRef<THREE.Group | null>(null);
  /** Kept so `flipVertically` can re-parse the same upload — see `UploadedModelOptions`. */
  const filesRef = useRef<File[]>([]);

  const disposeCurrent = useCallback(() => {
    if (currentGroupRef.current) {
      disposeUploadedModel(currentGroupRef.current);
      currentGroupRef.current = null;
    }
  }, []);

  const load = useCallback(
    (files: File[], flipVertically: boolean) => {
      setIsLoading(true);
      setError(null);
      setNotice(null);

      loadUploadedModel(files, ASSUMED_FRAME_WIDTH_MM, { flipVertically })
        .then(({ group, autoFit, fileName, missingResources }) => {
          disposeCurrent();
          currentGroupRef.current = group;
          setModelGroup(group);
          setCalibration(makeCalibration(fileName, autoFit));

          const warnings: string[] = [];
          if (missingResources.length > 0) {
            warnings.push(
              `${fileName} references ${missingResources.join(', ')}, which wasn't included — it will render untextured. ` +
                'Re-upload with those files selected alongside the model.',
            );
          }
          if (autoFit.confidence < LOW_CONFIDENCE_THRESHOLD) {
            warnings.push("This model's orientation was hard to detect — if it looks wrong, try ⇅ Flip or 🎚 Tune Fit.");
          }
          setNotice(warnings.length > 0 ? warnings.join(' ') : null);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load the uploaded 3D model.');
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [disposeCurrent],
  );

  const uploadModel = useCallback(
    (files: File[]) => {
      filesRef.current = files;
      setIsFlipped(false);
      load(files, false);
    },
    [load],
  );

  const flipVertically = useCallback(() => {
    if (filesRef.current.length === 0) return;
    const next = !isFlipped;
    setIsFlipped(next);
    load(filesRef.current, next);
  }, [isFlipped, load]);

  const clear = useCallback(() => {
    disposeCurrent();
    setModelGroup(null);
    setCalibration(null);
    setNotice(null);
    setError(null);
    setIsFlipped(false);
    filesRef.current = [];
  }, [disposeCurrent]);

  useEffect(() => {
    return () => {
      disposeCurrent();
    };
  }, [disposeCurrent]);

  return { modelGroup, calibration, isLoading, error, notice, uploadModel, flipVertically, isFlipped, clear };
}
