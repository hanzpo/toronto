// Per-frame view culling + detail rings + the adaptive quality governor.
//
// Detail rings around the camera (docs/OPTIMIZATION_PLAN.md), scaled by the
// quality level:
//   ring 0  (< r0 ≈ 300 m)   full models, shadow casters
//   ring 1  (< r1 ≈ 1.5 km)  low-LOD vehicles / trees / people, no shadows
//   ring 2  (< r2 ≈ 4 km)    markers / simplified buildings, no furniture
// Layers call `view.sphere(x, y, z, r)` (world coords: x = E, y = up, z = −N)
// for per-instance frustum culling and `view.ring(d)` to pick a detail level.
import * as THREE from 'three/webgpu';

import type { QualityMode } from '../state/store';

interface Level { name: string; scale: number; dpr: number }
/** governor steps from best to cheapest; presets pin one */
const LEVELS: Level[] = [
  { name: 'high', scale: 1, dpr: 2 },
  { name: 'high-', scale: 0.85, dpr: 1.5 },
  { name: 'medium', scale: 0.7, dpr: 1.25 },
  { name: 'medium-', scale: 0.6, dpr: 1 },
  { name: 'low', scale: 0.5, dpr: 0.85 },
];
const PRESET: Record<Exclude<QualityMode, 'auto'>, number> = { high: 0, medium: 2, low: 4 };

export const RING0 = 300;
export const RING1 = 1500;
export const RING2 = 4000;
/**
 * `?cull=0` switches off this pass's draw culling (widened-frustum pool membership,
 * occlusion horizon, far road detail, landmark material merge, apron equipment
 * range, lamp range): paired A/B checks in one session.
 */
export const CULL = !/[?&]cull=0\b/.test(location.search);
/** object layer rendered only by the sun's shadow camera (render/atmosphere.ts enables it there) */
export const SHADOW_ONLY_LAYER = 1;
/** widened frustum (pool membership): margin per side, re-snapshot after this turn (cos) or move (m) */
const WIDE_MARGIN = THREE.MathUtils.degToRad(18);
const WIDE_TURN_COS = Math.cos(THREE.MathUtils.degToRad(5));
const WIDE_MOVE = 40;

export class ViewCull {
  /** frustum planes (world): nx, ny, nz, d — inside when n·p + d ≥ −r */
  readonly planes = new Float64Array(24);
  x = 0; y = 0; z = 0;
  r0 = RING0; r1 = RING1; r2 = RING2;
  /** quality detail scale (0.5 … 1) applied to ring radii and LOD distances */
  scale = 1;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  /**
   * Widened view frustum for instance-pool membership (houses, street
   * furniture, far trees): the camera frustum opened by WIDE_MARGIN on every
   * side, re-snapshotted only when the view turned by more than WIDE_TURN or
   * moved more than WIDE_MOVE (then `wideVersion` increments). Pools that
   * rebuild membership on a version change never show a missing tile or cell
   * at the screen edge: the real frustum stays inside the snapshot until the
   * next one, which is taken in the same frame, before rendering.
   */
  readonly wide = new THREE.Frustum();
  wideVersion = 0;
  private wideDir = new THREE.Vector3(0, 0, 0);
  private widePos = new THREE.Vector3(Infinity, 0, 0);
  private wideFov = 0;
  private tmpDir = new THREE.Vector3();
  private tmpBox = new THREE.Box3();
  private wideP = new THREE.Matrix4();

