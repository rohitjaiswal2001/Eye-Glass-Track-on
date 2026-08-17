/**
 * ModelLoader.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   With a catalog of hundreds of GLB eyewear models, we cannot afford to
 *   either (a) load every model up front, or (b) reload a model's geometry
 *   from disk every time the user switches to it. This module is the single
 *   place that owns the GLTF loading pipeline, an LRU template cache, and
 *   the clone-per-activation policy that keeps hundreds of frame switches
 *   from leaking GPU memory.
 *
 * WHAT IT DOES
 *   - `loadFrame(entry)`: fetches + validates a frame's sidecar JSON (via
 *     `calibrationSchema`) and returns a typed `FrameAsset`. Concurrent
 *     calls for the same `frameId` are deduplicated (one fetch, many callers).
 *   - `getModelInstance(entry)`: returns a ready-to-use **clone** of the
 *     frame's GLB scene graph, loading (and LRU-caching) the shared template
 *     on first use. Cloning is essential — mutating a cached template's
 *     transform/materials directly would corrupt it for every future use of
 *     that frame.
 *   - `disposeAll()`: releases every cached template's GPU resources
 *     (geometries, materials, textures) — call on full app teardown.
 *
 * HOW IT COMMUNICATES
 *   - `hooks/useGlassesModel.ts` calls `getModelInstance()` whenever the
 *     user selects a new frame, and attaches the returned `THREE.Group` to
 *     the scene managed by `modules/renderer`.
 *   - `components/FrameSelector.tsx` calls `loadFrame()` (JSON only, cheap)
 *     to populate catalog thumbnails/metadata without paying the full GLB
 *     download cost until the user actually selects a frame.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { clone as cloneSkeletonHierarchy } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { FrameAsset, FrameManifestEntry } from '../../core/types/calibration.types';
import { validateCalibrationData } from '../calibration/calibrationSchema';

export interface ModelLoaderOptions {
  /** Path/URL to the DRACO WASM decoder files, for compressed GLB geometry. */
  dracoDecoderPath?: string;
  /** Max number of GLB template scenes to keep resident before evicting the least-recently-used one. */
  maxCacheSize?: number;
}

const DEFAULT_DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const DEFAULT_MAX_CACHE_SIZE = 20;

export class ModelLoader {
  private readonly gltfLoader: GLTFLoader;
  private readonly maxCacheSize: number;
  /** Map iteration order = insertion order, which we use as the LRU order (re-inserted on access). */
  private readonly templateCache = new Map<string, THREE.Group>();
  private readonly inFlightFrameLoads = new Map<string, Promise<FrameAsset>>();

  constructor(options: ModelLoaderOptions = {}) {
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;

    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(options.dracoDecoderPath ?? DEFAULT_DRACO_DECODER_PATH);

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(dracoLoader);
  }

  /**
   * Fetches and validates a frame's sidecar calibration JSON, returning a
   * typed `FrameAsset`. Does NOT load the GLB geometry — see `getModelInstance`.
   * Throws if the fetch fails or the JSON doesn't match the calibration schema.
   */
  async loadFrame(entry: FrameManifestEntry): Promise<FrameAsset> {
    const inFlight = this.inFlightFrameLoads.get(entry.frameId);
    if (inFlight) return inFlight;

    const promise = this.fetchAndValidateFrame(entry);
    this.inFlightFrameLoads.set(entry.frameId, promise);
    try {
      return await promise;
    } finally {
      this.inFlightFrameLoads.delete(entry.frameId);
    }
  }

