import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CANONICAL_POSITIONS, CANONICAL_VERTEX_COUNT } from './canonicalFace';
import { CAMERA_FAR, CAMERA_NEAR, FOV_Y_DEG, OCCLUSION_BIAS_CM } from './constants';
import { FaceCalibrator } from './faceProfile';
import { FaceReconstruction } from './faceReconstruction';
import { getFaceTracker, type FaceTracker } from './faceTracker';
import { createFitResult, solveFit } from './fitSolver';
import type { GlassesAsset } from './glassesAsset';
import { HairSegmenter } from './hairSegmenter';
import { ModelLoader } from './modelLoader';
import { Occluders } from './occluders';
import { PoseFilter, SMOOTHING_PRESETS } from './oneEuro';
import {
  DEFAULT_FIT,
  DEFAULT_SETTINGS,
  type CalibrationState,
  type EngineSettings,
  type EngineStats,
  type EngineStatus,
  type FitParams,
  type Resolution,
} from './types';

interface EventMap {
  status: EngineStatus;
  stats: EngineStats;
  calibration: CalibrationState;
}

const RESOLUTIONS: Record<Resolution, [number, number]> = {
  '480p': [640, 480],
  '720p': [1280, 720],
  '1080p': [1920, 1080],
};

/** Keep showing the last pose this long after tracking drops (avoids flicker on blinks/fast turns). */
const FACE_HOLD_MS = 250;
/** After this long without a face, forget the calibration (someone else may step in). */
const FACE_RESET_MS = 2500;

/**
 * Real-time eyewear try-on renderer.
 *
 * Coordinate systems:
 *  - camera space (cm, OpenGL): scene root; MediaPipe's pose matrix maps into it;
 *  - canonical face space (cm): `faceAnchor` children (glasses, head/ear occluders).
 *
 * Tracking and rendering run once per decoded camera frame (requestVideoFrameCallback) and
 * the video is drawn as the scene background, so glasses and face are always in sync.
 */
