# Virtual Eyeglasses Try-On

A production-architecture virtual eyewear try-on engine: React 19 + TypeScript + Vite + Three.js + React Three Fiber + MediaPipe Face Landmarker.

## Quick Start

```bash
npm install
npm run dev       # http://localhost:5173 — needs a webcam + browser permission
npm run build     # production build to dist/
```

The catalog in `public/models/` holds real 3D eyewear models, shipped exactly as
they were authored — the GLBs are byte-identical to the vendor files, with every
axis/scale correction declared in each frame's sidecar JSON (see
`modelPreTransform` below) rather than baked into the geometry:

| Frame | Style | Notes |
|---|---|---|
| `sunglasses` | Sport wrap shield | single curved shield lens, branded temple arms, PBR textures |
| `sunglasses_2` | Aviator | low-poly, skinned to a head bone (rests at its bind pose) |

A set of six procedural placeholder frames (`frame001`–`frame006`) can be
generated at any time if you want simple geometry to test against:

```bash
npx tsx scripts/generate-sample-frames.ts
```

They are not part of the catalog by default — add them to
`public/models/manifest.json` if you want them in the picker.

**You can also try on your own frames**, two ways, both tracked through the same
pipeline as a catalog frame and both tunable with "🎚 Tune Fit":

- **🕶 Upload 3D Model** — a `.glb` or `.gltf`. There's no sidecar JSON for an
  upload, so orientation and scale are detected from the geometry itself
  (`modules/modelLoader/autoFitModel.ts`) and the model arrives centred on eye
  level at a realistic 140mm width, whatever axes or units it was authored in.
  If a model's up direction is detected wrong, "⇅ Flip" fixes it in one click.
  Select sibling files **together with** the model when it has any — a `.gltf`
  needs its `.bin`, and either format may reference textures externally; the
  loader maps each request onto the files you picked, so nothing 404s.
  "Copy JSON" in the tuning panel then emits a complete sidecar (auto-fit
  included) that can be committed next to the GLB to make it a catalog frame.
- **📁 Upload Glasses PNG** — a photo instead of a model. A transparent
  background works best (the alpha channel is respected for a clean cutout).

## Architecture at a Glance

```
Webcam (CameraManager)
   -> MediaPipeService (FaceLandmarker, VIDEO mode)
   -> HeadPoseEstimator (decomposes facialTransformationMatrix)
   -> FaceTracker (IPD / face width / nose bridge via core/math/faceMetrics)
   -> core/smoothing (One-Euro filter + slerp-based quaternion smoother)
   -> CalibrationEngine (head pose + face metrics + frameXXX.json -> final Transform)
   -> FrameManager (orchestrates all of the above, once per video frame)
   -> GlassesScene (R3F useFrame reads FrameManager, mutates Object3D directly)
```

`core/math` and `core/smoothing` are pure TypeScript with zero React/Three
dependencies — by design, so this logic can be ported to Flutter/Dart later
with minimal translation risk (see "Flutter portability" below).

### Folder structure

```
src/
  core/
    types/        shared TS interfaces (Transform, HeadPose, CalibrationData, ...)
    math/          vectors, quaternions, matrix decomposition, face metrics, projection
    smoothing/     One-Euro filter (position) + slerp-based smoother (rotation)
  modules/
    camera/        CameraManager — getUserMedia lifecycle, shared <video> element
    mediapipe/     MediaPipeService — wraps @mediapipe/tasks-vision FaceLandmarker
    faceTracker/   FaceTracker — per-frame face metrics + hold-last-good-value
    headPose/      HeadPoseEstimator — decomposes MediaPipe's transformation matrix
    calibration/   CalibrationEngine + Zod schema validation for frameXXX.json
    modelLoader/   ModelLoader (GLTFLoader + DRACO + LRU cache) + PngGlassesBuilder
                   (custom PNG upload -> flat tracked plane)
    renderer/      RendererCore — the single Canvas/Scene/Camera + procedural room environment
    frameManager/  FrameManager — the imperative per-tick orchestrator
    screenshot/    ScreenshotService — composites video + WebGL canvas -> PNG
    performance/   PerformanceMonitor — rolling FPS/latency stats
  hooks/           React boundary: useCamera, useFrameLoop, useFaceTracking,
                   useGlassesModel, useCustomPngFrame
  components/      TryOnApp, WebcamLayer, GlassesScene, FrameSelector, DebugOverlay,
                    CaptureButton, CalibrationPanel (live fit-tuning sliders)
public/
  models/          frameXXX.glb + frameXXX.json + manifest.json (the frame catalog —
                    round/rectangle/aviator/cat-eye/square shapes with clear lenses,
                    nose pads, hinges, and curved temples)
scripts/
  generate-sample-frames.ts   procedurally generates the sample GLB catalog (4 lens
                               shape generators: round, rounded-rect, aviator, cat-eye)
```

