// Copies runtime assets into /public so the app is fully self-hosted:
//   - MediaPipe Tasks Vision WASM runtime (must match the installed npm version)
//   - MediaPipe models (face landmarker, hair segmenter)
// (three.js Draco/KTX2 decoders are bundled by Vite automatically.)
// Model downloads are best-effort: if offline, the app falls back to Google's CDN.
import { copyFile, mkdir, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const nm = join(root, 'node_modules');

async function copyDir(src, dest, filter = () => true) {
  if (!existsSync(src)) {
    console.warn(`[setup-assets] missing ${src} (skipped)`);
    return;
  }
  await mkdir(dest, { recursive: true });
  for (const name of await readdir(src)) {
    const from = join(src, name);
    if ((await stat(from)).isFile() && filter(name)) await copyFile(from, join(dest, name));
  }
}

async function download(url, dest) {
  if (existsSync(dest) && (await stat(dest)).size > 0) return;
  await mkdir(dirname(dest), { recursive: true });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tmp = `${dest}.part`;
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await rename(tmp, dest);
    console.log(`[setup-assets] downloaded ${url.split('/').pop()}`);
  } catch (err) {
    console.warn(`[setup-assets] could not download ${url} (${err.message}); the app will use the CDN instead.`);
  }
}

await copyDir(join(nm, '@mediapipe/tasks-vision/wasm'), join(pub, 'mediapipe/wasm'), (n) =>
  /^vision_wasm_(nosimd_)?internal\.(js|wasm)$/.test(n),
);

await download(
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  join(pub, 'models/face_landmarker.task'),
);
await download(
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite',
  join(pub, 'models/hair_segmenter.tflite'),
);
console.log('[setup-assets] done');
