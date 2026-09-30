// The walking player: third-person movement relative to the camera (WASD,
// Shift to run), jointed pedestrian avatar (avatar.ts) animated by speed,
// collisions with the solid world (walkCollide.ts), feet on the terrain /
// raised sidewalk.
import type * as THREE from 'three/webgpu';
import { Avatar } from './avatar';

export interface WalkEnv {
  heightAt(e: number, n: number): number;
  /** push the body circle out of solids; returns the resolved position */
  collide(e: number, n: number, h: number, r: number): { e: number; n: number; push: number };
  /** 1 carriageway, 2 sidewalk, 0 other */
  surface(e: number, n: number): number;
}

const WALK = 1.55;
const RUN = 5.4;
/** body radius (m) */
export const WALKER_R = 0.32;
/** raised sidewalk / road surface above the terrain (TrafficLayer ROAD_LIFT / WALK_LIFT) */
const LIFT = [0.03, 0.06, 0.2];

export class Walker {
  readonly avatar: Avatar;
  e = 0;
  n = 0;
  h = 0;
  /** facing, rad CCW from +E */
  heading = Math.PI / 2;
  speed = 0;
  /** surface under the feet (see WalkEnv.surface) */
  surface = 0;
  private lift = 0.03;
  private lastSpeed = 0;
  private surfAcc = 1;

  constructor(body = 0, shirt = 7) {
    this.avatar = new Avatar(body, shirt);
  }

  get group(): THREE.Group { return this.avatar.group; }

  place(e: number, n: number, h: number, heading = this.heading) {
    this.e = e; this.n = n; this.h = h; this.heading = heading;
    this.speed = 0;
    this.surfAcc = 1;
    this.sync();
  }

  /**
   * move: forward/right in camera frame; yaw = camera heading (rad CCW from +E).
   */
  step(dt: number, fwd: number, right: number, yaw: number, run: boolean, env: WalkEnv) {
    dt = Math.min(dt, 0.05);
    const len = Math.hypot(fwd, right);
    const target = len > 0 ? (run ? RUN : WALK) : 0;
    // accelerate briskly, stop a bit quicker than you start
    const rate = target > this.speed ? (run ? 3.2 : 6) : 9;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt * rate));
    if (this.speed < 0.02 && target === 0) this.speed = 0;
    const h0 = this.heading;
    if (len > 0) {
      const dirE = Math.cos(yaw) * fwd + Math.sin(yaw) * right;
      const dirN = Math.sin(yaw) * fwd - Math.cos(yaw) * right;
      const want = Math.atan2(dirN, dirE);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      // sharp reversals turn on the spot; running turns are wider
      this.heading += d * (1 - Math.exp(-dt * (run ? 7 : 11)));
    }
    const ne = this.e + Math.cos(this.heading) * this.speed * dt;
    const nn = this.n + Math.sin(this.heading) * this.speed * dt;
    const r = env.collide(ne, nn, this.h, WALKER_R);
    const moved = Math.hypot(r.e - this.e, r.n - this.n);
    this.e = r.e; this.n = r.n;
    // walking into a wall: the legs slow down to what actually moves
    if (dt > 0 && r.push > 0.002) this.speed = Math.min(this.speed, Math.max(moved / dt, this.speed * 0.6));
    this.surfAcc += dt;
    if (this.surfAcc > 0.15) { this.surfAcc = 0; this.surface = env.surface(this.e, this.n); }
    // step up the curb quickly, down it a little softer
    const want = LIFT[this.surface] ?? 0.03;
    this.lift += (want - this.lift) * (1 - Math.exp(-dt * (want > this.lift ? 25 : 12)));
    const g = env.heightAt(this.e, this.n) + this.lift;
    this.h += (g - this.h) * (1 - Math.exp(-dt * 18));
    const turn = dt > 0 ? Math.atan2(Math.sin(this.heading - h0), Math.cos(this.heading - h0)) / dt : 0;
    const accel = dt > 0 ? (this.speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = this.speed;
    this.avatar.animate(dt, this.speed, accel, turn);
    this.sync();
  }

  private sync() {
    const g = this.group;
    g.position.set(this.e, this.h, -this.n);
    // model faces +x; heading CCW from +E → rotation about y
    g.rotation.y = this.heading;
  }

  dispose() {
    this.avatar.dispose();
  }
}
