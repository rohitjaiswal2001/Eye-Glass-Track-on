import { useEffect, useState } from 'react';
import { Viewport } from './components/Viewport';
import { GlassesAsset, type ModelCredit } from './engine/glassesAsset';
import type { TryOnEngine } from './engine/TryOnEngine';
import type { EngineStatus } from './engine/types';

/** The glasses shown on the face: the model in the project folder. */
const GLASSES_URL = new URL('../glasses (1).glb', import.meta.url).href;

const stripUrl = (s: string) => s.replace(/\s*\(https?:[^)]*\)/g, '').trim();

export default function App() {
  const [engine, setEngine] = useState<TryOnEngine | null>(null);
  const [status, setStatus] = useState<EngineStatus>({ phase: 'idle' });
  const [faceDetected, setFaceDetected] = useState<boolean | null>(null);
  const [credit, setCredit] = useState<ModelCredit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!engine) return;
    const offs = [engine.on('status', setStatus), engine.on('stats', (s) => setFaceDetected(s.faceDetected))];
    return () => offs.forEach((off) => off());
  }, [engine]);

  // Load the glasses once per engine; auto-fit does the rest.
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    let asset: GlassesAsset | null = null;
    engine.loader
      .loadUrl(GLASSES_URL, 'Glasses')
      .then(({ name, scene, credit: c }) => {
        if (cancelled) return;
        asset = new GlassesAsset(name, scene, c);
        engine.setGlasses(asset);
        setCredit(c);
      })
      .catch((err) => {
        console.error('[TryOn] could not load glasses (1).glb', err);
        if (!cancelled) setError('Could not load “glasses (1).glb” from the project folder.');
      });
    return () => {
      cancelled = true;
      if (asset) {
        engine.setGlasses(null);
        asset.dispose();
      }
    };
  }, [engine]);

  return (
    <main className="app">
      <Viewport onEngine={setEngine} status={status} faceDetected={faceDetected} onRetry={() => void engine?.start()} />
      {error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}
      {credit?.author && (
        <p className="credit">
          {credit.title ?? 'Model'} by {stripUrl(credit.author)}
          {credit.license ? ` · ${stripUrl(credit.license)}` : ''}
        </p>
      )}
    </main>
  );
}
