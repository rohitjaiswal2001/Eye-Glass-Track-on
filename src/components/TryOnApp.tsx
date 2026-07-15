/**
 * TryOnApp.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   This is the top-level composition root — the only place that wires
 *   camera → tracking → calibration → rendering → UI together. Every other
 *   module/component is independently reusable specifically because none of
 *   them know about each other directly; they only know their own inputs
 *   and outputs. This file is where those wires actually get connected.
 *
 * WHAT IT DOES
 *   - `useCamera`: camera permission + shared video element.
 *   - `useFrameLoop`: the imperative 60fps tracking pipeline.
 *   - `useFaceTracking`: coarse, low-frequency tracking-quality signal for UI.
 *   - Fetches `/models/manifest.json` (the frame catalog) once on mount.
 *   - `useGlassesModel` / `useCustomPngFrame`: two interchangeable model
 *     sources — a selected catalog GLB, or a user-uploaded PNG photo (via
 *     `PngGlassesBuilder`, a flat tracked cutout) — switched between via
 *     `frameSource` state; downstream code (`GlassesScene`,
 *     `CalibrationEngine`) doesn't know or care which is active.
 *   - Merges the active source's base calibration with live
 *     `CalibrationPanel` overrides (reset whenever the active frame
 *     changes) and pushes the result into `FrameManager` via
 *     `setActiveCalibration`.
 *   - Renders the mirrored video+3D composite (see the critical mirroring
 *     note in `WebcamLayer.tsx`), plus `FrameSelector`, `CaptureButton`, an
 *     optional `DebugOverlay`, and an optional `CalibrationPanel` for live
 *     fit tuning.
 *
 * HOW IT COMMUNICATES
 *   - Rendered once by `App.tsx`.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useCamera } from '../hooks/useCamera';
import { useFrameLoop } from '../hooks/useFrameLoop';
import { useFaceTracking } from '../hooks/useFaceTracking';
import { useGlassesModel } from '../hooks/useGlassesModel';
import { useCustomPngFrame } from '../hooks/useCustomPngFrame';
import { RendererCore } from '../modules/renderer/RendererCore';
import { PerformanceMonitor } from '../modules/performance/PerformanceMonitor';
import { WebcamLayer } from './WebcamLayer';
import { GlassesScene } from './GlassesScene';
import { PngFrameOverlay } from './PngFrameOverlay';
import { FrameSelector } from './FrameSelector';
import { DebugOverlay } from './DebugOverlay';
import { CaptureButton } from './CaptureButton';
import { CalibrationPanel, DEFAULT_CALIBRATION_OVERRIDES, mergeCalibrationOverrides, type CalibrationOverrides } from './CalibrationPanel';
import type { FrameManifestEntry } from '../core/types/calibration.types';

const MANIFEST_URL = '/models/manifest.json';

export function TryOnApp() {
  const camera = useCamera();
  const cameraReady = camera.status === 'streaming';

  const frameLoop = useFrameLoop(cameraReady ? camera.videoElement : null, cameraReady);
  const quality = useFaceTracking(frameLoop.getLatestResult);

  const performanceMonitorRef = useRef<PerformanceMonitor | null>(null);
  if (performanceMonitorRef.current === null) {
    performanceMonitorRef.current = new PerformanceMonitor();
  }

  const [catalog, setCatalog] = useState<FrameManifestEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<FrameManifestEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(MANIFEST_URL)
      .then((res) => res.json())
      .then((entries: FrameManifestEntry[]) => {
        if (cancelled) return;
        setCatalog(entries);
        setSelectedEntry((current) => current ?? entries[0] ?? null);
      })
      .catch((err: unknown) => {
        console.error('Failed to load frame catalog:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const glassesModel = useGlassesModel(selectedEntry);
  const customPngFrame = useCustomPngFrame();

  // Two possible model sources: the selected catalog GLB, or a user-uploaded
  // PNG. Both hooks expose the same shape (modelGroup + calibration), so the
  // rest of the app (GlassesScene, CalibrationEngine via FrameManager) never
  // needs to know or care which one is currently active.
  const [frameSource, setFrameSource] = useState<'catalog' | 'custom'>('catalog');

  // Detect whether the active catalog entry is a PNG-only frame (no GLB).
  // These frames are rendered by PngFrameOverlay in 2D screen space rather
  // than by GlassesScene in 3D — which gives a much more natural fit because
  // there is no perspective distortion from embedding a flat image in 3D space.
  const isCatalogPngFrame =
    frameSource === 'catalog' &&
    !!selectedEntry?.pngUrl &&
    !selectedEntry?.glbUrl;

  const activeModelGroup = frameSource === 'custom' ? customPngFrame.modelGroup : glassesModel.modelGroup;
  const baseCalibration = frameSource === 'custom' ? customPngFrame.calibration : glassesModel.calibration;
  const activeFrameId = frameSource === 'custom' ? (customPngFrame.calibration?.frameId ?? null) : (selectedEntry?.frameId ?? null);
  const activeError = frameSource === 'custom' ? customPngFrame.error : glassesModel.error;
  const activeIsLoading = frameSource === 'custom' ? customPngFrame.isLoading : glassesModel.isLoading;

  const [overrides, setOverrides] = useState<CalibrationOverrides>(DEFAULT_CALIBRATION_OVERRIDES);
  useEffect(() => {
    // Start fresh (no leftover tuning) whenever the active frame changes —
    // each frame (catalog or custom upload) has its own base calibration to tune against.
    setOverrides(DEFAULT_CALIBRATION_OVERRIDES);
  }, [activeFrameId]);

  const effectiveCalibration = useMemo(() => {
    if (!baseCalibration) return null;
    return mergeCalibrationOverrides(baseCalibration, overrides);
  }, [baseCalibration, overrides]);

  useEffect(() => {
    frameLoop.setActiveCalibration(effectiveCalibration);
  }, [effectiveCalibration, frameLoop]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSelectCatalogFrame = (entry: FrameManifestEntry) => {
    if (frameSource === 'custom') {
      customPngFrame.clear();
      setFrameSource('catalog');
    }
    setSelectedEntry(entry);
  };

  const handlePngUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // reset so re-selecting the same file still fires onChange
    if (!file) return;
    customPngFrame.uploadPng(file);
    setFrameSource('custom');
  };

  const [glCanvas, setGlCanvas] = useState<HTMLCanvasElement | null>(null);

  const aspectRatio = useMemo(() => {
    if (camera.resolvedWidth && camera.resolvedHeight) {
      return camera.resolvedWidth / camera.resolvedHeight;
    }
    return 16 / 9;
  }, [camera.resolvedWidth, camera.resolvedHeight]);

  const [showDebug, setShowDebug] = useState(false);
  const [showCalibrationPanel, setShowCalibrationPanel] = useState(false);
  const [mirrorView, setMirrorView] = useState(true);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000', overflow: 'hidden' }}>
      {/*
        Single composite-level mirror, toggleable via `mirrorView`. Both the
        video and the 3D canvas are rendered in the SAME natural (unmirrored)
        coordinate space that MediaPipe's landmarks live in, then flipped
        together as one unit when mirrorView is true — see WebcamLayer.tsx's
        doc comment for why mirroring them independently would desync the
        glasses from the face. Toggling this affects ONLY the display
        transform; tracking math is completely unaffected either way.
      */}
      <div style={{ position: 'absolute', inset: 0, transform: mirrorView ? 'scaleX(-1)' : 'none' }}>
        {cameraReady && <WebcamLayer videoElement={camera.videoElement} />}
        <RendererCore aspectRatio={aspectRatio} onCanvasReady={setGlCanvas}>
          <GlassesScene
            // For PNG catalog frames, the 2D overlay (below) provides the visual;
            // pass null here so GlassesScene renders nothing in the 3D canvas.
            modelGroup={isCatalogPngFrame ? null : activeModelGroup}
            getLatestResult={frameLoop.getLatestResult}
            performanceMonitor={performanceMonitorRef.current}
            calibration={effectiveCalibration}
          />
        </RendererCore>


        {/* 2D screen-space PNG overlay — only active for PNG catalog frames.
            Must be INSIDE the scaleX(-1) container so mirroring is consistent
            with the webcam video behind it. */}
        {isCatalogPngFrame && effectiveCalibration && selectedEntry?.pngUrl && (
          <PngFrameOverlay
            pngUrl={selectedEntry.pngUrl}
            calibration={effectiveCalibration}
            getLatestResult={frameLoop.getLatestResult}
          />
        )}
      </div>

      {camera.status === 'requesting-permission' && <CenteredMessage>Requesting camera access…</CenteredMessage>}
      {camera.status === 'denied' && (
        <CenteredMessage>Camera permission was denied. Please allow camera access to try on glasses.</CenteredMessage>
      )}
      {camera.status === 'unavailable' && (
        <CenteredMessage>{camera.errorMessage ?? 'No camera is available on this device.'}</CenteredMessage>
      )}
      {camera.status === 'error' && (
        <CenteredMessage>{camera.errorMessage ?? 'Something went wrong accessing the camera.'}</CenteredMessage>
      )}
      {frameLoop.initError && (
        <CenteredMessage>
          Failed to load the face-tracking model: {frameLoop.initError}
          <br />
          Check your internet connection and reload the page.
        </CenteredMessage>
      )}
      {!frameLoop.initError && cameraReady && !frameLoop.isInitialized && (
        <CenteredMessage>Loading face-tracking model…</CenteredMessage>
      )}
      {cameraReady && frameLoop.isInitialized && quality === 'none' && (
        <CenteredMessage>Position your face in the frame.</CenteredMessage>
      )}
      {activeIsLoading && <CenteredMessage>Loading glasses…</CenteredMessage>}
      {activeError && <CenteredMessage>{activeError}</CenteredMessage>}

      {showDebug && (
        <DebugOverlay
          getLatestResult={frameLoop.getLatestResult}
          performanceMonitor={performanceMonitorRef.current}
          cameraState={camera}
          isInitialized={frameLoop.isInitialized}
          initError={frameLoop.initError}
          activeCalibration={effectiveCalibration}
          selectedFrameId={activeFrameId}
          catalogSize={catalog.length}
        />
      )}

      {showCalibrationPanel && baseCalibration && (
        <CalibrationPanel
          baseCalibration={baseCalibration}
          overrides={overrides}
          onChange={setOverrides}
          onReset={() => setOverrides(DEFAULT_CALIBRATION_OVERRIDES)}
        />
      )}

      <div
        style={{
          position: 'absolute',
          bottom: 20,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
        }}
      >
        {catalog.length > 0 && (
          <FrameSelector catalog={catalog} selectedFrameId={frameSource === 'catalog' ? selectedEntry?.frameId ?? null : null} onSelect={handleSelectCatalogFrame} />
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          <CaptureButton videoElement={camera.videoElement} glCanvas={glCanvas} mirrored={mirrorView} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handlePngUpload}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '10px 16px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.3)',
              background: frameSource === 'custom' ? 'rgba(79,157,255,0.25)' : 'transparent',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
            title="Upload your own glasses photo (PNG with a transparent background works best)"
          >
            📁 Upload Glasses PNG
          </button>
          <button
            onClick={() => setShowDebug((v) => !v)}
            style={{
              padding: '10px 16px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.3)',
              background: 'transparent',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {showDebug ? 'Hide' : 'Show'} Debug
          </button>
          <button
            onClick={() => setShowCalibrationPanel((v) => !v)}
            style={{
              padding: '10px 16px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.3)',
              background: showCalibrationPanel ? 'rgba(79,157,255,0.25)' : 'transparent',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            🎚 Tune Fit
          </button>
          <button
            onClick={() => setMirrorView((v) => !v)}
            style={{
              padding: '10px 16px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.3)',
              background: 'transparent',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
            title="Toggle between selfie-mirrored and true (unmirrored) view"
          >
            🔄 {mirrorView ? 'Mirrored' : 'True View'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: 16,
        textAlign: 'center',
        padding: 24,
        background: 'rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  );
}

export default TryOnApp;
