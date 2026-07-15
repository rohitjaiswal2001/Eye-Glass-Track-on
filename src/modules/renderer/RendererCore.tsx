/**
 * RendererCore.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   The spec requires exactly ONE renderer, ONE scene, ONE camera — never
 *   per-component Canvas instances, which would multiply WebGL contexts and
 *   tank performance. This is the single place that owns the R3F `<Canvas>`
 *   and its lighting/camera setup; everything else (glasses model, debug
 *   gizmos) mounts as children inside it.
 *
 *   The camera's vertical FOV is deliberately set to the SAME
 *   `DEFAULT_VERTICAL_FOV_DEGREES` constant used by `core/math/projection.ts`
 *   to convert pixel distances to millimeters. This matters: MediaPipe's
 *   `facialTransformationMatrix` places the head at a position that's only
 *   physically meaningful relative to a specific camera FOV assumption. If
 *   the Three.js camera used a different FOV than the one implicitly assumed
 *   when we estimated `depthMm` for face metrics, the glasses would render
 *   at the right depth but the wrong apparent size — a subtle bug this
 *   comment exists specifically to prevent.
 *
 * WHAT IT DOES
 *   Renders a `<Canvas>` configured with:
 *     - A perspective camera at the origin (matching MediaPipe's assumed
 *       virtual camera position), FOV-matched to the projection math.
 *     - Capped device pixel ratio (perf: avoids full 3x render cost on
 *       high-DPI phones for no visible benefit).
 *     - sRGB color output + ACES tone mapping for realistic material response.
 *     - Basic ambient + directional lighting suitable for eyewear preview.
 *   Render-loop updates (moving the glasses each frame) happen via
 *   `useFrame` in a CHILD component (`components/GlassesScene.tsx`), never
 *   here — `useFrame` callbacks run outside React's render cycle, so the
 *   60fps head-tracking loop never triggers a React re-render of this tree.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` renders one `<RendererCore>` and passes the
 *     glasses scene graph (from `hooks/useGlassesModel`) as its children.
 *   - `aspectRatio` should be derived from `CameraState.resolvedWidth /
 *     resolvedHeight` so the 3D camera's aspect matches the actual webcam
 *     feed being shown behind it.
 * ---------------------------------------------------------------------------
 */

import { useEffect, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DEFAULT_VERTICAL_FOV_DEGREES } from '../../core/math/projection';

export interface RendererCoreProps {
  children: ReactNode;
  /** Width/height of the webcam feed this canvas overlays — keeps the 3D camera's aspect matched to it. */
  aspectRatio?: number;
  /** MUST stay consistent with `core/math/projection.ts`'s FOV assumption — see file header. */
  verticalFovDegrees?: number;
  className?: string;
  /** Fired once with the underlying `<canvas>` DOM element — needed by `ScreenshotService` to composite a capture. */
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
}

/** Device pixel ratio cap — rendering at full 3x/4x DPR costs real frame time for no perceptible sharpness gain on this content. */
const DPR_RANGE: [number, number] = [1, 2];

/**
 * Provides realistic PBR reflections (the glossy studio-photo look real
 * eyewear renders/product shots have) without needing any external HDRI
 * asset — `RoomEnvironment` is Three.js's built-in procedural "softbox
 * room" scene, baked into a reflection map once via `PMREMGenerator`. Flat
 * ambient+directional lighting alone leaves metal/acetate materials looking
 * dull and matte no matter how `metalness`/`roughness` are tuned, because
 * `MeshStandardMaterial`'s specular response needs something to actually
 * reflect. This is invisible in the frame (it's a lighting environment, not
 * a rendered background) — the webcam feed still shows through underneath.
 */
function SceneEnvironment() {
  const { gl, scene } = useThree();

  useEffect(() => {
    const pmremGenerator = new THREE.PMREMGenerator(gl);
    const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    pmremGenerator.dispose();

    return () => {
      envTexture.dispose();
      scene.environment = null;
    };
  }, [gl, scene]);

  return null;
}

export function RendererCore({
  children,
  aspectRatio = 16 / 9,
  verticalFovDegrees = DEFAULT_VERTICAL_FOV_DEGREES,
  className,
  onCanvasReady,
}: RendererCoreProps) {
  return (
    <Canvas
      className={className}
      dpr={DPR_RANGE}
      // preserveDrawingBuffer costs a small amount of GPU memory bandwidth,
      // but is required for ScreenshotService to reliably read back this
      // canvas's pixels via drawImage/toDataURL after a render completes.
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
      camera={{
        fov: verticalFovDegrees,
        aspect: aspectRatio,
        near: 0.05,
        far: 10,
        // Origin, default orientation (looks down -Z) — matches the virtual
        // camera position MediaPipe's transformation matrix is expressed relative to.
        position: [0, 0, 0],
      }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        onCanvasReady?.(gl.domElement);
      }}
    >
      <SceneEnvironment />
      <ambientLight intensity={0.5} />
      <directionalLight position={[0.5, 1, 1]} intensity={1.3} />
      <directionalLight position={[-0.5, -0.3, 0.5]} intensity={0.35} />
      {children}
    </Canvas>
  );
}
