import * as THREE from 'three';

/**
 * One Euro filter (Casiez et al. 2012), vector form: the cutoff adapts to the speed of the
 * whole vector, so strong smoothing at rest and almost no lag while the head moves.
 */
export class OneEuroVector {
  private x: Float64Array;
  private dx: Float64Array;
  private t = -1;
  constructor(
    readonly dim: number,
    public minCutoff = 1,
    public beta = 0,
    public dCutoff = 1,
  ) {
    this.x = new Float64Array(dim);
    this.dx = new Float64Array(dim);
  }

  reset(): void {
    this.t = -1;
  }

  /** Filters `v` in place. `t` is in seconds. */
  filter(v: ArrayLike<number> & { [i: number]: number }, t: number): void {
    if (this.t < 0) {
      for (let i = 0; i < this.dim; i++) {
        this.x[i] = v[i];
        this.dx[i] = 0;
      }
      this.t = t;
      return;
    }
    const dt = Math.min(Math.max(t - this.t, 1e-3), 0.5);
    this.t = t;
    const aD = alpha(this.dCutoff, dt);
    let speed = 0;
    for (let i = 0; i < this.dim; i++) {
      const d = (v[i] - this.x[i]) / dt;
      this.dx[i] = aD * d + (1 - aD) * this.dx[i];
      speed += this.dx[i] * this.dx[i];
    }
    const a = alpha(this.minCutoff + this.beta * Math.sqrt(speed), dt);
    for (let i = 0; i < this.dim; i++) {
      this.x[i] = a * v[i] + (1 - a) * this.x[i];
      v[i] = this.x[i];
    }
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export interface PoseFilterParams {
  posMinCutoff: number;
  posBeta: number;
  rotMinCutoff: number;
  rotBeta: number;
}

/** Smooths a rigid(+uniform scale) transform: position, rotation and scale separately. */
export class PoseFilter {
  private pos = new OneEuroVector(3);
  private rot = new OneEuroVector(4);
  private scl = new OneEuroVector(1, 1, 0);
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private prevQ = new THREE.Quaternion();
  private hasPrev = false;
  private buf3 = [0, 0, 0];
  private buf4 = [0, 0, 0, 1];
  private buf1 = [1];

  setParams(p: PoseFilterParams): void {
    this.pos.minCutoff = p.posMinCutoff;
    this.pos.beta = p.posBeta;
    this.rot.minCutoff = p.rotMinCutoff;
    this.rot.beta = p.rotBeta;
    this.scl.minCutoff = Math.min(p.posMinCutoff, 1);
  }

  reset(): void {
    this.pos.reset();
    this.rot.reset();
    this.scl.reset();
    this.hasPrev = false;
  }

  apply(input: THREE.Matrix4, t: number, out: THREE.Matrix4): THREE.Matrix4 {
    input.decompose(this.p, this.q, this.s);
    // Keep quaternions in one hemisphere so component-wise filtering is valid.
    if (this.hasPrev && this.q.dot(this.prevQ) < 0) {
      this.q.set(-this.q.x, -this.q.y, -this.q.z, -this.q.w);
    }
    const b3 = this.buf3;
    b3[0] = this.p.x;
    b3[1] = this.p.y;
    b3[2] = this.p.z;
    this.pos.filter(b3, t);
    this.p.set(b3[0], b3[1], b3[2]);

    const b4 = this.buf4;
    b4[0] = this.q.x;
    b4[1] = this.q.y;
    b4[2] = this.q.z;
    b4[3] = this.q.w;
    this.rot.filter(b4, t);
    this.q.set(b4[0], b4[1], b4[2], b4[3]).normalize();
    this.prevQ.copy(this.q);
    this.hasPrev = true;

    const b1 = this.buf1;
    b1[0] = (this.s.x + this.s.y + this.s.z) / 3;
    this.scl.filter(b1, t);
    this.s.setScalar(b1[0]);
    return out.compose(this.p, this.q, this.s);
  }
}

export const SMOOTHING_PRESETS: Record<'low' | 'medium' | 'high', PoseFilterParams> = {
  low: { posMinCutoff: 2.2, posBeta: 1.6, rotMinCutoff: 2.2, rotBeta: 30 },
  medium: { posMinCutoff: 1.0, posBeta: 0.9, rotMinCutoff: 1.0, rotBeta: 20 },
  high: { posMinCutoff: 0.45, posBeta: 0.45, rotMinCutoff: 0.45, rotBeta: 10 },
};
