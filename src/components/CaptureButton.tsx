/**
 * CaptureButton.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Lets the user save a photo of their try-on result. Delegates all the
 *   actual compositing work to `ScreenshotService` — this component is just
 *   the UI trigger plus wiring the video/canvas element references.
 *
 * WHAT IT DOES
 *   On click: calls `ScreenshotService.capture()` with the shared video
 *   element and the WebGL canvas (from `RendererCore`'s `onCanvasReady`),
 *   then `download()`s the result.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` supplies `videoElement` (from `useCamera`)
 *     and `glCanvas` (captured via `RendererCore`'s `onCanvasReady` callback).
 * ---------------------------------------------------------------------------
 */

import { useRef, useState } from 'react';
import { ScreenshotService } from '../modules/screenshot/ScreenshotService';

export interface CaptureButtonProps {
  videoElement: HTMLVideoElement;
  glCanvas: HTMLCanvasElement | null;
  /** Must match whatever mirror transform is applied to the visual composite, so the saved photo matches what the user saw. */
  mirrored?: boolean;
}

export function CaptureButton({ videoElement, glCanvas, mirrored = true }: CaptureButtonProps) {
  const serviceRef = useRef<ScreenshotService | null>(null);
  if (serviceRef.current === null) {
    serviceRef.current = new ScreenshotService();
  }
  const [justCaptured, setJustCaptured] = useState(false);

  const handleClick = () => {
    if (!glCanvas) return;
    const dataUrl = serviceRef.current!.capture(videoElement, glCanvas, { mirrored });
    serviceRef.current!.download(dataUrl);
    setJustCaptured(true);
    setTimeout(() => setJustCaptured(false), 1200);
  };

  return (
    <button
      onClick={handleClick}
      disabled={!glCanvas}
      style={{
        padding: '10px 20px',
        borderRadius: 999,
        border: 'none',
        background: justCaptured ? '#3ddc84' : '#ffffff',
        color: '#111',
        fontWeight: 600,
        fontSize: 14,
        cursor: glCanvas ? 'pointer' : 'not-allowed',
        opacity: glCanvas ? 1 : 0.5,
        transition: 'background 150ms ease',
      }}
    >
      {justCaptured ? 'Saved!' : '📸 Capture Photo'}
    </button>
  );
}
