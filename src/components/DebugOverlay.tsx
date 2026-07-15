/**
 * DebugOverlay.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Development and QA need visibility into whether the "~60fps, no
 *   jitter" requirements are actually being met live, AND into exactly what
 *   values are driving the glasses' fit (position/scale/rotation) without
 *   opening devtools — this is what let us diagnose both the camera-unit
 *   bug and the near-clip-plane bug in previous debugging rounds.
 *
 * WHAT IT DOES
 *   Polls on a low-frequency timer (default 500ms) — deliberately NOT inside
 *   the render loop, so this debug UI never itself becomes a performance
 *   cost — and displays:
 *     - Render/tracking FPS, detection latency, frame time
 *     - Tracking quality, head pose / face metrics tracked state
 *     - RAW (pre-smoothing) vs SMOOTHED head pose side by side, including the
 *       delta between them — makes the smoothing filters' effect visible
 *       instead of a black box, and helps spot excessive lag or residual jitter
 *     - Full numeric face metrics (IPD / face width / face height, mm)
 *     - The exact computed glasses transform (position/scale/rotation)
 *     - The ACTIVE calibration values in effect right now (base + any live
 *       CalibrationPanel overrides already merged in) — critical for seeing
 *       exactly what's driving the current fit
 *     - Camera status and resolved resolution
 *     - MediaPipe initialization state/errors
 *     - Which frame is selected and how many are in the catalog
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` renders this conditionally (behind "Show
 *     Debug"), passing `useFrameLoop`'s `getLatestResult`, the shared
 *     `PerformanceMonitor`, `useCamera`'s state, and catalog/frame info.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { TrackingResult } from '../core/types/tracking.types';
import type { PerformanceStats } from '../core/types/performance.types';
import type { CameraState } from '../core/types/camera.types';
import type { CalibrationData } from '../core/types/calibration.types';
import type { PerformanceMonitor } from '../modules/performance/PerformanceMonitor';
import { radToDeg } from '../core/math/scalar';
import { toEulerYXZ } from '../core/math/quaternion';

export interface DebugOverlayProps {
  getLatestResult: () => TrackingResult;
  performanceMonitor: PerformanceMonitor;
  cameraState: CameraState;
  isInitialized: boolean;
  initError: string | null;
  activeCalibration: CalibrationData | null;
  selectedFrameId: string | null;
  catalogSize: number;
  pollIntervalMs?: number;
}

const EMPTY_STATS: PerformanceStats = {
  renderFps: 0,
  trackingFps: 0,
  detectionLatencyMs: 0,
  frameTimeMs: 0,
  sampledAtMs: 0,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginBottom: 2, marginTop: 6 }}>{title}</div>
      {children}
    </div>
  );
}

export function DebugOverlay({
  getLatestResult,
  performanceMonitor,
  cameraState,
  isInitialized,
  initError,
  activeCalibration,
  selectedFrameId,
  catalogSize,
  pollIntervalMs = 500,
}: DebugOverlayProps) {
  const [stats, setStats] = useState<PerformanceStats>(EMPTY_STATS);
  const [result, setResult] = useState<TrackingResult | null>(null);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setStats(performanceMonitor.getStats());
      setResult(getLatestResult());
    }, pollIntervalMs);
    return () => clearInterval(intervalId);
  }, [getLatestResult, performanceMonitor, pollIntervalMs]);

  const transform = result?.glassesTransform;
  const headPose = result?.headPose;

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        width: 290,
        maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto',
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.72)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.55,
        pointerEvents: 'auto',
        whiteSpace: 'pre-wrap',
      }}
    >
      <Section title="TRACKING">
        <div>quality: {result?.quality ?? 'none'}</div>
        <div>head pose: {headPose ? (headPose.isTracked ? 'tracked' : 'held (recent loss)') : 'null'}</div>
        <div>face metrics: {result?.faceMetrics ? 'tracked' : 'null'}</div>
      </Section>

      <Section title="PERFORMANCE">
        <div>render fps: {stats.renderFps.toFixed(1)}</div>
        <div>tracking fps: {stats.trackingFps.toFixed(1)}</div>
        <div>detection latency: {stats.detectionLatencyMs.toFixed(1)}ms</div>
        <div>frame time: {stats.frameTimeMs.toFixed(1)}ms</div>
      </Section>

      <Section title="HEAD POSE — RAW (mm, pre-smoothing)">
        {result?.rawHeadPose ? (
          <>
            <div>
              pos: ({result.rawHeadPose.position.x.toFixed(1)}, {result.rawHeadPose.position.y.toFixed(1)},{' '}
              {result.rawHeadPose.position.z.toFixed(1)})
            </div>
            <div>
              euler: pitch={radToDeg(result.rawHeadPose.euler.pitch).toFixed(1)}° yaw=
              {radToDeg(result.rawHeadPose.euler.yaw).toFixed(1)}° roll={radToDeg(result.rawHeadPose.euler.roll).toFixed(1)}°
            </div>
          </>
        ) : (
          <div>null</div>
        )}
      </Section>

      <Section title="HEAD POSE — SMOOTHED (mm)">
        {headPose ? (
          <>
            <div>
              pos: ({headPose.position.x.toFixed(1)}, {headPose.position.y.toFixed(1)}, {headPose.position.z.toFixed(1)})
            </div>
            <div>
              euler: pitch={radToDeg(headPose.euler.pitch).toFixed(1)}° yaw=
              {radToDeg(headPose.euler.yaw).toFixed(1)}° roll={radToDeg(headPose.euler.roll).toFixed(1)}°
            </div>
            {result?.rawHeadPose && (
              <div style={{ color: 'rgba(0,255,0,0.55)' }}>
                Δpos: (
                {(headPose.position.x - result.rawHeadPose.position.x).toFixed(2)},{' '}
                {(headPose.position.y - result.rawHeadPose.position.y).toFixed(2)},{' '}
                {(headPose.position.z - result.rawHeadPose.position.z).toFixed(2)}) — smoothing correction
              </div>
            )}
          </>
        ) : (
          <div>null</div>
        )}
      </Section>

      <Section title="FACE METRICS (mm)">
        {result?.faceMetrics ? (
          <>
            <div>interpupillary distance: {result.faceMetrics.interPupillaryDistance.toFixed(1)}</div>
            <div>face width: {result.faceMetrics.faceWidth.toFixed(1)}</div>
            <div>face height: {result.faceMetrics.faceHeight.toFixed(1)}</div>
            <div style={{ color: 'rgba(0,255,0,0.7)' }}>
              nose bridge anchor: ({result.faceMetrics.noseBridgeMetric.x.toFixed(1)},{' '}
              {result.faceMetrics.noseBridgeMetric.y.toFixed(1)}, {result.faceMetrics.noseBridgeMetric.z.toFixed(1)})
            </div>
          </>
        ) : (
          <div>null</div>
        )}
      </Section>

      <Section title="GLASSES TRANSFORM (scene units)">
        {transform ? (
          <>
            <div>
              pos: ({transform.position.x.toFixed(4)}, {transform.position.y.toFixed(4)}, {transform.position.z.toFixed(4)})
            </div>
            <div>scale: {transform.scale.x.toFixed(3)}</div>
            {(() => {
              const euler = toEulerYXZ(transform.quaternion);
              return (
                <div>
                  rotation: pitch={radToDeg(euler.pitch).toFixed(1)}° yaw={radToDeg(euler.yaw).toFixed(1)}° roll=
                  {radToDeg(euler.roll).toFixed(1)}°
                </div>
              );
            })()}
          </>
        ) : (
          <div>null — nothing will render</div>
        )}
      </Section>

      <Section title="ACTIVE CALIBRATION (mm / deg)">
        {activeCalibration ? (
          <>
            <div>
              offset: ({activeCalibration.offsetX.toFixed(1)}, {activeCalibration.offsetY.toFixed(1)}, {activeCalibration.offsetZ.toFixed(1)})
            </div>
            <div>
              rotation: ({activeCalibration.rotationX.toFixed(1)}, {activeCalibration.rotationY.toFixed(1)}, {activeCalibration.rotationZ.toFixed(1)})
            </div>
            <div>defaultScale: {activeCalibration.defaultScale.toFixed(3)}</div>
            <div>
              frame dims: {activeCalibration.frameWidth}/{activeCalibration.bridgeWidth}/{activeCalibration.lensWidth}mm
            </div>
          </>
        ) : (
          <div>null (no frame active)</div>
        )}
      </Section>

      <Section title="CAMERA">
        <div>status: {cameraState.status}</div>
        <div>
          resolution: {cameraState.resolvedWidth ?? '?'}x{cameraState.resolvedHeight ?? '?'}
        </div>
        {cameraState.errorMessage && <div>error: {cameraState.errorMessage}</div>}
      </Section>

      <Section title="MEDIAPIPE">
        <div>initialized: {isInitialized ? 'yes' : 'loading…'}</div>
        {initError && <div>error: {initError}</div>}
      </Section>

      <Section title="CATALOG">
        <div>
          selected: {selectedFrameId ?? 'none'} ({catalogSize} total)
        </div>
      </Section>
    </div>
  );
}