## Key Design Decisions

**Head pose comes from MediaPipe's `facialTransformationMatrix`, not a hand-rolled PnP solver.**
`core/math/matrix.ts` decomposes this 4x4 matrix into position/quaternion/scale — the
same well-understood algorithm used internally by `THREE.Matrix4.decompose`, reimplemented
without a Three.js dependency. This is far more stable than solving PnP from 2D landmarks ourselves.

**Glasses are anchored to the tracked nose bridge landmark, NOT the whole-face transform origin.**
`headPose.position` (from the decomposed `facialTransformationMatrix`) is MediaPipe's
whole-face Procrustes rigid-fit origin — a best-fit point across all 468 landmarks. That is
**not** the same point as the nose bridge, and empirically sits measurably below eye level
(the fit is pulled down by the mesh's lower half — nose, mouth, jaw — which has more
landmark area than the forehead region above the eyes). `core/math/projection.ts`'s
`unprojectToMetricSpace` back-projects the actual tracked nose bridge landmark into the
same metric 3D space instead, via standard inverse-pinhole projection, and
`CalibrationEngine` anchors position to that (`faceMetrics.noseBridgeMetric`) while still
taking rotation from `headPose.quaternion` (rotation IS reliably given by the whole-face
fit — it's specifically *position* that needed a better anchor). This anchor gets its own
independent smoothing pass in `FrameManager` (`noseBridgeFilter`), separate from
`headPose.position`'s own filter, so it doesn't reintroduce jitter.

**Rotation smoothing uses slerp, not component-wise lowpass.**
You cannot average quaternion components independently without producing an invalid,
non-shortest-path rotation. `core/smoothing/QuaternionSmoother.ts` implements a One-Euro-style
adaptive filter using angular velocity + `slerp` instead — still frequency-adaptive, but
geometrically correct.

**Camera FOV is matched between the 3D scene and the face-metrics projection math.**
`RendererCore`'s camera FOV and `core/math/projection.ts`'s pinhole-projection assumption
both default to the same `DEFAULT_VERTICAL_FOV_DEGREES` constant. If these ever drift apart,
the glasses will render at the correct depth but the wrong apparent size.

**Mirroring happens once, at the composite level — never per-layer.**
The displayed video is conventionally mirrored for a natural selfie feel, but MediaPipe
always analyzes the *unmirrored* raw camera frames. `WebcamLayer` and `RendererCore` both
render in that same natural, unmirrored coordinate space; `TryOnApp` mirrors the whole
composite (video + 3D canvas together) with one `scaleX(-1)`. Mirroring the video alone
would desync the glasses from the face — see `WebcamLayer.tsx`'s doc comment.

**Millimeters internally, meters at the render boundary — and MediaPipe's own units are centimeters.**
All calibration/face-metric math is authored in millimeters for intuitive tuning.
`CalibrationEngine.MILLIMETERS_TO_SCENE_UNITS` (0.001) is the single conversion point to
Three.js/glTF's meter convention. Sample GLB geometry is authored directly in meters.
**Important gotcha, confirmed against a real device and Google's own documentation:**
MediaPipe's canonical face model — and therefore the translation component of
`facialTransformationMatrix` — is defined in **centimeters**, not millimeters ("A metric
unit used by the default canonical face model is a centimeter" — Google's "MediaPipe 3D
Face Transform" post). `HeadPoseEstimator` converts this to millimeters right at the
boundary (`MEDIAPIPE_CM_TO_MM = 10`) so everything downstream can consistently assume
millimeters. Getting this wrong doesn't just mis-scale the glasses — a 10x-too-small
position can land the model inside the camera's near-clipping plane, making it invisible
even though tracking itself is working correctly. If you ever swap in a different pose
source, re-verify its unit convention before assuming millimeters.

**Scale is derived from the user's IPD relative to a 63mm reference adult IPD.**
`CalibrationEngine.computeScale()` — `calibration.defaultScale * (userIPD / 63mm)`. A frame's
`frameWidth`/`bridgeWidth`/`lensWidth` fields are available for finer-grained fitting logic
if you want to extend this heuristic later.

**Nothing in the 60fps hot path calls `setState`.**
`FrameManager` is a plain class; `GlassesScene`'s `useFrame` callback reads
`getLatestResult()` and mutates the glasses `Object3D` directly. The only React state
updates related to tracking are low-frequency, debounced-on-change polls
(`useFaceTracking`, `DebugOverlay`) — coarse UI signals, never per-frame data.

## The Calibration JSON Contract

Every `frameXXX.glb` ships a sidecar `frameXXX.json`:

```json
{
  "frameId": "frame001",
  "frameWidth": 132,
  "bridgeWidth": 18,
  "lensWidth": 52,
  "offsetX": 0,
  "offsetY": 0,
  "offsetZ": 3,
  "rotationX": 0,
  "rotationY": 0,
  "rotationZ": 0,
  "defaultScale": 1.0
}
```

Validated at load time by `modules/calibration/calibrationSchema.ts` (Zod) — a malformed
sidecar JSON fails loudly with a field-level error message rather than silently producing
`NaN` transforms three modules downstream.

Three optional fields round it out: `scaleX` / `scaleZ` (per-axis width and depth
multipliers, default `1.0`), and `modelPreTransform` — see below.

### `modelPreTransform`: using a vendor GLB as-is

The fields above are per-user **fit** tuning, applied every frame in millimeters against
the tracked anchor. `modelPreTransform` is a different lever: a one-time **authoring**
fix, in the model's own units, applied once at load time inside the model group
(`modules/modelLoader/modelPreTransform.ts`):

```json
  "modelPreTransform": {
    "rotationY": 90,
    "translateY": 0.1656,
    "translateZ": -1.0463
  }
```

It exists because vendor and marketplace GLBs are authored on whatever axes their artist
used, and one module — `modules/renderer/templeRig.ts` — reads model-local geometry to
tell the frame front from the temple arms. Hand it a sideways-authored model and it will
rig the lens as a temple arm. The correction has to sit *inside* the model group, not on
the tracked anchor above it, for that classification (and `GlassesScene`'s
`worldToLocal` ear targets) to land in corrected space.

This replaces the older approach of rewriting a vendor GLB's vertex buffers offline (see
`scripts/reprocess-cyberpunk-glb-*.mjs`): the GLB stays byte-identical to what was
shipped, and the whole correction is one reviewable block of JSON. Omit the field
entirely for models already on the convention (the procedural `frame001`–`frame006`
placeholders are authored on it by construction).

## Adding Real Frames

1. Author (or license) a GLB eyewear model in meters, on the renderer's convention:
   X lateral and centered, Y up with the lens center at eye level (Y = 0), and the
   temples running back into -Z from a front plane at Z ≈ 0 — i.e. the frame front faces
   +Z, toward the camera. A model that doesn't follow this needs a `modelPreTransform`
   (above); `node scripts/derive-model-pretransform.mjs <file.glb> --map=z,y,-x` reports
   the exact values, and `npx tsx scripts/verify-frame-alignment.ts <frameId>` checks the
   result headlessly — including how `templeRig` classified every mesh — before you put a
   face in front of it.
2. Measure `frameWidth` / `bridgeWidth` / `lensWidth` in millimeters.
3. Write `frameNNN.json` matching the schema above (`offsetX/Y/Z`, `rotationX/Y/Z` start
   at `0`; `defaultScale` starts at `1.0`).
4. Drop both files in `public/models/` and add an entry to `public/models/manifest.json`.
5. Run the app, select the frame, and click **"🎚 Tune Fit"** — this opens a live panel with
   sliders for offset/rotation/scale. Drag them until the glasses sit correctly on your
   face in real time, then click **"Copy JSON"** to copy the final, exact calibration
   values, and paste them into `frameNNN.json`, replacing the starting `0`/`1.0` values.

No code changes are needed to add a frame — this is the point of the calibration-JSON
architecture: it scales to hundreds of models without touching tracking or rendering code.
The tuning panel (`components/CalibrationPanel.tsx`) exists specifically so this process
is immediate and self-serve rather than a blind guess-rebuild-check loop.

## Production Notes

- **Self-host MediaPipe's WASM + model assets.** `MediaPipeService` defaults to jsDelivr/
  Google's CDN for convenience; for production, download the WASM fileset and
  `face_landmarker.task` model into `public/` and point `MediaPipeServiceOptions` at them.
- **Self-host the DRACO decoder** the same way if you compress your GLBs with Draco
  (`ModelLoader`'s `dracoDecoderPath` option), for the same reason.
- **Bundle size**: the production build is ~1.3MB gzipped-to-~375KB for the JS bundle
  (three.js + R3F + MediaPipe types are inherently sizable). Consider code-splitting the
  frame catalog / DRACO decoder behind dynamic `import()` if initial load time matters.

## Flutter Portability

`core/math` and `core/smoothing` have zero framework dependencies (no React, no Three.js,
no DOM) — every function operates on plain structural types (`Vector3Like`, `QuaternionLike`,
`TransformLike`) rather than library classes. This layer — vector/quaternion/matrix math,
face metrics, the One-Euro filter, the calibration scale/offset formula — is the part meant
to be transliterated into Dart for a future Flutter implementation with minimal risk of
behavioral drift between platforms. `modules/calibration/CalibrationEngine.ts`'s core
`calibrate()` logic is likewise dependency-free and portable; only the loading/rendering
modules (`modelLoader`, `renderer`, `mediapipe`, `camera`) are web-specific and would need
native Flutter/Dart equivalents (e.g. `camera` package, a Flutter MediaPipe plugin, a Dart
GLTF/model-viewer package).
# Eye-Glass-Track-on
