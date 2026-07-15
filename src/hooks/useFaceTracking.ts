/**
 * useFaceTracking.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Some UI needs to know "is a face currently visible?" (e.g. to show a
 *   "position your face in frame" hint) — but that's a coarse, rare-changing
 *   signal, not something that should ride on the 60fps tracking loop.
 *   Polling `getLatestResult()` at a low, fixed interval (default 200ms) and
 *   only calling `setState` when the coarse quality actually changes keeps
 *   this hook's re-render cost negligible.
 *
 * WHAT IT DOES
 *   Polls `getLatestResult().quality` every `pollIntervalMs` and returns the
 *   current `TrackingQuality`, updating React state only on actual
 *   transitions (none → low → good, etc), not every poll tick.
 *
 * HOW IT COMMUNICATES
 *   - Takes `getLatestResult` from `useFrameLoop` as input.
 *   - `components/TryOnApp.tsx` (or a status-indicator component) reads the
 *     returned quality to drive hint/spinner UI.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useRef, useState } from 'react';
import type { TrackingQuality } from '../core/types/tracking.types';

export interface UseFaceTrackingOptions {
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 200;

export function useFaceTracking(
  getLatestResult: () => { quality: TrackingQuality },
  options: UseFaceTrackingOptions = {},
): TrackingQuality {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [quality, setQuality] = useState<TrackingQuality>('none');
  const lastQualityRef = useRef<TrackingQuality>('none');

  useEffect(() => {
    const intervalId = setInterval(() => {
      const current = getLatestResult().quality;
      if (current !== lastQualityRef.current) {
        lastQualityRef.current = current;
        setQuality(current);
      }
    }, pollIntervalMs);

    return () => clearInterval(intervalId);
  }, [getLatestResult, pollIntervalMs]);

  return quality;
}
