// Map-style camera: left-drag pan (grab the ground), right-drag rotate/tilt,
// wheel zoom toward cursor, WASD/QE/RF keys, damping, fly-to and follow.
import * as THREE from 'three/webgpu';

export interface CamState {
  /** focus point, world E/N (m) and elevation (datum m) */
  e: number;
  n: number;
  h: number;
  /** distance from focus to camera (m) */
  dist: number;
  /** view heading, radians clockwise from north */
  heading: number;
  /** angle below the horizon, radians (π/2 = straight down) */
  pitch: number;
}

export interface GroundHit {
  e: number;
  n: number;
  h: number;
}

export interface ControllerHost {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  heightAt(e: number, n: number): number;
  pickGround(clientX: number, clientY: number): GroundHit | null;
  /**
   * Optional building volume query for camera collision: top elevation of a
   * building containing (e, n) at elevation h, or -Infinity when free.
   */
  buildingTop?(e: number, n: number, h: number): number;
}

const MIN_DIST = 4;
const MAX_DIST = 260000;
const MIN_PITCH = 0.02;
const MAX_PITCH = 1.55;
export const MIN_ALTITUDE = 2;

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Flight {
  from: CamState;
  to: CamState;
  t0: number;
  dur: number;
  hop: number;
  resolve: () => void;
}

export class CameraController {
  goal: CamState;
  cur: CamState;
  enabled = true;
  private keys = new Set<string>();
  private drag: { mode: 'pan' | 'rotate'; x: number; y: number; grab: GroundHit | null; id: number } | null = null;
  private flight: Flight | null = null;
  private followFn: (() => GroundHit | null) | null = null;
  private time = 0;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  /** camera collision: smoothed fraction of the orbit distance that is free (1 = unobstructed) */
  private collFrac = 1;
  /** camera collision: extra pitch (rad) that lifts the view over an obstacle */
  private collLift = 0;
  /** collision on/off (e.g. cab views that place the camera themselves) */
  collide = true;

