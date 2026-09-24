import { useEffect, useRef } from 'react';
import { TryOnEngine } from '../engine/TryOnEngine';
import type { EngineStatus } from '../engine/types';

interface Props {
  onEngine: (engine: TryOnEngine | null) => void;
  status: EngineStatus;
  /** null until the first tracking result arrives. */
  faceDetected: boolean | null;
  onRetry: () => void;
}

/** Full-screen mirror: camera + glasses, with only essential status messages. */
export function Viewport({ onEngine, status, faceDetected, onRetry }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const engine = new TryOnEngine(stageRef.current!);
    onEngine(engine);
    void engine.start();
    if (import.meta.env.DEV) (window as unknown as { __tryon?: TryOnEngine }).__tryon = engine;
    return () => {
      onEngine(null);
      engine.dispose();
    };
  }, [onEngine]);

  return (
    <div className="viewport">
      <div className="stage" ref={stageRef} />

      {status.phase === 'loading' && (
        <div className="overlay">
          <div className="spinner" />
          <p>{status.message}</p>
        </div>
      )}
      {status.phase === 'error' && (
        <div className="overlay error">
          <p className="error-title">Camera unavailable</p>
          <p>{status.message}</p>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {status.phase === 'running' && faceDetected === false && (
        <div className="hint">
          <span className="pulse" /> Look at the camera
        </div>
      )}
    </div>
  );
}
