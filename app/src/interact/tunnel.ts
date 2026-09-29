// Local tunnel / station / track geometry around a player-attached vehicle.
// Only a window of the pattern path near the vehicle is built (rebuilt as it
// moves). Tunnel tube where the track is well below the terrain, an
// underground station box + platform + lit strips + name signs at stops, rails
// everywhere (so the cab view has track ahead even above ground).
import * as THREE from 'three/webgpu';
import { attribute, float, length, positionView, smoothstep, vec4 } from 'three/tsl';
import type { Mode } from '../transit';
import type { PatternPath } from './path';

type P2 = [number, number];

interface Strip {
  /** tunnel and station variants (same point count) */
  tunnel: P2[];
  station: P2[];
  /** colour per segment [tunnel, station] */
  colors: [number, number][];
  /** only emit where underground */
  under: boolean;
  /** baked light pools apply */
  lit?: boolean;
}

function strips(double: boolean): Strip[] {
  const L = double ? -6.4 : -2.5, R = 2.3, H = 4.6;
  return [
    {
      // walls, ceiling, platform, floor (closed ring)
      tunnel: [[L, -0.4], [L, H], [R, H], [R, -0.4], [R, -0.4], [R, -0.4], [R, -0.4], [L, -0.4]],
      station: [[-8, -0.4], [-8, 5.8], [6.8, 5.8], [6.8, 0.95], [2.25, 0.95], [1.62, 0.95], [1.62, -0.4], [-8, -0.4]],
      colors: [[0x6a6863, 0], [0x4a4a48, 0x5b5f66], [0x6a6863, 0], [0x4a4a48, 0x8e8e8a], [0x4a4a48, 0xf2c200], [0x4a4a48, 0x2e2e2e], [0x2a2826, 0x1c1c1c]],
      under: true, lit: true,
    },
    // ceiling light strip (station) / cable tray (tunnel)
    { tunnel: [[R - 0.3, 3.9], [R - 0.05, 3.9]], station: [[2.6, 5.75], [5.4, 5.75]], colors: [[0x202020, 0xfff6e0]], under: true },
    { tunnel: [[L + 0.05, 3.9], [L + 0.3, 3.9]], station: [[-5.4, 5.75], [-2.6, 5.75]], colors: [[0x202020, 0xfff6e0]], under: true },
    // platform-edge light line under the lip (glows at night-like underground)
    { tunnel: [[R, -0.3], [R, -0.3]], station: [[1.63, 0.9], [1.63, 0.75]], colors: [[0x000000, 0xffe9a8]], under: true },
    // our rails
    ...rail(-0.72), ...rail(0.72),
    // other track (left)
    ...(double ? [...rail(-4.4 - 0.72, true), ...rail(-4.4 + 0.72, true)] : []),
  ];
}

function rail(x: number, under = false): Strip[] {
  const w = 0.04, h = 0.16;
  return [{ tunnel: [[x - w, 0], [x - w, h], [x + w, h], [x + w, 0]], station: [[x - w, 0], [x - w, h], [x + w, h], [x + w, 0]], colors: [[0x6d6a66, 0x6d6a66], [0xc9c6c0, 0xc9c6c0], [0x6d6a66, 0x6d6a66]], under }];
}

const STEP = 4;
const BACK = 220;
const AHEAD = 650;
const REBUILD = 90;

export interface TunnelInfo {
  inTunnel: boolean;
}

export class TunnelBuilder {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lights: THREE.InstancedMesh | null = null;
  private signs: THREE.Object3D[] = [];
  private path: PatternPath | null = null;
  private center = -1e9;
  private material: THREE.MeshBasicNodeMaterial;
  private lightMat: THREE.MeshBasicNodeMaterial;
  private signCache = new Map<string, THREE.CanvasTexture>();
  private heightAt: (e: number, n: number) => number;
  private mode: Mode = 'subway';
  private stopLen = 150;
  private vehLen = 138;
  /** per-sample underground flag of the current window (for tunnel queries) */
  private underS0 = 0;
  private under = new Uint8Array(0);

