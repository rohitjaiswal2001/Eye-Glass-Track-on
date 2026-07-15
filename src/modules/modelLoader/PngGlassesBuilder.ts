/**
 * PngGlassesBuilder.ts
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *   Authoring a full 3D GLB isn't the only way to try on a pair of glasses —
 *   a single well-cropped product photo (like the reference images used to
 *   design this catalog) can work as a flat, alpha-transparent cutout that
 *   tracks the face just like a 3D model would, for small-to-moderate head
 *   angles. This module builds that plane and flows it through the EXACT
 *   SAME `FrameManager` → `CalibrationEngine` → `GlassesScene` pipeline as
 *   any GLB frame — the rest of the app has no idea the "model" is actually
 *   a textured plane.
 *
 * WHAT IT DOES
 *   - `loadPngAsTexture(file)`: reads an uploaded image file into a
 *     `THREE.Texture` via an object URL (revoked immediately after decode).
 *   - `buildPngGlassesGroup(texture, imageWidth, imageHeight, options)`:
 *     builds a `THREE.Group` containing one `PlaneGeometry` mesh sized to a
 *     realistic real-world width (preserving the image's aspect ratio),
 *     textured with alpha transparency respected (`alphaTest` clips fully
 *     transparent pixels so the cutout — not a solid rectangle — is what's
 *     visible; PNGs with a transparent background work best for this).
 *   - `disposePngGlassesGroup(group)`: releases the texture/geometry/material
 *     GPU resources — call when switching away from a custom upload.
 *
 * HOW IT COMMUNICATES
 *   - `hooks/useCustomPngFrame.ts` calls these when the user uploads an image.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';

export interface PngGlassesBuildOptions {
  /** Target real-world width of the glasses in the image (meters). Defaults to a typical adult frame width. */
  targetWidthM?: number;
}

/** Typical adult eyewear frame width — a reasonable default when we have no other size information. */
const DEFAULT_TARGET_WIDTH_M = 0.14;

/**
 * Loads an image file into a Three.js texture. Uses an object URL rather
 * than a data URL / FileReader — cheaper for large images, and it's
 * revoked immediately once decoding completes since the texture no longer
 * needs the URL after that point.
 */
export async function loadPngAsTexture(file: File): Promise<{ texture: THREE.Texture; width: number; height: number }> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const texture = await new THREE.TextureLoader().loadAsync(objectUrl);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const image = texture.image as HTMLImageElement;
    return { texture, width: image.width, height: image.height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Loads a pre-processed catalog PNG (a transparent-background cutout) directly
 * from a URL — used by `ModelLoader` for PNG-backed catalog entries, as opposed
 * to `loadPngAsTexture` which is for user-uploaded File objects.
 */
export async function loadPngUrlAsTexture(url: string): Promise<{ texture: THREE.Texture; width: number; height: number }> {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const image = texture.image as HTMLImageElement;
  return { texture, width: image.width, height: image.height };
}


/**
 * Builds the flat glasses plane. `PlaneGeometry` + `MeshBasicMaterial` (not
 * `MeshStandardMaterial`) is deliberate here — a 2D photo cutout isn't a lit
 * 3D surface with its own normals/material response; it should just display
 * the image as-is, unaffected by the scene's lighting/environment.
 */
export function buildPngGlassesGroup(
  texture: THREE.Texture,
  imageWidth: number,
  imageHeight: number,
  options: PngGlassesBuildOptions = {},
): THREE.Group {
  const targetWidthM = options.targetWidthM ?? DEFAULT_TARGET_WIDTH_M;
  const aspectRatio = imageWidth > 0 ? imageHeight / imageWidth : 0.5;
  const targetHeightM = targetWidthM * aspectRatio;

  const geometry = new THREE.PlaneGeometry(targetWidthM, targetHeightM);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    // Clips fully-transparent pixels outright rather than alpha-blending
    // them — avoids a faint rectangular "ghost" around the cutout and sorts
    // more predictably against the lens/rim style scenes used elsewhere.
    alphaTest: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'CustomPngGlasses';

  const group = new THREE.Group();
  group.name = 'CustomPngGlassesGroup';
  group.add(mesh);
  return group;
}

/** Releases GPU resources for a group built by `buildPngGlassesGroup`. */
export function disposePngGlassesGroup(group: THREE.Group): void {
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if ((mesh as THREE.Object3D).type !== 'Mesh') return;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.MeshBasicMaterial | THREE.MeshBasicMaterial[];
    const materials = Array.isArray(material) ? material : [material];
    for (const m of materials) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
