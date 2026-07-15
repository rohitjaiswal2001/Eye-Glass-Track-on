/**
 * calibrationSchema.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   With hundreds of GLB models each shipping a hand-authored sidecar JSON,
 *   a single malformed or missing field (a typo'd key, a string where a
 *   number was expected) should fail loudly and specifically at load time —
 *   not silently produce `NaN` transforms that are hard to debug three
 *   modules downstream in the render loop.
 *
 * WHAT IT DOES
 *   `validateCalibrationData(raw)`: parses an unknown JSON blob against the
 *   `CalibrationData` contract using Zod, returning a discriminated
 *   `CalibrationValidationResult` with either the typed data or a list of
 *   human-readable field-level errors.
 *
 * HOW IT COMMUNICATES
 *   - `modules/modelLoader/ModelLoader.ts` calls this immediately after
 *     fetching each `frameXXX.json`, before constructing a `FrameAsset`.
 *     A frame that fails validation is skipped (with a logged warning)
 *     rather than allowed to corrupt the catalog.
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';
import type { CalibrationData, CalibrationValidationResult } from '../../core/types/calibration.types';

const calibrationDataSchema = z.object({
  frameId: z.string().min(1, 'frameId must be a non-empty string'),
  frameWidth: z.number().positive('frameWidth must be a positive number (mm)'),
  bridgeWidth: z.number().positive('bridgeWidth must be a positive number (mm)'),
  lensWidth: z.number().positive('lensWidth must be a positive number (mm)'),
  offsetX: z.number(),
  offsetY: z.number(),
  offsetZ: z.number(),
  rotationX: z.number(),
  rotationY: z.number(),
  rotationZ: z.number(),
  defaultScale: z.number().positive('defaultScale must be a positive number'),
  scaleX: z.number().optional(),
  scaleZ: z.number().optional(),
});


/** Validates a raw parsed-JSON value against the `CalibrationData` contract. */
export function validateCalibrationData(raw: unknown): CalibrationValidationResult {
  const result = calibrationDataSchema.safeParse(raw);

  if (result.success) {
    return { valid: true, data: result.data as CalibrationData };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });

  return { valid: false, errors };
}
