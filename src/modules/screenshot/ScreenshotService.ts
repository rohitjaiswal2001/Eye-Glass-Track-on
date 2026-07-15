/**
 * ScreenshotService.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   The visual result the user sees is actually TWO stacked surfaces: the
 *   `<video>` element (raw webcam feed) and the transparent WebGL `<canvas>`
 *   on top of it (the glasses, via `RendererCore`). Capturing "what the user
 *   sees" means compositing both onto one offscreen canvas in the right
 *   order — neither surface alone is the final image.
 *
 * WHAT IT DOES
 *   - `capture(video, glCanvas, options)`: draws the video frame, then the
 *     WebGL canvas on top (its alpha channel is transparent everywhere
 *     except the glasses geometry, so this correctly overlays just the
 *     glasses), optionally mirrored to match a selfie-view display, and
 *     returns a PNG/JPEG data URL.
 *   - `download(dataUrl, filename)`: triggers a browser file download.
 *
 * HOW IT COMMUNICATES
 *   - `components/CaptureButton.tsx` calls `capture()` with the shared video
 *     element (from `useCamera`) and the R3F canvas DOM node (from a ref on
 *     `RendererCore`'s `<Canvas>`), then `download()`s the result.
 *   - Depends on `RendererCore` having `preserveDrawingBuffer: true` set —
 *     otherwise the WebGL canvas may read back blank after compositing.
 * ---------------------------------------------------------------------------
 */

export interface CaptureOptions {
  /**
   * Whether the displayed video is mirrored (typical for a selfie-style
   * try-on view) and thus the capture should be mirrored too, to match what
   * the user actually saw on screen. Defaults to true.
   */
  mirrored?: boolean;
  mimeType?: 'image/png' | 'image/jpeg';
  /** JPEG quality [0,1], ignored for PNG. */
  quality?: number;
}

const DEFAULT_OPTIONS: Required<CaptureOptions> = {
  mirrored: true,
  mimeType: 'image/png',
  quality: 0.92,
};

export class ScreenshotService {
  /**
   * Composites the current video frame and WebGL overlay into a single
   * image and returns it as a data URL.
   */
  capture(video: HTMLVideoElement, glCanvas: HTMLCanvasElement, options: CaptureOptions = {}): string {
    const { mirrored, mimeType, quality } = { ...DEFAULT_OPTIONS, ...options };

    const width = video.videoWidth || glCanvas.width;
    const height = video.videoHeight || glCanvas.height;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('ScreenshotService: unable to acquire a 2D canvas context for compositing.');
    }

    ctx.save();
    if (mirrored) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    ctx.drawImage(glCanvas, 0, 0, width, height);
    ctx.restore();

    return canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? quality : undefined);
  }

  /** Triggers a browser download of a data URL produced by `capture()`. */
  download(dataUrl: string, filename: string = `virtual-try-on-${Date.now()}.png`): void {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