  constructor(heightAt: (e: number, n: number) => number) {
    this.heightAt = heightAt;
    this.group.name = 'interact-tunnel';
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const col = attribute('color', 'vec3');
    // fade to black with distance — tunnels are dark
    const fade = float(1).sub(smoothstep(float(30), float(520), length(positionView))).mul(0.97).add(0.03);
    m.colorNode = vec4(col.mul(fade), 1);
    this.material = m;
    const lm = new THREE.MeshBasicNodeMaterial();
    lm.colorNode = vec4(float(2.2), float(2.05), float(1.7), 1);
    this.lightMat = lm;
  }

  setPath(path: PatternPath | null, mode: Mode, vehLen: number) {
    if (path !== this.path) this.center = -1e9;
    this.path = path;
    this.mode = mode;
    this.vehLen = vehLen;
    this.stopLen = mode === 'subway' ? 152 : mode === 'lrt' ? 90 : mode === 'commuter_rail' ? 320 : vehLen + 20;
    if (!path) this.clear();
  }

  /** true if the track at s is underground (per current window) */
  isUnder(s: number): boolean {
    const k = Math.round((s - this.underS0) / STEP);
    return k >= 0 && k < this.under.length ? this.under[k] === 1 : false;
  }

  update(s: number) {
    if (!this.path) return;
    if (Math.abs(s - this.center) < REBUILD) return;
    this.center = s;
    this.build(s);
  }

  clear() {
    this.mesh?.geometry.dispose();
    this.mesh?.removeFromParent();
    this.mesh = null;
    this.lights?.dispose();
    this.lights?.removeFromParent();
    this.lights = null;
    for (const o of this.signs) {
      o.removeFromParent();
      const mm = o as THREE.Mesh;
      mm.geometry?.dispose();
      (mm.material as THREE.Material)?.dispose();
    }
    this.signs = [];
    this.center = -1e9;
  }

