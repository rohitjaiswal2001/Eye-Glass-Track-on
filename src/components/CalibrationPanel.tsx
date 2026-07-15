/**
 * CalibrationPanel.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Per-frame calibration (`offsetX/Y/Z`, `rotationX/Y/Z`, `defaultScale`) is
 *   always going to need some by-eye tuning — different GLB authoring tools,
 *   pivot points, and canonical-model deviations mean no formula gets this
 *   perfectly right out of the box. Rather than tune these values blind
 *   (guess a number, rebuild, ask the user to check, repeat), this panel
 *   lets the user drag sliders and see the glasses move LIVE, then copy the
 *   final numbers straight into the frame's `frameXXX.json` — turning a
 *   slow, indirect feedback loop into an immediate, self-serve one.
 *
 * WHAT IT DOES
 *   Renders sliders for a small `CalibrationOverrides` delta, which
 *   `TryOnApp` merges on top of the currently-loaded frame's base
 *   `CalibrationData` (see `mergeCalibrationOverrides`) and pushes into
 *   `FrameManager` every time it changes — so `CalibrationEngine` picks up
 *   the live-tuned values on the very next tracked frame.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` owns the `CalibrationOverrides` state,
 *     resets it whenever the selected frame changes, and computes the
 *     merged `CalibrationData` passed to `useFrameLoop`'s
 *     `setActiveCalibration`.
 * ---------------------------------------------------------------------------
 */

import type { CalibrationData } from '../core/types/calibration.types';

export interface CalibrationOverrides {
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  /** Multiplies `calibration.defaultScale` (1.0 = no change). */
  scaleMultiplier: number;
  /** Multiplies horizontal width scale (1.0 = no change). */
  scaleXMultiplier: number;
  /** Multiplies depth/temple scale (1.0 = no change). */
  scaleZMultiplier: number;
}

export const DEFAULT_CALIBRATION_OVERRIDES: CalibrationOverrides = {
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  scaleMultiplier: 1,
  scaleXMultiplier: 1,
  scaleZMultiplier: 1,
};

/** Combines a frame's base calibration with a live tuning delta into one final `CalibrationData`. */
export function mergeCalibrationOverrides(base: CalibrationData, overrides: CalibrationOverrides): CalibrationData {
  return {
    ...base,
    offsetX: base.offsetX + overrides.offsetX,
    offsetY: base.offsetY + overrides.offsetY,
    offsetZ: base.offsetZ + overrides.offsetZ,
    rotationX: base.rotationX + overrides.rotationX,
    rotationY: base.rotationY + overrides.rotationY,
    rotationZ: base.rotationZ + overrides.rotationZ,
    defaultScale: base.defaultScale * overrides.scaleMultiplier,
    scaleX: (base.scaleX ?? 1) * overrides.scaleXMultiplier,
    scaleZ: (base.scaleZ ?? 1) * overrides.scaleZMultiplier,
  };
}

export interface CalibrationPanelProps {
  baseCalibration: CalibrationData;
  overrides: CalibrationOverrides;
  onChange: (overrides: CalibrationOverrides) => void;
  onReset: () => void;
}

interface SliderSpec {
  label: string;
  key: keyof CalibrationOverrides;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const SLIDERS: SliderSpec[] = [
  { label: 'Offset X (left/right)', key: 'offsetX', min: -60, max: 60, step: 0.5, unit: 'mm' },
  { label: 'Offset Y (up/down)', key: 'offsetY', min: -60, max: 60, step: 0.5, unit: 'mm' },
  { label: 'Offset Z (near/far)', key: 'offsetZ', min: -60, max: 60, step: 0.5, unit: 'mm' },
  { label: 'Rotation X (pitch)', key: 'rotationX', min: -45, max: 45, step: 0.5, unit: '°' },
  { label: 'Rotation Y (yaw)', key: 'rotationY', min: -45, max: 45, step: 0.5, unit: '°' },
  { label: 'Rotation Z (roll)', key: 'rotationZ', min: -45, max: 45, step: 0.5, unit: '°' },
  { label: 'Overall Scale', key: 'scaleMultiplier', min: 0.2, max: 3, step: 0.01, unit: '×' },
  { label: 'Frame Width (X)', key: 'scaleXMultiplier', min: 0.5, max: 2, step: 0.01, unit: '×' },
  { label: 'Temple Length (Z)', key: 'scaleZMultiplier', min: 0.5, max: 2, step: 0.01, unit: '×' },
];


export function CalibrationPanel({ baseCalibration, overrides, onChange, onReset }: CalibrationPanelProps) {
  const finalCalibration = mergeCalibrationOverrides(baseCalibration, overrides);

  const handleCopy = () => {
    const json = JSON.stringify(finalCalibration, null, 2);
    navigator.clipboard?.writeText(json).catch(() => {
      console.warn('Clipboard write failed — final calibration JSON:', json);
    });
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 240,
        padding: 14,
        borderRadius: 10,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <strong style={{ color: '#fff', fontSize: 13 }}>Fit Tuning — {baseCalibration.frameId}</strong>
      <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, lineHeight: 1.4 }}>
        Drag until the glasses sit correctly, then copy the JSON below into this frame's calibration file.
      </span>

      {SLIDERS.map((spec) => (
        <label key={spec.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: '#fff' }}>
          <span>
            {spec.label}: {overrides[spec.key].toFixed(2)}
            {spec.unit}
          </span>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={overrides[spec.key]}
            onChange={(e) => onChange({ ...overrides, [spec.key]: parseFloat(e.target.value) })}
          />
        </label>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          onClick={onReset}
          style={{
            flex: 1,
            padding: '6px 8px',
            fontSize: 11,
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.3)',
            background: 'transparent',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Reset
        </button>
        <button
          onClick={handleCopy}
          style={{
            flex: 1,
            padding: '6px 8px',
            fontSize: 11,
            borderRadius: 6,
            border: 'none',
            background: '#4f9dff',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Copy JSON
        </button>
      </div>

      <pre
        style={{
          margin: 0,
          fontSize: 9,
          color: 'rgba(255,255,255,0.5)',
          maxHeight: 90,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {JSON.stringify(finalCalibration, null, 1)}
      </pre>
    </div>
  );
}
