import * as THREE from 'three';
import { CANONICAL_POSITIONS, CANONICAL_TRIANGLES, CANONICAL_VERTEX_COUNT } from './canonicalFace';
import type { FaceProfile } from './faceProfile';

/** Head proxy, relative to the ear rest points (cm, canonical space). */
const HEAD = {
  /** Ellipsoid centre below / behind the ear rest point (widest part of the skull). */
  down: 1.3,
  back: 0.8,
  /** Head surface sits this far inside the temple rest point so temples stay visible. */
  rimInset: 0.3,
  /** Front of the proxy stays this far behind the eyes (the face mesh covers the face). */
  frontGap: 0.8,
  halfHeight: 11,
  backDepth: 9.8,
};

/**
 * The sides of the face mesh (beyond the outer eye corners, where the temples run) only hide
 * things on the side turned away from the camera. On the side facing the camera a temple is
 * never behind the face, and the jittery outline there would otherwise cut pieces out of it.
 */
const SIDE_BAND_X = 5.0;
/** A side counts as "turned away" below this facing value (≈ sin of the turn angle), with hysteresis. */
const SIDE_AWAY_ON = -0.2;
const SIDE_AWAY_OFF = -0.15;

/** Splits the canonical triangles into [central, left side (+x), right side (−x)] index lists. */
function splitFaceTriangles(): [Uint16Array, Uint16Array, Uint16Array] {
  const lists: number[][] = [[], [], []];
  for (let t = 0; t < CANONICAL_TRIANGLES.length; t += 3) {
    let cx = 0;
    for (let j = 0; j < 3; j++) cx += CANONICAL_POSITIONS[CANONICAL_TRIANGLES[t + j] * 3] / 3;
    const bucket = cx > SIDE_BAND_X ? 1 : cx < -SIDE_BAND_X ? 2 : 0;
    lists[bucket].push(CANONICAL_TRIANGLES[t], CANONICAL_TRIANGLES[t + 1], CANONICAL_TRIANGLES[t + 2]);
  }
  return [Uint16Array.from(lists[0]), Uint16Array.from(lists[1]), Uint16Array.from(lists[2])];
}

function depthOnlyMaterial(side: THREE.Side): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ side });
  m.colorWrite = false;
  m.depthWrite = true;
  return m;
}

function debugMaterial(color: number, opacity: number, wireframe = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, wireframe });
}

export class Occluders {
  /** Live face mesh (camera space): add to the scene root. */
  readonly faceGroup = new THREE.Group();
  /**
   * Head proxy + ear rest-point markers (canonical space): add under the face anchor. The
   * temples themselves end where they pass behind the ear (see the glasses shader), which is
   * robust for every ear shape, so no ear geometry is needed here.
   */
  readonly headGroup = new THREE.Group();
  readonly faceGeometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly face: THREE.Mesh;
  /** Side strips of the face mesh: [left (+x), right (−x)]. */
  private readonly faceSides: [THREE.Mesh, THREE.Mesh];
  private readonly sideAway: [boolean, boolean] = [false, false];
  private occlusion = true;
  private readonly faceDebug: THREE.Mesh;
  private readonly headParts: THREE.Mesh[] = [];
  private readonly headDebug: THREE.Mesh[] = [];
  private readonly markers: THREE.Mesh[] = [];
  private readonly headFront: THREE.Mesh;
  private readonly headBack: THREE.Mesh;
  private readonly depthMaterials: THREE.Material[] = [];
  private readonly otherMaterials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor() {
    this.positions = new Float32Array(CANONICAL_VERTEX_COUNT * 3);
    const attr = new THREE.BufferAttribute(this.positions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    const makeGeo = (index: Uint16Array) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', attr);
      g.setIndex(new THREE.BufferAttribute(index, 1));
      this.geometries.push(g);
      return g;
    };
    const geo = makeGeo(CANONICAL_TRIANGLES);
    this.faceGeometry = geo;
    const [central, left, right] = splitFaceTriangles();

    const faceDepth = depthOnlyMaterial(THREE.DoubleSide);
    this.face = this.track(new THREE.Mesh(makeGeo(central), faceDepth), -10);
    this.faceSides = [
      this.track(new THREE.Mesh(makeGeo(left), faceDepth), -10),
      this.track(new THREE.Mesh(makeGeo(right), faceDepth), -10),
    ];
    this.depthMaterials.push(faceDepth);

    const wire = debugMaterial(0x5ee7ff, 0.35, true);
    this.faceDebug = this.track(new THREE.Mesh(geo, wire), 5);
    this.faceDebug.visible = false;
    this.otherMaterials.push(wire);
    this.faceGroup.add(this.face, ...this.faceSides, this.faceDebug);

    // Head: two half-ellipsoids (shorter in front, longer at the back of the skull).
    const front = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI);
    const back = new THREE.SphereGeometry(1, 48, 24, Math.PI, Math.PI);
    this.geometries.push(front, back);
    const headDepth = depthOnlyMaterial(THREE.FrontSide);
    const headDbg = debugMaterial(0xff5c8a, 0.22);
    this.depthMaterials.push(headDepth);
    this.otherMaterials.push(headDbg);