  update(cam: THREE.PerspectiveCamera, scale: number) {
    this.scale = scale;
    this.r0 = RING0 * scale; this.r1 = RING1 * scale; this.r2 = RING2 * scale;
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, cam.coordinateSystem, cam.reversedDepth);
    const p = this.planes;
    this.frustum.planes.forEach((pl, i) => { p[i * 4] = pl.normal.x; p[i * 4 + 1] = pl.normal.y; p[i * 4 + 2] = pl.normal.z; p[i * 4 + 3] = pl.constant; });
    this.x = cam.position.x; this.y = cam.position.y; this.z = cam.position.z;
    const dir = cam.getWorldDirection(this.tmpDir);
    if (dir.dot(this.wideDir) < WIDE_TURN_COS || cam.position.distanceTo(this.widePos) > WIDE_MOVE || cam.fov !== this.wideFov) {
      this.wideDir.copy(dir);
      this.widePos.copy(cam.position);
      this.wideFov = cam.fov;
      // same projection with the x / y extents opened by WIDE_MARGIN (near / far unchanged)
      const e = this.wideP.copy(cam.projectionMatrix).elements;
      const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), th = tv * cam.aspect;
      e[0] *= th / Math.tan(Math.min(1.5, Math.atan(th) + WIDE_MARGIN));
      e[5] *= tv / Math.tan(Math.min(1.5, Math.atan(tv) + WIDE_MARGIN));
      this.wideP.multiply(cam.matrixWorldInverse);
      this.wide.setFromProjectionMatrix(this.wideP, cam.coordinateSystem, cam.reversedDepth);
      this.wideVersion++;
    }
  }

  /** axis-aligned box given in E, N, elevation intersects the widened frustum snapshot */
  wideBoxEN(e0: number, n0: number, h0: number, e1: number, n1: number, h1: number): boolean {
    if (!CULL) return true;
    this.tmpBox.min.set(e0, h0, -n1);
    this.tmpBox.max.set(e1, h1, -n0);
    return this.wide.intersectsBox(this.tmpBox);
  }

  /** sphere given in E, N, elevation intersects the widened frustum snapshot */
  wideSphereEN(e: number, n: number, h: number, r: number): boolean {
    if (!CULL) return true;
    const pl = this.wide.planes;
    for (let i = 0; i < 6; i++) {
      const q = pl[i];
      if (q.normal.x * e + q.normal.y * h - q.normal.z * n + q.constant < -r) return false;
    }
    return true;
  }

  /** sphere (world coords) intersects the view frustum */
  sphere(x: number, y: number, z: number, r: number): boolean {
    const p = this.planes;
    for (let i = 0; i < 24; i += 4) if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < -r) return false;
    return true;
  }

  /** sphere given in E, N, elevation */
  sphereEN(e: number, n: number, h: number, r: number): boolean {
    return this.sphere(e, h, -n, r);
  }

  /** squared distance from the camera (E, N, elevation) */
  dist2EN(e: number, n: number, h: number): number {
    const dx = e - this.x, dy = h - this.y, dz = -n - this.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** detail ring of a camera distance: 0, 1, 2 or 3 (beyond ring 2) */
  ring(d: number): number {
    return d < this.r0 ? 0 : d < this.r1 ? 1 : d < this.r2 ? 2 : 3;
  }
}

/**
 * Adaptive quality: the frame interval (EMA) drives a detail level (ring radii,
 * LOD distances, tile refinement) and the render resolution. It steps down
 * after ~1 s over budget and back up after ~4 s comfortably under it; fixed
 * presets pin a level.
 */
export class QualityGovernor {
  mode: QualityMode = 'auto';
  level = 0;
  private ema = 16.7;
  private over = 0;
  private under = 0;
  private cooldown = 0;
  private clock = 0;
  /** per level: time until stepping back up to it is allowed again (backs off after each failure) */
  private blockedUntil = LEVELS.map(() => 0);
  private backoff = LEVELS.map(() => 10);
  /** device pixel ratio cap of the display */
  private maxDpr = Math.min(window.devicePixelRatio || 1, 2);

  get current(): Level { return LEVELS[this.level]; }
  get scale(): number { return LEVELS[this.level].scale; }
  get dpr(): number { return Math.min(this.maxDpr, LEVELS[this.level].dpr); }
  get name(): string { return LEVELS[this.level].name; }

  setMode(m: QualityMode) {
    this.mode = m;
    if (m !== 'auto') this.level = PRESET[m];
    this.over = this.under = 0;
    this.cooldown = 1;
  }

  /**
   * Feed one frame. `dtMs` = real frame interval, `busy` = tiles streaming /
   * shaders compiling (spikes then are not the steady-state cost).
   * Returns true when the level changed.
   */
  sample(dtMs: number, busy: boolean): boolean {
    if (this.mode !== 'auto') return false;
    const dt = Math.min(dtMs, 100);
    this.ema += (dt - this.ema) * 0.05;
    const s = dt / 1000;
    this.clock += s;
    if (this.cooldown > 0) { this.cooldown -= s; return false; }
    // budget: 60 Hz (16.7 ms) with slack for vsync jitter. At vsync the interval
    // can't show headroom, so stepping up is a probe: if the level it returns
    // to overloads again, that level is blocked for exponentially longer.
    if (this.ema > 19.5 && !busy) { this.over += s; this.under = 0; }
    else if (this.ema < 17.5) { this.under += s; this.over = 0; }
    else { this.over = Math.max(0, this.over - s); this.under = Math.max(0, this.under - s); }
    if (this.over > 1.2 && this.level < LEVELS.length - 1) {
      const L = this.level;
      this.blockedUntil[L] = this.clock + this.backoff[L];
      this.backoff[L] = Math.min(600, this.backoff[L] * 2);
      this.level++;
      this.over = 0; this.cooldown = 1.5;
      return true;
    }
    if (this.under > 5 && this.level > 0 && this.clock > this.blockedUntil[this.level - 1]) {
      this.level--;
      this.under = 0; this.cooldown = 3;
      return true;
    }
    return false;
  }
}