  private async fetchAndValidateFrame(entry: FrameManifestEntry): Promise<FrameAsset> {
    const response = await fetch(entry.jsonUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch calibration JSON for "${entry.frameId}" (HTTP ${response.status}).`);
    }

    const rawJson: unknown = await response.json();
    const validation = validateCalibrationData(rawJson);
    if (!validation.valid) {
      throw new Error(`Invalid calibration JSON for "${entry.frameId}": ${validation.errors.join('; ')}`);
    }

    return {
      frameId: entry.frameId,
      glbUrl: entry.glbUrl,
      pngUrl: entry.pngUrl,
      calibration: validation.data,
      thumbnailUrl: entry.thumbnailUrl,
      displayName: entry.displayName,
    };
  }

  /**
   * Returns a fresh clone of the frame's GLB scene graph, ready to attach to
   * the render scene. Loads (and caches) the shared template on first use.
   */
  async getModelInstance(entry: FrameManifestEntry): Promise<THREE.Group> {
    const template = await this.getOrLoadTemplate(entry);
    return this.cloneTemplate(template);
  }

  private async getOrLoadTemplate(entry: FrameManifestEntry): Promise<THREE.Group> {
    const cached = this.templateCache.get(entry.frameId);
    if (cached) {
      this.touchCacheEntry(entry.frameId, cached);
      return cached;
    }

    // PNG-only catalog frame (no GLB) — rendering is handled by PngFrameOverlay
    // as a 2D HTML overlay in screen space (not a Three.js plane). Return an
    // empty placeholder so the rest of the loading/calibration pipeline works
    // normally; GlassesScene simply renders nothing for an empty group.
    if (entry.pngUrl && !entry.glbUrl) {
      const placeholder = new THREE.Group();
      placeholder.name = `PngPlaceholder:${entry.frameId}`;
      this.addToCache(entry.frameId, placeholder);
      return placeholder;
    }

    // 3D GLB frame (the default path).
    const gltf = await this.gltfLoader.loadAsync(entry.glbUrl);
    this.addToCache(entry.frameId, gltf.scene);
    return gltf.scene;
  }

  /** Moves a cache entry to the "most recently used" end (re-insertion, since Map preserves insertion order). */
  private touchCacheEntry(frameId: string, template: THREE.Group): void {
    this.templateCache.delete(frameId);
    this.templateCache.set(frameId, template);
  }

  private addToCache(frameId: string, template: THREE.Group): void {
    this.templateCache.set(frameId, template);
    if (this.templateCache.size > this.maxCacheSize) {
      const oldestKey = this.templateCache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestTemplate = this.templateCache.get(oldestKey);
        this.disposeObject3D(oldestTemplate);
        this.templateCache.delete(oldestKey);
      }
    }
  }

  /**
   * Deep-clones a template scene graph, including per-mesh materials, so
   * that per-instance state (a future lens-tint feature, or simply this
   * instance's own transform) never mutates the cached template or any
   * other clone currently on screen.
   *
   * RIGGED MODELS need three.js's `SkeletonUtils.clone`, not `Object3D.clone`:
   * `SkinnedMesh.copy` assigns `this.skeleton = source.skeleton`, so a plain
   * clone renders through the TEMPLATE's bones — and the template is never
   * added to a scene, so its bones sit frozen at their load-time transforms
   * while `bindMatrixInverse` still cancels the clone's own world matrix. The
   * model then draws at its raw authored coordinates, ignoring every tracking
   * transform: for a wearable authored on an avatar's head, that's ~1.7m above
   * the camera and behind it — i.e. it silently never appears. `SkeletonUtils`
   * rebinds the clone to its own cloned bones, which do ride the model group.
   */
  private cloneTemplate(template: THREE.Group): THREE.Group {
    let hasSkinnedMesh = false;
    template.traverse((node) => {
      if ((node as THREE.SkinnedMesh).isSkinnedMesh) hasSkinnedMesh = true;
    });

    const clone = hasSkinnedMesh
      ? (cloneSkeletonHierarchy(template) as THREE.Group)
      : template.clone(true);

    clone.traverse((node) => {
      const mesh = node as THREE.Mesh;
      // `isMesh` rather than `type === 'Mesh'`, so skinned meshes get their own
      // material instance too — otherwise a rigged frame would be the one
      // catalog entry whose materials are still shared with the cached template.
      if (mesh.isMesh && mesh.material) {
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
      }
    });
    return clone;
  }

  /** Disposes geometries, materials, and any texture maps under `root`. */
  private disposeObject3D(root: THREE.Object3D | undefined): void {
    if (!root) return;
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      // `isMesh` covers SkinnedMesh too — a rigged template would otherwise
      // never release its geometry/textures when the LRU cache evicts it.
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => this.disposeMaterial(material));
    });
  }

  private disposeMaterial(material: THREE.Material | undefined): void {
    if (!material) return;
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
        (value as THREE.Texture).dispose();
      }
    }
    material.dispose();
  }

  /** Returns the number of GLB templates currently cached — exposed for diagnostics/tests. */
  getCacheSize(): number {
    return this.templateCache.size;
  }

  /** Disposes every cached template's GPU resources and clears the cache. Call on full app teardown. */
  disposeAll(): void {
    this.templateCache.forEach((template) => this.disposeObject3D(template));
    this.templateCache.clear();
  }
}
