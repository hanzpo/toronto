// Pedestrian avatar: a stylised figure walked with WASD, height from terrain.
import * as THREE from 'three/webgpu';

export class Walker {
  readonly group = new THREE.Group();
  e = 0;
  n = 0;
  h = 0;
  /** facing, rad CCW from +E */
  heading = Math.PI / 2;
  speed = 0;
  private phase = 0;
  private legL: THREE.Object3D;
  private legR: THREE.Object3D;
  private armL: THREE.Object3D;
  private armR: THREE.Object3D;
  private body: THREE.Object3D;

  constructor() {
    const mat = (c: number) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.7 });
    const jacket = mat(0xd9412b), pants = mat(0x2b3140), skin = mat(0xe0b08c), shoe = mat(0x1a1a1a), bag = mat(0x3d5a80);
    const g = this.group;
    g.name = 'walker';
    const body = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 4, 10), jacket);
    torso.position.y = 1.22;
    torso.scale.set(1, 1, 0.75);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), skin);
    head.position.y = 1.64;
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x222831));
    hat.position.y = 1.66;
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.36, 0.14), bag);
    pack.position.set(0, 1.25, 0.2);
    body.add(torso, head, hat, pack);
    this.body = body;
    const limb = (len: number, r: number, m: THREE.Material, foot?: THREE.Material) => {
      const pivot = new THREE.Group();
      const l = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 8), m);
      l.position.y = -len / 2 - r;
      pivot.add(l);
      if (foot) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.24), foot);
        f.position.set(0, -len - 2 * r, -0.05);
        pivot.add(f);
      }
      return pivot;
    };
    this.legL = limb(0.62, 0.075, pants, shoe); this.legL.position.set(-0.1, 0.86, 0);
    this.legR = limb(0.62, 0.075, pants, shoe); this.legR.position.set(0.1, 0.86, 0);
    this.armL = limb(0.46, 0.055, jacket); this.armL.position.set(-0.27, 1.45, 0);
    this.armR = limb(0.46, 0.055, jacket); this.armR.position.set(0.27, 1.45, 0);
    body.add(this.legL, this.legR, this.armL, this.armR);
    g.add(body);
    // soft ground marker so the figure reads from further away
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicNodeMaterial({ color: 0xffd23f, transparent: true, opacity: 0.8, depthWrite: false }));
    ring.position.y = 0.05;
    g.add(ring);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  }

  place(e: number, n: number, h: number, heading = this.heading) {
    this.e = e; this.n = n; this.h = h; this.heading = heading;
    this.sync();
  }

  /**
   * move: forward/right in camera frame; yaw = camera heading (rad CCW from +E).
   */
  step(dt: number, fwd: number, right: number, yaw: number, run: boolean, heightAt: (e: number, n: number) => number) {
    const len = Math.hypot(fwd, right);
    const target = len > 0 ? (run ? 5.2 : 1.6) : 0;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt * 8));
    if (len > 0) {
      const dirE = Math.cos(yaw) * fwd + Math.sin(yaw) * right;
      const dirN = Math.sin(yaw) * fwd - Math.cos(yaw) * right;
      const want = Math.atan2(dirN, dirE);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * (1 - Math.exp(-dt * 12));
    }
    this.e += Math.cos(this.heading) * this.speed * dt;
    this.n += Math.sin(this.heading) * this.speed * dt;
    const g = heightAt(this.e, this.n);
    this.h += (g - this.h) * (1 - Math.exp(-dt * 15));
    this.phase += this.speed * dt * (run ? 2.0 : 3.6);
    this.sync();
  }

  private sync() {
    const g = this.group;
    g.position.set(this.e, this.h, -this.n);
    // model faces -z; heading CCW from +E → rotation about y
    g.rotation.y = this.heading - Math.PI / 2;
    const sw = Math.sin(this.phase) * Math.min(1, this.speed / 1.6) * 0.6;
    this.legL.rotation.x = sw; this.legR.rotation.x = -sw;
    this.armL.rotation.x = -sw * 0.8; this.armR.rotation.x = sw * 0.8;
    this.body.position.y = Math.abs(Math.cos(this.phase)) * 0.04 * Math.min(1, this.speed);
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
    this.group.removeFromParent();
  }
}
