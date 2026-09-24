# Eyewear Virtual Try-On

Real-time 3D glasses try-on in the browser: React + three.js + Google MediaPipe Face Landmarker.
A clean full-screen mirror: open the page, allow the camera, and the glasses from
`glasses (1).glb` appear on your face at their **true real-world size**, with the temple arms
fitted to your head and going behind your ears.

## Run it

```bash
npm install        # also copies the MediaPipe runtime + models into /public
npm run dev        # open http://localhost:5173 and allow the camera
```

- Phone: `npm run dev:https`, then open the `https://<your-LAN-IP>:5173` address it prints
  (browsers only allow the camera on https or localhost).
- Production: `npm run build` → static files in `dist/` (host on any HTTPS server).

## Configure (in code — the screen has no controls)

| What | Where |
| --- | --- |
| The glasses model | Replace `glasses (1).glb` in the project root, or change `GLASSES_URL` in `src/App.tsx`. Any orientation/units work (auto-detected). |
| Real frame width, PD, fine position | `DEFAULT_FIT` in `src/engine/types.ts` (`frameWidthMm`, `pdMm`, `offsetY`, `offsetZ`, `tiltDeg`, `sizeAdjust`…). |
| Mirror, occlusion, hair occlusion, quality, camera resolution, smoothing | `DEFAULT_SETTINGS` in `src/engine/types.ts`. |

The current model is authored in centimetres, so it renders **124 mm wide**. If the real product is
wider, set `frameWidthMm` (e.g. `140`) in `DEFAULT_FIT`.

## How the fit works

| Step | What happens |
| --- | --- |
| Tracking | MediaPipe Face Landmarker (GPU) gives 478 landmarks + a metric head pose every camera frame; tracking and rendering run on the same frame (no lag between face and glasses). |
| True size | MediaPipe normalises every face to an average size, so your real scale is measured from your **iris** (≈11.7 mm on almost all adults). |
| Placement | Lenses at the optometric vertex distance (12 mm) in front of the eyes, pupils just above lens centre, bridge resting on the nose, 5° pantoscopic tilt. |
| Temples | Length adjusted so the model's ear bend sits over the ear; spread and dropped to rest on the ear roots; bowed outward where the side of the head is in the way; ended where they pass behind the ear, so nothing shows through the ear at any angle. |
| Occlusion | Live face mesh + head proxy hide the far temple and everything behind the head. |
| Stability | One-Euro filtering; face shape is measured only from frontal views, so the fit doesn't drift when you turn. |

Verified with a scanned 3D head from −60° to +60° yaw and ±20° pitch (MediaPipe loses the face
beyond ~65°, then the glasses hide until the face is found again).

## Project layout

```
src/
  App.tsx                      loads the glasses, full-screen view
  components/Viewport.tsx      camera + 3D canvas, status messages
  engine/TryOnEngine.ts        render loop, camera, layout
  engine/faceTracker.ts        MediaPipe Face Landmarker (GPU → CPU fallback)
  engine/faceReconstruction.ts live metric 3D face from landmarks + pose
  engine/faceProfile.ts        calibration: iris scale, pupils, nose, ears, side of face
  engine/glassesAsset.ts       GLB normalisation, orientation/units detection, temple shader
  engine/fitSolver.ts          places the frame and fits the temples
  engine/occluders.ts          face mesh + head occluders
```

Development: `__tryon.debugInfo()` in the browser console prints the pose, measurements and fit;
set `showFaceMesh` / `showOccluders` in `DEFAULT_SETTINGS` to see the tracking geometry.

## Credits

Glasses model: ["Glasses"](https://sketchfab.com/3d-models/glasses-4b8a1e54f3084c63828fe8c324198aec)
by [AlbertVictory](https://sketchfab.com/albert_victory), licensed
[CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/). The license requires this credit, so the
app shows it in small text in the corner — keep it (or another visible credit) when you publish.

Face model data: MediaPipe canonical face model (Apache-2.0).
