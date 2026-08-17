/**
 * UploadedModelLoader.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   `ModelLoader` loads CATALOG frames: files served from a known URL with a
 *   hand-authored sidecar JSON next to them. An upload has neither. Two things
 *   in particular can't be handled the catalog way:
 *
 *   1. `.gltf` (and some `.glb`) files reference their buffers and textures by
 *      RELATIVE PATH. A file picked from the user's disk has no directory the
 *      browser can resolve those against — the loader would request
 *      `blob:…/scene.bin` and get nothing. The fix is to accept the sibling
 *      files too and redirect each request to the matching blob URL, which is
 *      also what makes a `.glb` with an external texture work.
 *   2. There is no calibration JSON, so orientation and scale are derived from
 *      the geometry (see `autoFitModel`) instead of read from disk.
 *
 * WHAT IT DOES
 *   - `loadUploadedModel(files, targetWidthMm)`: picks the `.glb`/`.gltf` entry
 *     out of the selection, maps every other file by name into a
 *     `LoadingManager` URL modifier, parses the model, runs `deriveAutoFit`,
 *     applies the resulting pre-transform, and revokes the blob URLs.
 *   - `disposeUploadedModel(group)`: releases the group's GPU resources.
 *
 * HOW IT COMMUNICATES
 *   - `hooks/useCustomGlbFrame` calls both, and wraps the returned auto-fit
 *     into a `CalibrationData` so an upload is indistinguishable from a catalog
 *     frame downstream (`GlassesScene`, `CalibrationEngine`, `CalibrationPanel`).
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { deriveAutoFit, type AutoFitResult } from './autoFitModel';
import { applyModelPreTransform, flipPreTransformVertically } from './modelPreTransform';

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

export interface UploadedModelResult {
  group: THREE.Group;
  autoFit: AutoFitResult;
  /** The model file's own name, for display and for the synthesized frameId. */
  fileName: string;
  /** Names of sibling files that the model asked for but weren't supplied — surfaced as a warning, not an error. */
  missingResources: string[];
}

const MODEL_EXTENSIONS = ['.glb', '.gltf'];

/** True for the one file in a selection that is the model itself. */
function isModelFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return MODEL_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export interface UploadedModelOptions {
  /**
   * Render the model upside down relative to what auto-fit detected. Re-parses
   * from the original files rather than rotating the live group, because
   * `templeRig` has by then reparented temple meshes into pivots that sit
   * ALONGSIDE the pre-transform node — turning only the pre-transform would
   * leave the arms behind. A fresh group gets a freshly built rig.
   */
  flipVertically?: boolean;
}

export async function loadUploadedModel(
  files: File[],
  targetWidthMm: number,
  options: UploadedModelOptions = {},
): Promise<UploadedModelResult> {
  const modelFile = files.find(isModelFile);
  if (!modelFile) {
    throw new Error('Select a .glb or .gltf file (you can include its .bin and texture files in the same selection).');
  }

  // Every file in the selection becomes resolvable by its base name, so a
  // model asking for "textures/colour.png" or "scene.bin" finds it regardless
  // of the folder structure it was authored with.
  const blobUrls = new Map<string, string>();
  for (const file of files) {
    blobUrls.set(file.name.toLowerCase(), URL.createObjectURL(file));
  }
  const missingResources: string[] = [];

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    // The main file is already a blob URL; only sibling lookups need mapping.
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const baseName = decodeURIComponent(url.split('/').pop() ?? '').toLowerCase();
    const mapped = blobUrls.get(baseName);
    if (mapped) return mapped;
    if (baseName && !missingResources.includes(baseName)) missingResources.push(baseName);
    return url;
  });

  const dracoLoader = new DRACOLoader(manager);
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  const loader = new GLTFLoader(manager);
  loader.setDRACOLoader(dracoLoader);

  const modelUrl = blobUrls.get(modelFile.name.toLowerCase())!;
  try {
    const gltf = await loader.loadAsync(modelUrl);
    const group = gltf.scene;

    const derived = deriveAutoFit(group, targetWidthMm);
    const autoFit: AutoFitResult = options.flipVertically
      ? { ...derived, preTransform: flipPreTransformVertically(derived.preTransform) }
      : derived;
    applyModelPreTransform(group, autoFit.preTransform);

    return { group, autoFit, fileName: modelFile.name, missingResources };
  } finally {
    // Safe once parsing has finished: geometry and textures are decoded into
    // GPU/CPU memory by then and no longer reference the URLs.
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    dracoLoader.dispose();
  }
}

/** Releases geometries, materials and textures under an uploaded model group. */
export function disposeUploadedModel(group: THREE.Group): void {
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
          (value as THREE.Texture).dispose();
        }
      }
      material.dispose();
    }
  });
}