  private build(sc: number) {
    const path = this.path!;
    this.clear();
    this.center = sc;
    const s0 = Math.max(0, sc - BACK), s1 = Math.min(path.length, sc + AHEAD);
    const n = Math.max(2, Math.floor((s1 - s0) / STEP) + 1);
    const origin = path.point(sc, [0, 0, 0]);
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const isRail = this.mode !== 'bus';
    const underground = this.mode === 'subway' || this.mode === 'lrt' || this.mode === 'airport_rail' || this.mode === 'commuter_rail' || this.mode === 'intercity_rail' || this.mode === 'streetcar';
    const S = strips(this.mode === 'subway');

    // samples
    const pe = new Float64Array(n), pn = new Float64Array(n), pz = new Float64Array(n);
    const rx = new Float64Array(n), ry = new Float64Array(n);
    const under = new Uint8Array(n);
    const stn = new Float32Array(n); // station blend 0..1
    const light = new Float32Array(n);
    const p = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
    const realStops = path.stops.filter((q) => !q.virtual);
    for (let k = 0; k < n; k++) {
      const s = s0 + k * STEP;
      path.point(s, p); path.point(s - 3, a); path.point(s + 3, b);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const hl = Math.hypot(dx, dy) || 1;
      rx[k] = dy / hl; ry[k] = -dx / hl;
      pe[k] = p[0]; pn[k] = p[1];
      const g = this.heightAt(p[0], p[1]);
      const u = underground && g - p[2] > 4.5;
      under[k] = u ? 1 : 0;
      // rails at grade follow the terrain (tile surface) to avoid floating
      pz[k] = !u && Math.abs(p[2] - g) < 2.5 ? g + 0.08 : p[2];
      let bl = 0;
      for (const st of realStops) {
        const d = Math.abs(s - st.dist);
        const half = this.stopLen / 2;
        if (d < half + 12) bl = Math.max(bl, d < half ? 1 : 1 - (d - half) / 12);
      }
      stn[k] = u ? bl : 0;
      const m = ((s % 25) + 25) % 25;
      light[k] = 0.5 + 0.9 * Math.exp(-((m - 12.5) * (m - 12.5)) / 30);
    }
    // morphological cleanup: fill 1-2 sample holes in the underground flag
    for (let k = 1; k < n - 2; k++) if (!under[k] && under[k - 1] && (under[k + 1] || under[k + 2])) under[k] = 1;
    this.under = under;
    this.underS0 = s0;

    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const c0 = new THREE.Color(), c1 = new THREE.Color();
    const stationWall = stationColor(realStops, sc);
    for (const st of S) {
      if (st.under && !underground) continue;
      if (!isRail && !st.under) continue;
      const np = st.tunnel.length;
      for (let sgi = 0; sgi < np - 1; sgi++) {
        let prevOk = false;
        let base = 0;
        for (let k = 0; k < n; k++) {
          const ok = st.under ? under[k] === 1 : true;
          if (!ok) { prevOk = false; continue; }
          const w = stn[k];
          const [ct, cs] = st.colors[sgi];
          c0.setHex(ct);
          c1.setHex(cs === 0 ? stationWall : cs);
          c0.lerp(c1, w);
          const lf = st.lit ? light[k] * (1 - w) + 1.25 * w : 1;
          const vi = pos.length / 3;
          for (const q of [sgi, sgi + 1]) {
            const x = st.tunnel[q][0] * (1 - w) + st.station[q][0] * w;
            const y = st.tunnel[q][1] * (1 - w) + st.station[q][1] * w;
            const e = pe[k] + rx[k] * x, nn = pn[k] + ry[k] * x;
            pos.push(e - ox, pz[k] + y - oz, -(nn - oy));
            col.push(c0.r * lf, c0.g * lf, c0.b * lf);
          }
          if (prevOk) idx.push(base, base + 1, vi, base + 1, vi + 1, vi);
          base = vi;
          prevOk = true;
        }
      }
    }
    // end caps where the window ends underground
    for (const k of [0, n - 1]) {
      if (!under[k] || !underground) continue;
      const ring = S[0].tunnel;
      const vi = pos.length / 3;
      for (const [x, y] of ring) {
        pos.push(pe[k] + rx[k] * x * 1.4 - ox, pz[k] + y * 1.4 - oz, -(pn[k] + ry[k] * x * 1.4 - oy));
        col.push(0, 0, 0);
      }
      for (let q = 1; q < ring.length - 1; q++) idx.push(vi, vi + q, vi + q + 1);
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.position.set(ox, oz, -oy);
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.mesh = mesh;
    }

    // tunnel light fixtures every 25 m on the right wall (not in stations)
    if (underground) {
      const mats: THREE.Matrix4[] = [];
      const first = Math.ceil(s0 / 25) * 25;
      for (let s = first + 12.5; s < s1; s += 25) {
        const k = Math.round((s - s0) / STEP);
        if (k < 0 || k >= n || !under[k] || stn[k] > 0.2) continue;
        path.point(s, p);
        const x = 2.15;
        const e = p[0] + rx[k] * x, nn = p[1] + ry[k] * x;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(e - ox, pz[k] + 3.4 - oz, -(nn - oy)),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(ry[k], rx[k])),
          new THREE.Vector3(0.12, 0.12, 1.2),
        );
        mats.push(m);
        // matching fixture on the far wall
        const xl = this.mode === 'subway' ? -6.25 : -2.35;
        const m2 = m.clone();
        m2.setPosition(p[0] + rx[k] * xl - ox, pz[k] + 3.4 - oz, -(p[1] + ry[k] * xl - oy));
        mats.push(m2);
      }
      if (mats.length) {
        const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.lightMat, mats.length);
        mats.forEach((m, i) => im.setMatrixAt(i, m));
        im.position.set(ox, oz, -oy);
        im.frustumCulled = false;
        this.group.add(im);
        this.lights = im;
      }
    }

    // station name signs + stopping markers
    for (const st of realStops) {
      if (st.dist < s0 - 100 || st.dist > s1 + 100) continue;
      const k = Math.round((st.dist - s0) / STEP);
      const inStation = k >= 0 && k < n && stn[k] > 0.5;
      if (inStation) {
        for (let d = -this.stopLen / 2 + 15; d <= this.stopLen / 2 - 10; d += 35) {
          this.addSign(path, st.dist + d, 6.75, 2.9, st.name, -1);
          this.addSign(path, st.dist + d + 17, -7.95, 3.1, st.name, 1);
        }
      }
      if (isRail) {
        // stopping marker: where the front of the train stops
        const sm = st.dist + this.vehLen / 2;
        this.addMarker(path, sm, inStation ? 1.95 : 2.2, under[Math.max(0, Math.min(n - 1, Math.round((sm - s0) / STEP)))] === 1);
      }
    }
  }

  private addSign(path: PatternPath, s: number, x: number, y: number, name: string, facing: 1 | -1) {
    const pose = path.pose(s, 3);
    const g = this.heightAt(pose.e, pose.n);
    if (!(g - pose.z > 4.5)) return;
    const tex = this.signTexture(name);
    const m = new THREE.MeshBasicNodeMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.7), m);
    const rxv = Math.sin(pose.heading), ryv = -Math.cos(pose.heading);
    mesh.position.set(pose.e + rxv * x, pose.z + y, -(pose.n + ryv * x));
    // plane normal (+z local) should face the track: rotate about y
    mesh.rotation.y = pose.heading + (facing === -1 ? Math.PI : 0);
    this.group.add(mesh);
    this.signs.push(mesh);
  }

  private addMarker(path: PatternPath, s: number, x: number, under: boolean) {
    const pose = path.pose(s, 3);
    const tex = this.signTexture('▼STOP', true);
    const m = new THREE.MeshBasicNodeMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), m);
    const rxv = Math.sin(pose.heading), ryv = -Math.cos(pose.heading);
    const g = this.heightAt(pose.e, pose.n);
    const z = under || Math.abs(pose.z - g) > 2.5 ? pose.z : g;
    mesh.position.set(pose.e + rxv * x, z + 2.4, -(pose.n + ryv * x));
    mesh.rotation.y = pose.heading - Math.PI / 2;
    this.group.add(mesh);
    this.signs.push(mesh);
    // post
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.0, 0.08), new THREE.MeshBasicNodeMaterial({ color: 0x777777 }));
    post.position.set(pose.e + rxv * x, z + 0.95, -(pose.n + ryv * x));
    this.group.add(post);
    this.signs.push(post);
  }

  private signTexture(text: string, marker = false): THREE.CanvasTexture {
    const key = (marker ? 'm:' : 's:') + text;
    let t = this.signCache.get(key);
    if (t) return t;
    const cv = document.createElement('canvas');
    if (marker) {
      cv.width = 128; cv.height = 128;
      const c = cv.getContext('2d')!;
      c.fillStyle = '#ffd400'; c.fillRect(0, 0, 128, 128);
      c.fillStyle = '#111'; c.fillRect(10, 10, 108, 108);
      c.fillStyle = '#ffd400'; c.font = 'bold 44px Overpass, Helvetica, sans-serif'; c.textAlign = 'center';
      c.fillText('STOP', 64, 80);
    } else {
      cv.width = 768; cv.height = 128;
      const c = cv.getContext('2d')!;
      c.fillStyle = '#f5f3ee'; c.fillRect(0, 0, 768, 128);
      c.fillStyle = '#111'; c.fillRect(0, 108, 768, 20);
      c.fillStyle = '#111';
      c.font = '800 70px Overpass, Helvetica, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      const label = text.split(' - ')[0].replace(/ Station$/i, '').toUpperCase();
      c.fillText(label, 384, 58, 740);
    }
    t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.signCache.set(key, t);
    return t;
  }

  dispose() {
    this.clear();
    this.material.dispose();
    this.lightMat.dispose();
    for (const t of this.signCache.values()) t.dispose();
    this.group.removeFromParent();
  }
}

/** Per-station wall tile colour (TTC stations each have their own). */
function stationColor(stops: { name: string; dist: number }[], s: number): number {
  let best = stops[0];
  for (const st of stops) if (Math.abs(st.dist - s) < Math.abs((best?.dist ?? 1e9) - s)) best = st;
  const pal = [0x3c8d9e, 0xc7a64a, 0x8a4f7d, 0x4f7d52, 0xb8664a, 0x5a6fa8, 0xa89b86, 0x6e9e8c, 0xd0c48a, 0x7a8c9e];
  let h = 0;
  for (const ch of best?.name ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
}
