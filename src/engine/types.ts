export type SizeMode = 'real' | 'fit';

/** User-adjustable fit parameters. Distances are real-world millimetres. */
export interface FitParams {
  /** 'real': true-to-life size from the model's units; 'fit': scale the frame to the face. */
  sizeMode: SizeMode;
  /** Overrides the detected total frame width (mm) — e.g. the value from the product page. */
  frameWidthMm: number | null;
  /** Overrides the measured pupillary distance (mm), e.g. from a prescription. */
  pdMm: number | null;
  /** Fine size multiplier (1 = exact). */
  sizeAdjust: number;
  /** Raise (+) / lower (−) the frame, mm. */
  offsetY: number;
  /** Move the frame away from (+) / toward (−) the face, mm. */
  offsetZ: number;
  /** Pantoscopic tilt: lower rim toward the cheeks, degrees. */
  tiltDeg: number;
  /** Extra temple spread at the ears, mm (per side). */
  templeAdjust: number;
}

export const DEFAULT_FIT: FitParams = {
  sizeMode: 'real',
  frameWidthMm: null,
  pdMm: null,
  sizeAdjust: 1,
  offsetY: 0,
  offsetZ: 0,
  tiltDeg: 5,
  templeAdjust: 0,
};

export type Quality = 'performance' | 'balanced' | 'quality';
export type Smoothing = 'low' | 'medium' | 'high';
export type Resolution = '480p' | '720p' | '1080p';

export interface EngineSettings {
  mirror: boolean;
  occlusion: boolean;
  hairOcclusion: boolean;
  autoLight: boolean;
  showFaceMesh: boolean;
  showOccluders: boolean;
  smoothing: Smoothing;
  quality: Quality;
  resolution: Resolution;
}

export const DEFAULT_SETTINGS: EngineSettings = {
  mirror: true,
  occlusion: true,
  hairOcclusion: false,
  autoLight: true,
  showFaceMesh: false,
  showOccluders: false,
  smoothing: 'medium',
  quality: 'balanced',
  resolution: '720p',
};

export type EnginePhase = 'idle' | 'loading' | 'running' | 'error';

export interface EngineStatus {
  phase: EnginePhase;
  message?: string;
  delegate?: 'GPU' | 'CPU';
}

export interface EngineStats {
  fps: number;
  detectMs: number;
  renderMs: number;
  faceDetected: boolean;
  videoWidth: number;
  videoHeight: number;
}

export type FitLabel = 'too-narrow' | 'narrow' | 'good' | 'wide' | 'too-wide';

export interface CalibrationState {
  /** 0‥1 progress of the iris-based face measurement. */
  progress: number;
  source: 'default' | 'iris' | 'manual';
  /** Measured (or entered) pupillary distance, mm. */
  pdMm: number;
  /** Frame width that best matches the face, mm. */
  recommendedWidthMm: number;
  /** Width of the frame as currently rendered, mm. */
  frameWidthMm: number | null;
  fitLabel: FitLabel | null;
}