  private host: ControllerHost;
  constructor(host: ControllerHost, init: CamState) {
    this.host = host;
    this.goal = { ...init };
    this.cur = { ...init };
    const d = host.dom;
    d.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    d.addEventListener('wheel', this.onWheel, { passive: false });
    d.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('dblclick', this.onDbl);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  dispose() {
    const d = this.host.dom;
    d.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    d.removeEventListener('wheel', this.onWheel);
    d.removeEventListener('dblclick', this.onDbl);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  // ------------------------------------------------------------------------ public API

  /** Animate to a view. Missing fields keep the current value. */
  flyTo(to: Partial<CamState> & { e: number; n: number }, duration = 2.2): Promise<void> {
    this.followFn = null;
    const target: CamState = {
      e: to.e, n: to.n, h: to.h ?? this.host.heightAt(to.e, to.n),
      dist: to.dist ?? this.goal.dist, heading: to.heading ?? this.goal.heading, pitch: to.pitch ?? this.goal.pitch,
    };
    const travel = Math.hypot(target.e - this.cur.e, target.n - this.cur.n);
    const maxD = Math.max(this.cur.dist, target.dist);
    const hop = Math.max(0, Math.log(Math.max(travel * 0.6, maxD) / maxD));
    this.flight?.resolve();
    return new Promise((resolve) => {
      this.flight = { from: { ...this.cur }, to: target, t0: this.time, dur: Math.max(0.01, duration), hop, resolve };
    });
  }

  /** Jump without animation. */
  jumpTo(s: Partial<CamState>) {
    this.flight = null;
    Object.assign(this.goal, s);
    Object.assign(this.cur, s);
  }

  /**
   * Follow a moving target (e.g. a vehicle). The getter is polled each frame;
   * return null to stop. User pan cancels following.
   */
  follow(getter: (() => GroundHit | null) | null, opts: { dist?: number; pitch?: number } = {}) {
    this.followFn = getter;
    this.flight = null;
    if (opts.dist) this.goal.dist = opts.dist;
    if (opts.pitch) this.goal.pitch = opts.pitch;
  }

  get following() {
    return this.followFn !== null;
  }

  // ------------------------------------------------------------------------ per frame

  update(dt: number) {
    this.time += dt;
    const g = this.goal, c = this.cur;

    if (this.flight) {
      const f = this.flight;
      const u = Math.min(1, (this.time - f.t0) / f.dur);
      const s = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // easeInOutCubic
      c.e = f.from.e + (f.to.e - f.from.e) * s;
      c.n = f.from.n + (f.to.n - f.from.n) * s;
      c.h = f.from.h + (f.to.h - f.from.h) * s;
      const ld = Math.log(f.from.dist) + (Math.log(f.to.dist) - Math.log(f.from.dist)) * s + f.hop * Math.sin(Math.PI * u);
      c.dist = Math.exp(ld);
      c.heading = f.from.heading + wrapPi(f.to.heading - f.from.heading) * s;
      c.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * s;
      Object.assign(g, c);
      if (u >= 1) {
        this.flight = null;
        f.resolve();
      }
    } else {
      if (this.followFn) {
        const p = this.followFn();
        if (p) { g.e = p.e; g.n = p.n; g.h = p.h; } else this.followFn = null;
      }
      this.keyboard(dt);
      g.dist = THREE.MathUtils.clamp(g.dist, MIN_DIST, MAX_DIST);
      g.pitch = THREE.MathUtils.clamp(g.pitch, MIN_PITCH, MAX_PITCH);
      if (!this.followFn) g.h = this.host.heightAt(g.e, g.n, );
      const k = 1 - Math.exp(-dt * 9);
      const kr = 1 - Math.exp(-dt * 14);
      const kf = this.followFn ? 1 - Math.exp(-dt * 20) : k;
      c.e += (g.e - c.e) * kf;
      c.n += (g.n - c.n) * kf;
      c.h += (g.h - c.h) * (1 - Math.exp(-dt * 5));
      c.dist = Math.exp(Math.log(c.dist) + (Math.log(g.dist) - Math.log(c.dist)) * k);
      c.heading += wrapPi(g.heading - c.heading) * kr;
      c.pitch += (g.pitch - c.pitch) * kr;
    }
    // camera collision: pull in at once when something gets between the
    // focus and the camera, ease back out when it clears
    // (or, when pulling in would leave the eye right at the focus, lift the
    // view over the obstacle); ease back out when it clears
    const r = this.resolveCollision(this.cur);
    if (r.lift > this.collLift) this.collLift += (r.lift - this.collLift) * (1 - Math.exp(-dt * 12));
    else this.collLift += (r.lift - this.collLift) * (1 - Math.exp(-dt * 1.5));
    const fi = this.freeFraction(this.lifted(this.cur));
    if (fi < this.collFrac) this.collFrac = fi;
    else this.collFrac += (fi - this.collFrac) * (1 - Math.exp(-dt * 2.5));
    this.apply();
  }

  /** Write `cur` into the camera transform (enforcing min altitude). */
  apply() {
    const c = this.lifted(this.cur);
    const cp = Math.cos(c.pitch);
    const dist = c.dist * Math.min(this.collFrac, this.freeFraction(c));
    const camE = c.e - Math.sin(c.heading) * cp * dist;
    const camN = c.n - Math.cos(c.heading) * cp * dist;
    let camH = c.h + Math.sin(c.pitch) * dist;
    const ground = this.host.heightAt(camE, camN);
    if (camH < ground + MIN_ALTITUDE) camH = ground + MIN_ALTITUDE;
    const cam = this.host.camera;
    cam.position.set(camE, camH, -camN);
    cam.up.set(0, 1, 0);
    cam.lookAt(c.e, c.h, -c.n);
    cam.updateMatrixWorld();
  }

  private liftTmp: CamState = { e: 0, n: 0, h: 0, dist: 1, heading: 0, pitch: 0 };
  /** `c` with the collision pitch lift applied (shared temp object) */
  private lifted(c: CamState): CamState {
    if (this.collLift < 1e-3) return c;
    const t = this.liftTmp;
    t.e = c.e; t.n = c.n; t.h = c.h; t.dist = c.dist; t.heading = c.heading;
    t.pitch = Math.min(MAX_PITCH, c.pitch + this.collLift);
    return t;
  }

  /**
   * Obstruction response for orbit state c: pull the eye in along the view ray
   * when that still leaves a useful distance (close street-level views keep
   * working), otherwise tilt the view up over the obstacle (courtyards,
   * plazas, a tower right behind the camera). Chase cams only pull in.
   */
  private resolveCollision(c: CamState): { lift: number } {
    if (!this.collide || !this.host.buildingTop) return { lift: 0 };
    const f0 = this.freeFraction(c);
    if (f0 >= 0.999 || this.followFn) return { lift: 0 };
    if (f0 * c.dist >= Math.min(c.dist, Math.max(15, 0.35 * c.dist))) return { lift: 0 };
    const t = this.liftTmp;
    let best = 0, bestF = f0;
    for (const dp of [0.12, 0.25, 0.4, 0.6, 0.85, 1.15]) {
      t.e = c.e; t.n = c.n; t.h = c.h; t.dist = c.dist; t.heading = c.heading;
      t.pitch = Math.min(MAX_PITCH, c.pitch + dp);
      const f = this.freeFraction(t);
      if (f > bestF + 0.05) { best = t.pitch - c.pitch; bestF = f; }
      if (f >= 0.9) break;
    }
    return { lift: best };
  }

  private occTmp: CamState = { e: 0, n: 0, h: 0, dist: 0, heading: 0, pitch: 0 };
  /**
   * Chase / third-person rigs: fraction (0..1] of the segment focus → eye the
   * camera can use without entering a building or dipping under the terrain
   * (same ray march as the orbit camera, ~1.5 m off walls). 1 = unobstructed.
   */
  occlusion(fe: number, fn: number, fh: number, ee: number, en: number, eh: number): number {
    const dx = ee - fe, dn = en - fn, dh = eh - fh;
    const hz = Math.hypot(dx, dn);
    const d = Math.hypot(hz, dh);
    if (d < 0.5) return 1;
    const c = this.occTmp;
    c.e = fe; c.n = fn; c.h = fh; c.dist = d;
    c.heading = Math.atan2(-dx, -dn);
    c.pitch = Math.atan2(dh, hz);
    return Math.min(1, this.freeFraction(c));
  }

  /**
   * Fraction of the orbit distance the camera can sit at without being inside
   * a building volume or below the terrain between it and the focus. The ray
   * is marched from the focus outwards; an initial stretch inside a building
   * (focus on a footprint) is ignored. Only near the ground (< 400 m).
   */
  private freeFraction(c: CamState): number {
    const top = this.host.buildingTop;
    if (!this.collide || !top || c.dist < 3) return 1;
    const sp = Math.sin(c.pitch), cp = Math.cos(c.pitch);
    const ue = -Math.sin(c.heading) * cp, un = -Math.cos(c.heading) * cp;
    // above the tallest towers (CN Tower aside) nothing can be hit
    if (c.h + sp * c.dist > c.h + 480 && sp > 0.5) return 1;
    const D = c.dist + 1.5; // keep ~1.5 m off walls
    const step = Math.max(1, Math.min(12, D / 28));
    // focus below ground (following an underground train): no terrain test
    const terr = c.h > this.host.heightAt(c.e, c.n) - 2 ? 1.5 : Infinity;
    let started = false;
    let hitT = -1;
    for (let t = Math.min(2, D); t <= D; t += step) {
      const e = c.e + ue * t, n = c.n + un * t, h = c.h + sp * t;
      const g = this.host.heightAt(e, n);
      const blocked = top.call(this.host, e, n, h) > h || (started && h < g - terr);
      if (!blocked) { started = true; continue; }
      if (!started) continue;
      hitT = t;
      // refine between t - step and t
      let a = Math.max(0, t - step), b = t;
      for (let k = 0; k < 5; k++) {
        const m = (a + b) / 2;
        const me = c.e + ue * m, mn = c.n + un * m, mh = c.h + sp * m;
        if (top.call(this.host, me, mn, mh) > mh || mh < this.host.heightAt(me, mn) - terr) b = m; else a = m;
      }
      hitT = a;
      break;
    }
    if (hitT < 0) return 1;
    return Math.max(2, hitT - 1.5) / c.dist;
  }

  // ------------------------------------------------------------------------ input

  private cancelAuto() {
    this.flight?.resolve();
    this.flight = null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.cancelAuto();
    const rotate = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.altKey;
    const grab = rotate ? null : this.host.pickGround(e.clientX, e.clientY);
    if (!rotate) this.followFn = null;
    this.drag = { mode: rotate ? 'rotate' : 'pan', x: e.clientX, y: e.clientY, grab, id: e.pointerId };
    this.host.dom.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    if (d.mode === 'rotate') {
      this.goal.heading += dx * 0.005;
      this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.004, MIN_PITCH, MAX_PITCH);
      return;
    }
    if (!d.grab) {
      // no ground under cursor at press time: pan in screen space
      const s = this.cur.dist * 0.0018;
      const sh = Math.sin(this.goal.heading), ch = Math.cos(this.goal.heading);
      const de = -dx * s * ch + dy * s * sh / Math.max(0.3, Math.sin(this.cur.pitch));
      const dn = dx * s * sh + dy * s * ch / Math.max(0.3, Math.sin(this.cur.pitch));
      this.goal.e += de; this.goal.n += dn; this.cur.e += de; this.cur.n += dn;
      return;
    }
    // keep the grabbed ground point under the cursor: intersect plane y = grab.h
    this.apply();
    const hit = this.rayPlane(e.clientX, e.clientY, d.grab.h);
    if (!hit) return;
    let de = d.grab.e - hit.e, dn = d.grab.n - hit.n;
    const lim = this.cur.dist * 4;
    const m = Math.hypot(de, dn);
    if (m > lim) { de *= lim / m; dn *= lim / m; }
    this.goal.e += de; this.goal.n += dn;
    this.cur.e += de; this.cur.n += dn;
    this.apply();
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.id) {
      this.host.dom.releasePointerCapture?.(e.pointerId);
      this.drag = null;
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.cancelAuto();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    if (e.deltaMode === 2) dy *= 400;
    dy = THREE.MathUtils.clamp(dy, -300, 300);
    const f = Math.exp(dy * 0.0016);
    const g = this.goal;
    const nd = THREE.MathUtils.clamp(g.dist * f, MIN_DIST, MAX_DIST);
    const ef = nd / g.dist;
    const p = this.host.pickGround(e.clientX, e.clientY);
    if (p && !this.followFn) {
      // move the focus toward the cursor point so it stays under the cursor
      const maxMove = g.dist * 3;
      let me = (p.e - g.e) * (1 - ef), mn = (p.n - g.n) * (1 - ef);
      const m = Math.hypot(me, mn);
      if (m > maxMove) { me *= maxMove / m; mn *= maxMove / m; }
      g.e += me; g.n += mn;
    }
    g.dist = nd;
    // tilt toward the horizon when getting close to the ground, like map apps
    if (dy < 0 && nd < 250) g.pitch = Math.max(MIN_PITCH + 0.1, g.pitch - (1 - ef) * 0.35);
  };

  private onDbl = (e: MouseEvent) => {
    const p = this.host.pickGround(e.clientX, e.clientY);
    if (p) this.flyTo({ e: p.e, n: p.n, h: p.h, dist: Math.max(MIN_DIST, this.goal.dist * 0.4) }, 1.0);
  };

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private keyboard(dt: number) {
    if (this.keys.size === 0) return;
    const k = this.keys;
    const g = this.goal;
    const speed = Math.max(g.dist, 30) * 0.9 * (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1);
    let fwd = 0, right = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) right += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) right -= 1;
    if (fwd || right) {
      this.cancelAuto();
      this.followFn = null;
      const sh = Math.sin(g.heading), ch = Math.cos(g.heading);
      g.e += (sh * fwd + ch * right) * speed * dt;
      g.n += (ch * fwd - sh * right) * speed * dt;
    }
    if (k.has('KeyQ')) g.heading -= 1.2 * dt;
    if (k.has('KeyE')) g.heading += 1.2 * dt;
    if (k.has('KeyR')) g.pitch += 0.8 * dt;
    if (k.has('KeyF')) g.pitch -= 0.8 * dt;
    if (k.has('Equal') || k.has('NumpadAdd') || k.has('KeyZ')) g.dist *= Math.exp(-1.6 * dt);
    if (k.has('Minus') || k.has('NumpadSubtract') || k.has('KeyX')) g.dist *= Math.exp(1.6 * dt);
  }

  private rayPlane(cx: number, cy: number, h: number): GroundHit | null {
    const r = this.host.dom.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.host.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (Math.abs(d.y) < 1e-6) return null;
    const t = (h - o.y) / d.y;
    if (t <= 0) return null;
    return { e: o.x + d.x * t, n: -(o.z + d.z * t), h };
  }
}
