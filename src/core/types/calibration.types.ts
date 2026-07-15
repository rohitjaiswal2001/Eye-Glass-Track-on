/**
 * calibration.types.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   With hundreds of GLB eyewear models, each one authored by a different
 *   artist at a different real-world scale/pivot, we cannot hard-code
 *   per-model fudge factors in application code. Instead every model ships
 *   with a sidecar JSON describing its real physical dimensions and a small
 *   authored offset/rotation correction. This file is the strict contract
 *   for that JSON.
 *
 * WHAT IT DOES
 *   Declares `CalibrationData` (the on-disk JSON shape) and `FrameAsset`
 *   (the pairing of a GLB path with its calibration JSON, i.e. one catalog
 *   entry).
 *
 * HOW IT COMMUNICATES
 *   - Sits next to `modules/calibration/calibrationSchema.ts`, which validates
 *     JSON files on disk against this shape at load time (fail fast on
 *     malformed catalog entries instead of crashing mid-render).
 *   - `modules/modelLoader/ModelLoader.ts` produces `FrameAsset` (glb + json).
 *   - `modules/calibration/CalibrationEngine.ts` consumes `CalibrationData`
 *     alongside live `FaceMetrics` to compute the final per-user Transform.
 * ---------------------------------------------------------------------------
 */

/**
 * The sidecar JSON shipped alongside every `frameXXX.glb`.
 * All width/offset values are in millimeters unless noted; rotation values
 * are in degrees (authoring convenience) and converted to radians internally.
 */
export interface CalibrationData {
  /** Unique catalog id, must match the GLB filename stem (e.g. "frame001"). */
  frameId: string;
  /** Overall frame width, temple tip to temple tip (mm). Used to scale against user's faceWidth. */
  frameWidth: number;
  /** Bridge width — the gap that sits on the nose (mm). Used as a secondary scale reference. */
  bridgeWidth: number;
  /** Single-lens width (mm). Used for lens-relative effects (e.g. lens tint mapping). */
  lensWidth: number;
  /** Authored X offset correction (mm) applied after anchoring to the nose bridge. */
  offsetX: number;
  /** Authored Y offset correction (mm). */
  offsetY: number;
  /** Authored Z offset correction (mm), i.e. how far off the face the model sits. */
  offsetZ: number;
  /** Authored X rotation correction (degrees) to fix modeling-tool axis mismatches. */
  rotationX: number;
  /** Authored Y rotation correction (degrees). */
  rotationY: number;
  /** Authored Z rotation correction (degrees). */
  rotationZ: number;
  /** Fallback/base scale multiplier applied before dynamic face-based scaling. */
  defaultScale: number;
  /** Optional horizontal (width) scale factor (defaults to 1.0 if omitted). */
  scaleX?: number;
  /** Optional depth (temple length) scale factor (defaults to 1.0 if omitted). */
  scaleZ?: number;
}


/** One catalog entry: a loadable GLB (or transparent PNG) paired with its validated calibration data. */
export interface FrameAsset {
  frameId: string;
  glbUrl: string;
  calibration: CalibrationData;
  /** If set, this frame uses a pre-processed transparent PNG instead of (or in addition to) the GLB. */
  pngUrl?: string;
  /** Optional thumbnail for the FrameSelector UI. */
  thumbnailUrl?: string;
  /** Optional display name shown in UI (distinct from the internal frameId). */
  displayName?: string;
}

/**
 * One entry in the raw frame catalog manifest — i.e. what a manifest.json
 * listing hundreds of frames looks like BEFORE its calibration JSON has been
 * fetched and validated. `ModelLoader` turns this into a `FrameAsset`.
 *
 * PNG frames: if `pngUrl` is set and `glbUrl` is an empty string `""`, the
 * entry uses a pre-processed transparent PNG photo instead of a 3D GLB.
 * Both `glbUrl` and `pngUrl` CAN coexist, but in practice catalog PNG frames
 * only need `pngUrl`. `glbUrl` is kept so the TS interface stays consistent.
 */
export interface FrameManifestEntry {
  frameId: string;
  /** Path/URL to the GLB. Use an empty string ("") for PNG-only catalog frames. */
  glbUrl: string;
  jsonUrl: string;
  /** If set, load this transparent PNG photo as a flat 2-D tracked cutout. */
  pngUrl?: string;
  thumbnailUrl?: string;
  displayName?: string;
}

/** Result of validating a raw JSON blob against the CalibrationData contract. */
export type CalibrationValidationResult =
  | { valid: true; data: CalibrationData }
  | { valid: false; errors: string[] };
