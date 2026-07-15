/**
 * FrameSelector.tsx
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   With a catalog of potentially hundreds of frames, the UI needs a simple,
 *   scalable way to let the user browse and pick one. This component is
 *   deliberately "dumb" (pure props in, one callback out) — it has no idea
 *   how frames are loaded, cached, or rendered; that's `useGlassesModel`'s
 *   job. This keeps catalog browsing decoupled from the loading pipeline.
 *
 * WHAT IT DOES
 *   Renders a horizontally-scrollable strip of frame entries (thumbnail +
 *   display name), highlighting the currently selected one, and calls
 *   `onSelect` with the chosen `FrameManifestEntry`.
 *
 * HOW IT COMMUNICATES
 *   - `components/TryOnApp.tsx` supplies the catalog (loaded from
 *     `/models/manifest.json`) and wires `onSelect` to update the
 *     `FrameManifestEntry` passed into `useGlassesModel`.
 * ---------------------------------------------------------------------------
 */

import type { FrameManifestEntry } from '../core/types/calibration.types';

export interface FrameSelectorProps {
  catalog: FrameManifestEntry[];
  selectedFrameId: string | null;
  onSelect: (entry: FrameManifestEntry) => void;
}

export function FrameSelector({ catalog, selectedFrameId, onSelect }: FrameSelectorProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        overflowX: 'auto',
        padding: '12px 16px',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        borderRadius: 12,
      }}
    >
      {catalog.map((entry) => {
        const isSelected = entry.frameId === selectedFrameId;
        // Prefer an explicit thumbnail, then fall back to the transparent PNG
        // (which renders nicely on the dark strip background) for PNG frames.
        const thumbSrc = entry.thumbnailUrl ?? entry.pngUrl;
        return (
          <button
            key={entry.frameId}
            onClick={() => onSelect(entry)}
            style={{
              flex: '0 0 auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: 8,
              borderRadius: 10,
              border: isSelected ? '2px solid #4f9dff' : '2px solid transparent',
              background: isSelected ? 'rgba(79,157,255,0.15)' : 'transparent',
              cursor: 'pointer',
              color: '#fff',
              fontSize: 12,
              minWidth: 84,
            }}
          >
            <div
              style={{
                width: 72,
                height: 44,
                borderRadius: 6,
                background: thumbSrc ? 'transparent' : 'rgba(255,255,255,0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {thumbSrc ? (
                <img
                  src={thumbSrc}
                  alt={entry.displayName ?? entry.frameId}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              ) : (
                '🕶️'
              )}
            </div>
            <span style={{ textAlign: 'center', lineHeight: 1.2 }}>{entry.displayName ?? entry.frameId}</span>
          </button>
        );
      })}
    </div>
  );
}
