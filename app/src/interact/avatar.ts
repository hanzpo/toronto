// The player's pedestrian: the NPC pedestrian model (layers/traffic/models.ts)
// split into its jointed parts (body, arms, legs swinging about shoulder /
// hip pivots) and animated on the CPU: idle (breathing, weight shift), walk
// and run blended by speed, with lean into acceleration and turns.
import * as THREE from 'three/webgpu';
import { pedestrianGeometries, shirtPalette } from '../layers/traffic/models';

const TAU = Math.PI * 2;

/** split a packed pedestrian geometry by its `limb` attribute (0 body, 1/2 arms, 3/4 legs) */
function splitLimbs(src: THREE.BufferGeometry, shirt: THREE.Color): { geo: THREE.BufferGeometry; pivot: number }[] {
  const g = src.index ? src.toNonIndexed() : src;
  const pos = g.attributes.position.array as Float32Array;
  const nor = g.attributes.normal.array as Float32Array;
  const col = g.attributes.color.array as Float32Array;
  const limb = g.attributes.limb.array as Float32Array;
  const piv = g.attributes.pivot.array as Float32Array;
  const tint = (g.attributes.tint ?? g.attributes.livery)?.array as Float32Array | undefined;
  const out: { geo: THREE.BufferGeometry; pivot: number }[] = [];
  for (let k = 0; k < 5; k++) {
    const P: number[] = [], N: number[] = [], C: number[] = [];
    let pivot = 0;
    // triangles are never split across limbs (built per part)
    for (let v = 0; v < limb.length; v += 3) {
      if (Math.round(limb[v]) !== k) continue;
      for (let j = v; j < v + 3; j++) {
        pivot = piv[j];
        P.push(pos[3 * j], pos[3 * j + 1] - (k ? piv[j] : 0), pos[3 * j + 2]);
        N.push(nor[3 * j], nor[3 * j + 1], nor[3 * j + 2]);
        const t = tint ? tint[j] : 0;
        C.push(col[3 * j] * (1 - t + t * shirt.r), col[3 * j + 1] * (1 - t + t * shirt.g), col[3 * j + 2] * (1 - t + t * shirt.b));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.computeBoundingSphere();
    out.push({ geo, pivot: k ? pivot : 0 });
  }
  if (g !== src) g.dispose();
  return out;
}

export class Avatar {
  readonly group = new THREE.Group();
  /** leans / bobs as a whole (child of group) */
  private root = new THREE.Group();
  private upper = new THREE.Group();
  private parts: THREE.Group[] = [];
  private mat: THREE.MeshStandardNodeMaterial;
  private cycle = 0;
  private t = Math.random() * 10;
  private lean = 0;
  private bank = 0;
  private gait = 0; // 0 walk .. 1 run (smoothed)

  constructor(body = 0, shirt = 7) {
    this.group.name = 'player-avatar';
    const geos = pedestrianGeometries();
    const parts = splitLimbs(geos[body % geos.length], shirtPalette[shirt % shirtPalette.length]);
    this.mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    this.mat.name = 'player-avatar';
    this.group.add(this.root);
    this.root.add(this.upper);
    // the upper body (pelvis up, arms) leans about the hips; legs hang from them
    const hip = parts[3].pivot;
    this.upper.position.y = hip;
    parts.forEach(({ geo, pivot }, k) => {
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const joint = new THREE.Group();
      const up = k === 0 || k === 1 || k === 2;
      joint.position.y = up ? pivot - hip : pivot;
      joint.add(mesh);
      (up ? this.upper : this.root).add(joint);
      this.parts.push(joint);
    });
  }

  /**
   * Advance the animation. speed m/s along the facing, accel m/s² (lean),
   * turn rad/s (bank into turns).
   */
  animate(dt: number, speed: number, accel: number, turn: number) {
    this.t += dt;
    const v = Math.abs(speed);
    const moving = THREE.MathUtils.smoothstep(v, 0.05, 0.6);
    const runW = THREE.MathUtils.smoothstep(v, 2.2, 4.5);
    this.gait += (runW - this.gait) * (1 - Math.exp(-dt * 6));
    const gait = this.gait;
    // stride per gait cycle (two steps): ~1.45 m walking, ~2.9 m running
    const stride = 1.45 + 1.45 * gait;
    this.cycle = (this.cycle + (v / stride) * TAU * dt * Math.sign(speed || 1)) % TAU;
    const s = Math.sin(this.cycle);
    const legA = (0.42 + 0.4 * gait) * moving;
    const armA = (0.3 + 0.5 * gait) * moving;
    const [, armL, armR, legL, legR] = this.parts;
    legL.rotation.z = s * legA;
    legR.rotation.z = -s * legA;
    // idle: arms hang with a slight sway; running: arms pumped and bent forward
    const idleSway = (1 - moving) * Math.sin(this.t * 1.3) * 0.03;
    armL.rotation.z = -s * armA + gait * 0.35 * moving + idleSway;
    armR.rotation.z = s * armA + gait * 0.35 * moving - idleSway;
    armL.rotation.x = 0.05 + 0.1 * gait * moving; // arms clear the hips, a touch wider running
    armR.rotation.x = -0.05 - 0.1 * gait * moving;
    // bob: two per cycle; running adds a flight phase
    const bob = Math.abs(Math.cos(this.cycle)) * (0.028 + 0.05 * gait) * moving;
    const breathe = (1 - moving) * Math.sin(this.t * 1.9) * 0.006;
    this.root.position.y = bob + breathe - 0.02 * gait * moving;
    // lean: forward into speed / acceleration, back when braking; bank into turns
    const wantLean = -(0.04 * moving + 0.12 * gait * moving + THREE.MathUtils.clamp(accel * 0.025, -0.12, 0.15));
    this.lean += (wantLean - this.lean) * (1 - Math.exp(-dt * 6));
    const wantBank = THREE.MathUtils.clamp(-turn * v * 0.045, -0.25, 0.25);
    this.bank += (wantBank - this.bank) * (1 - Math.exp(-dt * 6));
    this.upper.rotation.z = this.lean;
    this.root.rotation.x = this.bank;
    // idle weight shift + upper body counter-rotation while striding
    this.upper.rotation.y = s * 0.08 * moving + (1 - moving) * Math.sin(this.t * 0.4) * 0.04;
    this.root.position.z = (1 - moving) * Math.sin(this.t * 0.35) * 0.015;
  }

  dispose() {
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    this.mat.dispose();
    this.group.removeFromParent();
  }
}
