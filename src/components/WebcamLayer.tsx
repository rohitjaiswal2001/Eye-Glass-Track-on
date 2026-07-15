/**
 * WebcamLayer.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   The webcam feed is the visual backdrop the 3D glasses overlay sits on
 *   top of. This component renders the SAME `<video>` element instance
 *   `CameraManager` owns (never creates its own stream) — see
 *   `CameraManager`'s doc comment for why sharing one element matters.
 *
 * WHAT IT DOES
 *   Mounts the given video element into the DOM via a container ref,
 *   full-bleed. Does NOT mirror by default — see the critical note below.
 *
 * CRITICAL: WHY MIRRORING HAPPENS AT THE COMPOSITE LEVEL, NOT HERE
 *   A selfie-style try-on view conventionally mirrors the video (CSS
 *   `scaleX(-1)`) so the user's movements feel natural. But MediaPipe always
 *   analyzes the RAW, unmirrored camera frames (CSS transforms are a
 *   display-only compositor effect and never affect the pixel data
 *   MediaPipe/WebGL read from the video element) — so the 3D glasses are
 *   rendered in that same natural, unmirrored coordinate space too.
 *   If this component mirrored ONLY the video while the WebGL canvas stayed
 *   unmirrored, the two layers would show mirrored-vs-unmirrored versions of
 *   the same face and the glasses would appear to "drift" to the wrong side
 *   entirely — not a subtle bug. The correct fix is to mirror the ENTIRE
 *   composite (video + canvas together, already pixel-aligned in natural
 *   space) with ONE `scaleX(-1)` on their shared parent wrapper — see
 *   `TryOnApp.tsx`. A uniform transform applied to two already-aligned
 *   layers preserves their alignment; mirroring them independently does not.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` passes the `videoElement` from `useCamera`
 *     and applies the single composite-level mirror transform around both
 *     this component and `RendererCore`.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useRef } from 'react';

export interface WebcamLayerProps {
  videoElement: HTMLVideoElement;
  /**
   * Mirrors this layer alone. Leave `false` (default) when used inside
   * `TryOnApp` alongside `RendererCore` — mirroring is applied once, to
   * both layers together, at the composite wrapper level instead. Only set
   * this `true` if rendering `WebcamLayer` standalone with no 3D overlay.
   */
  mirrored?: boolean;
}

export function WebcamLayer({ videoElement, mirrored = false }: WebcamLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    videoElement.style.width = '100%';
    videoElement.style.height = '100%';
    videoElement.style.objectFit = 'cover';
    videoElement.style.transform = mirrored ? 'scaleX(-1)' : 'none';
    container.appendChild(videoElement);

    return () => {
      if (container.contains(videoElement)) {
        container.removeChild(videoElement);
      }
    };
  }, [videoElement, mirrored]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
      }}
    />
  );
}
