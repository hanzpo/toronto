// Low-poly smoke puffs from a damaged player car (one small instanced pool).
import * as THREE from 'three/webgpu';

const CAP = 40;
const LIFE = 2.6;

export class Smoke {
  readonly mesh: THREE.InstancedMesh;
  private p = new Float32Array(CAP * 6); // e, n, z, age, seed, dark
  private live = 0;
  private acc = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private v = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(parent: THREE.Object3D) {
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0, transparent: true, opacity: 0.42, depthWrite: false });
    mat.name = 'player-smoke';
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 0), mat, CAP);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'player-smoke';
    parent.add(this.mesh);
  }

  /**
   * Advance: emit from (e, n, z) at a rate set by damage (0..1); origin = anchor offset
   * (three x = e - ox, z = -n - oz).
   */
  update(dt: number, damage: number, e: number, n: number, z: number, ox: number, oz: number, wind: [number, number]) {
    const P = this.p;
    // age / remove
    let w = 0;
    for (let i = 0; i < this.live; i++) {
      const o = i * 6;
      P[o + 3] += dt;
      if (P[o + 3] >= LIFE) continue;
      if (w !== i) P.copyWithin(w * 6, o, o + 6);
      w++;
    }
    this.live = w;
    if (damage > 0.3 && Number.isFinite(e)) {
      this.acc += dt * (2 + damage * 7);
      while (this.acc >= 1 && this.live < CAP) {
        this.acc -= 1;
        const o = this.live++ * 6;
        P[o] = e + (Math.random() - 0.5) * 0.6; P[o + 1] = n + (Math.random() - 0.5) * 0.6; P[o + 2] = z;
        P[o + 3] = Math.random() * 0.1; P[o + 4] = Math.random(); P[o + 5] = damage > 0.75 ? 1 : 0;
      }
      if (this.acc > 1) this.acc = 0;
    }
    const col = this.mesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.live; i++) {
      const o = i * 6, a = P[o + 3], k = a / LIFE;
      const rise = 0.9 * a + 0.2 * a * a;
      this.v.set(P[o] + wind[0] * a - ox, P[o + 2] + rise, -(P[o + 1] + wind[1] * a) - oz);
      const sc = 0.3 + 1.1 * k + P[o + 4] * 0.25;
      this.s.set(sc, sc * 0.8, sc);
      this.q.setFromAxisAngle(_up, P[o + 4] * 6 + a * 0.6);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      // fade by darkening towards the (lighter) sky and shrinking contrast
      const base = P[o + 5] ? 0.12 : 0.5;
      this.c.setScalar(base + (0.78 - base) * k);
      col[i * 3] = this.c.r; col[i * 3 + 1] = this.c.g; col[i * 3 + 2] = this.c.b;
    }
    this.mesh.count = this.live;
    if (this.live) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true; }
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

const _up = new THREE.Vector3(0, 1, 0);