export class TryOnEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly loader: ModelLoader;
  private readonly container: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_Y_DEG, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
  private readonly faceAnchor = new THREE.Group();
  private readonly glassesPivot = new THREE.Group();
  private readonly occluders = new Occluders();
  private readonly light = new THREE.DirectionalLight(0xffffff, 1.1);
  private readonly envTexture: THREE.Texture;
  private readonly recon = new FaceReconstruction();
  private readonly calibrator = new FaceCalibrator();
  private readonly poseFilter = new PoseFilter();
  private readonly fitResult = createFitResult();
  private readonly rawMatrix = new THREE.Matrix4();
  private readonly smoothMatrix = new THREE.Matrix4();
  private readonly correction = new THREE.Matrix4();
  private readonly headX = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly resizeObserver: ResizeObserver;
  private readonly handlers: { [K in keyof EventMap]: Set<(v: EventMap[K]) => void> } = {
    status: new Set(),
    stats: new Set(),
    calibration: new Set(),
  };

  private videoTexture: THREE.VideoTexture | null = null;
  private stream: MediaStream | null = null;
  private tracker: FaceTracker | null = null;
  private hair: HairSegmenter | null = null;
  private hairPromise: Promise<void> | null = null;
  private asset: GlassesAsset | null = null;
  private fit: FitParams = { ...DEFAULT_FIT };
  private settings: EngineSettings = { ...DEFAULT_SETTINGS };
  private status: EngineStatus = { phase: 'idle' };
  private layout = { fullW: 1, fullH: 1, offX: 0, offY: 0, viewW: 1, viewH: 1, pr: 1 };
  private disposed = false;
  private vfcHandle = 0;
  private rafHandle = 0;
  private lastVideoTime = -1;
  private cameraGeneration = 0;
  private faceSeenAt = -Infinity;
  private hasPose = false;
  private frameCount = 0;
  private lightLevel = 0.75;
  private lastLightSample = 0;
  private lightCtx: CanvasRenderingContext2D | null = null;
  private lastCalibrationEmit = 0;
  private lastCalibration: CalibrationState | null = null;
  private stats = { frames: 0, detect: 0, render: 0, since: performance.now() };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.domElement.className = 'tryon-canvas';
    container.appendChild(this.renderer.domElement);

    this.video = document.createElement('video');
    this.video.className = 'tryon-video';
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');
    this.video.addEventListener('resize', () => this.updateLayout());
    container.appendChild(this.video);

    this.loader = new ModelLoader(this.renderer);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envTexture;
    this.scene.background = new THREE.Color(0x0e1014);

    this.faceAnchor.matrixAutoUpdate = false;
    this.glassesPivot.matrixAutoUpdate = false;
    this.faceAnchor.visible = false;
    this.faceAnchor.add(this.glassesPivot, this.occluders.headGroup);
    this.occluders.faceGroup.visible = false;
    this.scene.add(this.faceAnchor, this.occluders.faceGroup);

    // Key light for highlights on the frame (from above-front, fixed to the camera). No shadows.
    this.light.position.set(-0.35, 1, 0.8);
    this.scene.add(this.light);

    this.resizeObserver = new ResizeObserver(() => this.updateLayout());
    this.resizeObserver.observe(container);
    this.applySettings(this.settings, null);
    this.updateLayout();
  }

  // ─── events ────────────────────────────────────────────────────────────────

  on<K extends keyof EventMap>(type: K, fn: (v: EventMap[K]) => void): () => void {
    this.handlers[type].add(fn);
    if (type === 'status') (fn as (v: EngineStatus) => void)(this.status);
    return () => this.handlers[type].delete(fn);
  }

  private emit<K extends keyof EventMap>(type: K, value: EventMap[K]): void {
    for (const fn of this.handlers[type]) fn(value);
  }

  private setStatus(s: EngineStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /** Opens the camera and loads face tracking (in parallel). */
  async start(): Promise<void> {
    this.setStatus({ phase: 'loading', message: 'Starting camera and face tracking…' });
    try {
      const [tracker] = await Promise.all([getFaceTracker(), this.startCamera()]);
      if (this.disposed) return;
      this.tracker = tracker;
      this.setStatus({ phase: 'running', delegate: tracker.delegate });
    } catch (err) {
      if (this.disposed) return;
      console.error(err);
      this.setStatus({ phase: 'error', message: describeError(err) });
    }
  }

  private async startCamera(): Promise<void> {
    const generation = ++this.cameraGeneration;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? 'This browser does not support camera access.'
          : 'Camera access requires HTTPS (or http://localhost).',
      );
    }
    const [w, h] = RESOLUTIONS[this.settings.resolution];
    const portrait = window.innerHeight > window.innerWidth && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: portrait ? h : w },
        height: { ideal: portrait ? w : h },
        frameRate: { ideal: 30, max: 60 },
      },
    });
    if (this.disposed || generation !== this.cameraGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stopCamera();
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => undefined);
    if (!this.video.videoWidth) {
      await new Promise<void>((resolve) => this.video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    }
    if (this.disposed) return;
    this.videoTexture?.dispose();
    this.videoTexture = new THREE.VideoTexture(this.video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.videoTexture;
    this.updateLayout();
    this.scheduleFrame();
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.vfcHandle) this.video.cancelVideoFrameCallback?.(this.vfcHandle);
    cancelAnimationFrame(this.rafHandle);
    this.resizeObserver.disconnect();
    this.stopCamera();
    this.video.srcObject = null;
    this.setGlasses(null);
    this.hair?.close();
    this.videoTexture?.dispose();
    this.envTexture.dispose();
    this.occluders.dispose();
    this.loader.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.video.remove();
    for (const set of Object.values(this.handlers)) set.clear();
  }

  // ─── public API ────────────────────────────────────────────────────────────

  setGlasses(asset: GlassesAsset | null): void {
    if (this.asset === asset) return;
    if (this.asset) {
      this.asset.uniforms.uTryonHairOn.value = 0;
      this.glassesPivot.remove(this.asset.root);
    }
    this.asset = asset;
    if (asset) {
      asset.setLensMode(this.settings.quality === 'performance' ? 'alpha' : 'transmission');
      this.glassesPivot.add(asset.root);
      this.updateFit();
    }
  }

  setFitParams(fit: FitParams): void {
    const pdChanged = fit.pdMm !== this.fit.pdMm;
    this.fit = { ...fit };
    if (pdChanged) this.calibrator.setManualPd(fit.pdMm);
    this.updateFit();
  }

  setSettings(settings: EngineSettings): void {
    const prev = this.settings;
    this.settings = { ...settings };
    this.applySettings(this.settings, prev);
  }

  /** Forget the face measurement and start measuring again. */
  recalibrate(): void {
    this.calibrator.reset();
    this.calibrator.setManualPd(this.fit.pdMm);
  }

  /**
   * Diagnostics (dev console: `__tryon.debugInfo()`): pose scale, how well MediaPipe's pose
   * reprojects the canonical face onto the detected landmarks, and the current measurements.
   */
  debugInfo() {
    const r = this.recon;
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    r.matrix.decompose(pos, new THREE.Quaternion(), scl);
    const v = new THREE.Vector3();
    let err = 0;
    for (let i = 0; i < CANONICAL_VERTEX_COUNT; i++) {
      v.fromArray(CANONICAL_POSITIONS, i * 3).applyMatrix4(r.matrix);
      const u = r.width / 2 + (r.focalPx * v.x) / -v.z;
      const w = r.height / 2 - (r.focalPx * v.y) / -v.z;
      err += Math.hypot(u - r.pixels[i * 2], w - r.pixels[i * 2 + 1]);
    }
    const p = this.calibrator.profile;
    const euler = new THREE.Euler().setFromRotationMatrix(this.smoothMatrix, 'YXZ');
    return {
      poseDeg: {
        yaw: THREE.MathUtils.radToDeg(euler.y),
        pitch: THREE.MathUtils.radToDeg(euler.x),
        roll: THREE.MathUtils.radToDeg(euler.z),
      },
      poseScale: scl.x,
      poseTranslationCm: pos.toArray().map((n) => +n.toFixed(2)),
      reprojectionErrorPx: err / CANONICAL_VERTEX_COUNT,
      video: [r.width, r.height],
      profile: {
        pdMm: this.calibrator.pdMm,
        scale: p.scale,
        source: p.source,
        progress: p.progress,
        samples: this.calibrator.sampleCount,
        faceWidthCm: p.faceWidth,
        pupilR: p.pupilR.toArray(),
        pupilL: p.pupilL.toArray(),
        earR: p.earR.toArray(),
        earL: p.earL.toArray(),
        eyeZ: p.eyeZ,
      },
      fit: { ...this.fitResult, matrix: this.fitResult.matrix.toArray() },
      bend: this.asset
        ? {
            on: this.asset.uniforms.uTryonBendOn.value,
            earZ: this.asset.uniforms.uTryonEarZ.value.toArray(),
            dx: this.asset.uniforms.uTryonDX.value.toArray(),
            dy: this.asset.uniforms.uTryonDY.value.toArray(),
            cut: this.asset.uniforms.uTryonCut.value,
            zScale: this.asset.uniforms.uTryonZScale.value.toArray(),
            earBendZ: this.asset.analysis.earBendZ,
          }
        : null,
      asset: this.asset
        ? {
            name: this.asset.name,
            units: this.asset.units,
            widthMm: this.asset.detectedWidthMm,
            analysis: { ...this.asset.analysis, temple: undefined },
          }
        : null,
    };
  }

  // ─── settings & layout ─────────────────────────────────────────────────────

  private applySettings(s: EngineSettings, prev: EngineSettings | null): void {
    this.renderer.domElement.classList.toggle('mirrored', s.mirror);
    this.occluders.setOcclusion(s.occlusion);
    this.occluders.setDebug(s.showFaceMesh, s.showOccluders);
    this.poseFilter.setParams(SMOOTHING_PRESETS[s.smoothing]);
    if (!s.autoLight) {
      this.lightLevel = 0.75;
      this.applyLightLevel();
    }
    if (!prev || prev.quality !== s.quality) {
      this.asset?.setLensMode(s.quality === 'performance' ? 'alpha' : 'transmission');
      this.updateLayout();
    }
    if (prev && prev.resolution !== s.resolution && this.stream) {
      this.startCamera().catch((err) => this.setStatus({ phase: 'error', message: describeError(err) }));
    }
    if (s.hairOcclusion && !this.hair && !this.hairPromise) {
      this.hairPromise = HairSegmenter.create()
        .then((h) => {
          if (this.disposed) h.close();
          else this.hair = h;
        })
        .catch((err) => console.warn('[TryOn] hair segmentation unavailable', err))
        .finally(() => (this.hairPromise = null));
    }
    if (!s.hairOcclusion && this.asset) this.asset.uniforms.uTryonHairOn.value = 0;
  }

  private pixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    switch (this.settings.quality) {
      case 'performance':
        return 1;
      case 'balanced':
        return Math.min(dpr, 1.5);
      default:
        return Math.min(dpr, 2);
    }
  }

  /** "Cover" layout: the video fills the container; the 3D camera renders the same crop. */
  private updateLayout(): void {
    if (this.disposed) return;
    const cw = Math.max(1, this.container.clientWidth);
    const ch = Math.max(1, this.container.clientHeight);
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    const scale = Math.max(cw / vw, ch / vh);
    const fullW = vw * scale;
    const fullH = vh * scale;
    const offX = (fullW - cw) / 2;
    const offY = (fullH - ch) / 2;
    const pr = this.pixelRatio();
    this.layout = { fullW, fullH, offX, offY, viewW: cw, viewH: ch, pr };

    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(cw, ch, false);
    this.camera.aspect = vw / vh;
    this.camera.setViewOffset(fullW, fullH, offX, offY, cw, ch);
    this.camera.updateProjectionMatrix();
    if (this.videoTexture) {
      this.videoTexture.repeat.set(cw / fullW, ch / fullH);
      this.videoTexture.offset.set(offX / fullW, 1 - (offY + ch) / fullH);
    }
    if (this.asset) {
      this.asset.uniforms.uTryonView.value.set(offX * pr, (fullH - offY - ch) * pr, fullW * pr, fullH * pr);
    }
    if (this.status.phase === 'running') this.renderer.render(this.scene, this.camera);
  }

  // ─── frame loop ────────────────────────────────────────────────────────────

  private scheduleFrame(): void {
    if (this.disposed) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      if (this.vfcHandle) this.video.cancelVideoFrameCallback(this.vfcHandle);
      this.vfcHandle = this.video.requestVideoFrameCallback(this.onVideoFrame);
    } else {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = requestAnimationFrame(this.onAnimationFrame);
    }
  }

  private onVideoFrame = (now: number): void => {
    this.vfcHandle = 0;
    this.scheduleFrame();
    this.tick(now);
  };

  private onAnimationFrame = (now: number): void => {
    this.scheduleFrame();
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    this.tick(now);
  };

  private tick(nowMs: number): void {
    if (this.disposed) return;
    const video = this.video;
    if (video.readyState < 2 || !video.videoWidth) return;
    if (this.videoTexture) this.videoTexture.needsUpdate = true;
    this.frameCount++;

    const t0 = performance.now();
    let found = false;
    if (this.tracker) {
      try {
        const res = this.tracker.detect(video, nowMs);
        const lms = res.faceLandmarks[0];
        const m = res.facialTransformationMatrixes?.[0];
        if (lms && lms.length >= 468 && m) {
          found = true;
          this.onFace(lms, m.data, nowMs);
        }
      } catch (err) {
        console.warn('[TryOn] detection failed', err);
      }
    }
    const t1 = performance.now();

    if (found) {
      this.faceSeenAt = nowMs;
    } else if (nowMs - this.faceSeenAt > FACE_RESET_MS && this.hasPose) {
      this.hasPose = false;
      this.poseFilter.reset();
      this.calibrator.reset();
      this.calibrator.setManualPd(this.fit.pdMm);
    }
    const visible = this.hasPose && nowMs - this.faceSeenAt < FACE_HOLD_MS;
    this.faceAnchor.visible = visible;
    this.occluders.faceGroup.visible = visible;

    if (visible && this.settings.hairOcclusion && this.hair && this.asset) {
      if (this.frameCount % 2 === 0) this.hair.process(video, nowMs);
      const u = this.asset.uniforms;
      u.uTryonHairOn.value = 1;
      u.uTryonHair.value = this.hair.texture;
      const l = this.layout;
      u.uTryonView.value.set(l.offX * l.pr, (l.fullH - l.offY - l.viewH) * l.pr, l.fullW * l.pr, l.fullH * l.pr);
    }
    if (found && this.settings.autoLight && nowMs - this.lastLightSample > 400) this.sampleLighting(nowMs);

    this.renderer.render(this.scene, this.camera);
    const t2 = performance.now();
    this.accumulateStats(found, t1 - t0, t2 - t1);
    if (nowMs - this.lastCalibrationEmit > 300) this.emitCalibration(nowMs);
  }

  private onFace(lms: NormalizedLandmark[], matrix: number[], nowMs: number): void {
    const v = this.video;
    this.rawMatrix.fromArray(matrix);
    this.recon.update(lms, this.rawMatrix, v.videoWidth, v.videoHeight);
    this.calibrator.addFrame(this.recon);
    this.poseFilter.apply(this.rawMatrix, nowMs / 1000, this.smoothMatrix);
    this.hasPose = true;

    this.faceAnchor.matrix.copy(this.smoothMatrix);
    this.faceAnchor.matrixWorldNeedsUpdate = true;
    // Face occluder keeps the live expression but follows the smoothed pose (same as the glasses).
    this.correction.multiplyMatrices(this.smoothMatrix, this.recon.inverse);
    // How much the head's left side faces the camera (> 0) or turns away (< 0).
    this.headX.setFromMatrixColumn(this.smoothMatrix, 0).normalize();
    this.toCamera.setFromMatrixPosition(this.smoothMatrix).negate().normalize();
    this.occluders.updateFace(this.recon.camera, this.correction, OCCLUSION_BIAS_CM, this.headX.dot(this.toCamera));
    this.occluders.updateHead(this.calibrator.profile);
    this.updateFit();
  }

  private updateFit(): void {
    if (!this.asset) return;
    solveFit(this.calibrator.profile, this.asset, this.fit, this.fitResult);
    this.glassesPivot.matrix.copy(this.fitResult.matrix);
    this.glassesPivot.matrixWorldNeedsUpdate = true;
  }

  /** Matches the virtual lighting to the room: mean brightness of the face in the video. */
  private sampleLighting(nowMs: number): void {
    this.lastLightSample = nowMs;
    if (!this.lightCtx) {
      const c = document.createElement('canvas');
      c.width = c.height = 12;
      this.lightCtx = c.getContext('2d', { willReadFrequently: true });
      if (!this.lightCtx) return;
    }
    const px = this.recon.pixels;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of [10, 152, 234, 454]) {
      x0 = Math.min(x0, px[i * 2]);
      x1 = Math.max(x1, px[i * 2]);
      y0 = Math.min(y0, px[i * 2 + 1]);
      y1 = Math.max(y1, px[i * 2 + 1]);
    }
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    const w = Math.min(vw - x0, x1 - x0);
    const h = Math.min(vh - y0, y1 - y0);
    if (w < 8 || h < 8) return;
    this.lightCtx.drawImage(this.video, x0, y0, w, h, 0, 0, 12, 12);
    const d = this.lightCtx.getImageData(0, 0, 12, 12).data;
    let luma = 0;
    for (let i = 0; i < d.length; i += 4) luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    luma /= (d.length / 4) * 255;
    const target = THREE.MathUtils.clamp(0.15 + 1.1 * luma, 0.35, 1.3);
    this.lightLevel += (target - this.lightLevel) * 0.35;
    this.applyLightLevel();
  }

  private applyLightLevel(): void {
    this.scene.environmentIntensity = this.lightLevel;
    this.light.intensity = 1.1 * this.lightLevel;
  }

  private accumulateStats(face: boolean, detectMs: number, renderMs: number): void {
    const s = this.stats;
    s.frames++;
    s.detect += detectMs;
    s.render += renderMs;
    const now = performance.now();
    const dt = now - s.since;
    if (dt < 500) return;
    this.emit('stats', {
      fps: (s.frames * 1000) / dt,
      detectMs: s.detect / s.frames,
      renderMs: s.render / s.frames,
      faceDetected: face,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
    });
    this.stats = { frames: 0, detect: 0, render: 0, since: now };
  }

  /** Sends measurements to the UI, but only when something visible changed (fewer re-renders). */
  private emitCalibration(nowMs: number): void {
    this.lastCalibrationEmit = nowMs;
    const p = this.calibrator.profile;
    const r = this.fitResult;
    const next: CalibrationState = {
      progress: Math.round(p.progress * 50) / 50,
      source: p.source,
      pdMm: Math.round(this.calibrator.pdMm * 10) / 10,
      recommendedWidthMm: Math.round(r.recommendedWidthMm || p.faceWidth * 0.9 * p.scale * 10),
      frameWidthMm: this.asset ? Math.round(r.frameWidthMm) : null,
      fitLabel: this.asset ? r.label : null,
    };
    const prev = this.lastCalibration;
    if (
      prev &&
      prev.progress === next.progress &&
      prev.source === next.source &&
      prev.pdMm === next.pdMm &&
      prev.recommendedWidthMm === next.recommendedWidthMm &&
      prev.frameWidthMm === next.frameWidthMm &&
      prev.fitLabel === next.fitLabel
    ) {
      return;
    }
    this.lastCalibration = next;
    this.emit('calibration', next);
  }
}

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access in your browser and reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No front camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is being used by another application.';
    default:
      return e?.message || 'Something went wrong while starting the try-on.';
  }
}
