import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ModelCredit } from './glassesAsset';

export interface LoadedModel {
  name: string;
  scene: THREE.Object3D;
  credit: ModelCredit | null;
}

/** Author / license from the glTF asset block (Sketchfab puts them in `asset.extras`). */
function readCredit(gltf: GLTF): ModelCredit | null {
  const asset = gltf.asset as { copyright?: string; extras?: Record<string, unknown> } | undefined;
  const extras = asset?.extras ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const credit: ModelCredit = {
    title: str(extras.title),
    author: str(extras.author) ?? str(asset?.copyright),
    license: str(extras.license),
    source: str(extras.source),
  };
  return credit.author || credit.license ? credit : null;
}

/**
 * glTF/GLB loader with Draco, KTX2 (Basis) and Meshopt support. The decoders ship inside
 * three.js and are bundled by Vite (resolved via import.meta.url), so no CDN is needed.
 */
export class ModelLoader {
  private readonly draco: DRACOLoader;
  private readonly ktx2: KTX2Loader;

  constructor(renderer: THREE.WebGLRenderer) {
    this.draco = new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG);
    this.ktx2 = new KTX2Loader().detectSupport(renderer);
  }

  private gltfLoader(manager?: THREE.LoadingManager): GLTFLoader {
    return new GLTFLoader(manager)
      .setDRACOLoader(this.draco)
      .setKTX2Loader(this.ktx2)
      .setMeshoptDecoder(MeshoptDecoder);
  }

  /** Loads a model shipped with the app (e.g. the default frame). */
  async loadUrl(url: string, fallbackName: string): Promise<LoadedModel> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const gltf = await this.gltfLoader().parseAsync(await res.arrayBuffer(), '');
    const credit = readCredit(gltf);
    return { name: credit?.title ?? fallbackName, scene: gltf.scene, credit };
  }

  /**
   * Loads one model from user files: a single .glb, or a .gltf plus its .bin/texture files.
   */
  async load(files: File[]): Promise<LoadedModel> {
    const main = files.find((f) => /\.glb$/i.test(f.name)) ?? files.find((f) => /\.gltf$/i.test(f.name));
    if (!main) throw new Error('Please choose a .glb (or .gltf) 3D model.');

    const blobUrls = new Map<string, string>();
    for (const f of files) if (f !== main) blobUrls.set(f.name, URL.createObjectURL(f));
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const name = decodeURIComponent(url.split(/[\\/]/).pop()!.split('?')[0]);
      return blobUrls.get(name) ?? url;
    });
    try {
      const data = /\.glb$/i.test(main.name) ? await main.arrayBuffer() : await main.text();
      const gltf = await this.gltfLoader(manager).parseAsync(data, '');
      return { name: main.name.replace(/\.(glb|gltf)$/i, ''), scene: gltf.scene, credit: readCredit(gltf) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read “${main.name}”: ${reason}`);
    } finally {
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    }
  }

  dispose(): void {
    this.draco.dispose();
    this.ktx2.dispose();
  }
}