    const make = (g: THREE.BufferGeometry, dbg: THREE.Material) => {
      const occ = this.track(new THREE.Mesh(g, headDepth), -10);
      const vis = this.track(new THREE.Mesh(g, dbg), 5);
      vis.visible = false;
      this.headParts.push(occ);
      this.headDebug.push(vis);
      this.headGroup.add(occ, vis);
      return occ;
    };
    this.headFront = make(front, headDbg);
    this.headBack = make(back, headDbg);

    const markerGeo = new THREE.SphereGeometry(0.18, 12, 8);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x7dff9a, depthTest: false, transparent: true });
    this.geometries.push(markerGeo);
    this.otherMaterials.push(markerMat);
    for (let i = 0; i < 4; i++) {
      const m = this.track(new THREE.Mesh(markerGeo, markerMat), 10);
      m.visible = false;
      this.markers.push(m);
      this.headGroup.add(m);
    }
  }

  private track(mesh: THREE.Mesh, renderOrder: number): THREE.Mesh {
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Updates the live face occluder from camera-space landmarks, re-posed by `correction`
   * (raw → smoothed pose) and pushed back along the view ray by `bias` cm. `facing` is how much
   * the head's left side (+x) faces the camera (dot of the head's x axis with the direction to
   * the camera; the right side is its negative) and decides which side strips occlude.
   */
  updateFace(camera: Float32Array, correction: THREE.Matrix4, bias: number, facing: number): void {
    const e = correction.elements;
    const p = this.positions;
    for (let i = 0; i < CANONICAL_VERTEX_COUNT; i++) {
      const x = camera[i * 3];
      const y = camera[i * 3 + 1];
      const z = camera[i * 3 + 2];
      const X = e[0] * x + e[4] * y + e[8] * z + e[12];
      const Y = e[1] * x + e[5] * y + e[9] * z + e[13];
      const Z = e[2] * x + e[6] * y + e[10] * z + e[14];
      const d = Math.hypot(X, Y, Z) || 1;
      const k = (d + bias) / d;
      p[i * 3] = X * k;
      p[i * 3 + 1] = Y * k;
      p[i * 3 + 2] = Z * k;
    }
    this.faceGeometry.attributes.position.needsUpdate = true;
    for (const side of [0, 1] as const) {
      const f = side === 0 ? facing : -facing;
      if (f < SIDE_AWAY_ON) this.sideAway[side] = true;
      else if (f > SIDE_AWAY_OFF) this.sideAway[side] = false;
      this.faceSides[side].visible = this.occlusion && this.sideAway[side];
    }
  }

  /** Fits the head proxy to the measured face (canonical space). */
  updateHead(profile: FaceProfile): void {
    const { earL, earR } = profile;
    const earX = (earL.x - earR.x) / 2;
    const earY = (earL.y + earR.y) / 2;
    const earZ = (earL.z + earR.z) / 2;
    const cx = (earL.x + earR.x) / 2;
    const cy = earY - HEAD.down;
    const cz = earZ - HEAD.back;
    const b = HEAD.halfHeight;
    const eyeY = (profile.pupilL.y + profile.pupilR.y) / 2;
    const frontZ = profile.eyeZ - HEAD.frontGap;
    const cf = Math.max((frontZ - cz) / Math.sqrt(Math.max(1 - ((eyeY - cy) / b) ** 2, 0.2)), 2);
    const a =
      (earX - HEAD.rimInset) / Math.sqrt(Math.max(1 - ((earZ - cz) / cf) ** 2 - ((earY - cy) / b) ** 2, 0.2));

    for (const [mesh, depth] of [
      [this.headFront, cf],
      [this.headBack, HEAD.backDepth],
    ] as const) {
      mesh.position.set(cx, cy, cz);
      mesh.scale.set(a, b, depth);
    }
    for (let i = 0; i < this.headParts.length; i++) {
      this.headDebug[i].position.copy(this.headParts[i].position);
      this.headDebug[i].scale.copy(this.headParts[i].scale);
    }
    this.markers[0].position.copy(profile.pupilL);
    this.markers[1].position.copy(profile.pupilR);
    this.markers[2].position.copy(earL);
    this.markers[3].position.copy(earR);
  }

  setOcclusion(enabled: boolean): void {
    this.occlusion = enabled;
    this.face.visible = enabled;
    for (const side of [0, 1] as const) this.faceSides[side].visible = enabled && this.sideAway[side];
    for (const m of this.headParts) m.visible = enabled;
  }

  setDebug(showFaceMesh: boolean, showOccluders: boolean): void {
    this.faceDebug.visible = showFaceMesh;
    for (const m of this.headDebug) m.visible = showOccluders;
    for (const m of this.markers) m.visible = showOccluders;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of [...this.depthMaterials, ...this.otherMaterials]) m.dispose();
  }
}
