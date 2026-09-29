// Rail station platforms (subway, LRT, GO, UP, VIA) built along the actual
// track at each station, plus DOM station labels with mode badges.
//
// Data: station list from transit index.json, track geometry from the loaded
// rail patterns (TransitSystem.routeLines). Per station the nearest track of
// the station's mode is the reference line; every parallel track within
// ~60 m gives a lateral offset. Platforms are laid out from those offsets
// (island in gaps ≥ 8.5 m, side platforms on the outside otherwise) and follow
// the reference line's curvature and elevation (so subway platforms sit in
// the tunnel, hidden by terrain unless the camera is underground).
//
// Streaming: stations within STREAM_RADIUS of the camera focus are merged into
// ONE mesh (one material, vertex colours) → 1 draw call (+ shadow pass).
// Rebuilt when the focus moves > REBUILD_DIST or the floating anchor rebases.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { MeshBuilder, rgb, type RGB } from '../models/builder';
import { useApp } from '../state/store';
import type { Mode, StationMeta, TransitSystem } from '../transit';

const STREAM_RADIUS = 5000;
const REBUILD_DIST = 600;
const LABEL_MAX_DIST = 4500;
const LABEL_MAX_ALT = 6000;

type RailMode = Exclude<Mode, 'bus' | 'streetcar'>;
const RAIL_MODES: RailMode[] = ['subway', 'lrt', 'commuter_rail', 'airport_rail', 'intercity_rail'];
const HEAVY = new Set<Mode>(['commuter_rail', 'airport_rail', 'intercity_rail']);

interface PlatformSpec {
  length: number;
  /** platform top above rail (m) */
  height: number;
  /** track centre → platform edge */
  edge: number;
  /** side-platform width */
  width: number;
  canopy: number; // canopy length (0 = none)
  shelter: boolean;
  search: number; // max station→track distance
}

const SPEC: Record<RailMode, PlatformSpec> = {
  subway: { length: 152, height: 1.05, edge: 1.6, width: 4.5, canopy: 0, shelter: false, search: 120 },
  lrt: { length: 90, height: 0.35, edge: 1.4, width: 3.5, canopy: 0, shelter: true, search: 120 },
  commuter_rail: { length: 310, height: 0.8, edge: 1.75, width: 6, canopy: 130, shelter: false, search: 220 },
  airport_rail: { length: 95, height: 1.0, edge: 1.7, width: 6, canopy: 80, shelter: false, search: 220 },
  intercity_rail: { length: 240, height: 0.8, edge: 1.75, width: 5, canopy: 60, shelter: false, search: 220 },
};

const COL = {
  concrete: rgb(0xb9b6ae),
  concreteSide: rgb(0x8e8b84),
  tactile: rgb(0xf2c500),
  roof: rgb(0xd9dcdf),
  roofUnder: rgb(0x8b9096),
  post: rgb(0x5a6068),
  glass: rgb(0x9fc3d6),
  go: rgb(0x3e8a36),
  up: rgb(0xf58220),
  via: rgb(0xf5c400),
  sign: rgb(0x1f2a36),
};

// ---------------------------------------------------------------- track index
interface Poly { xyz: Float32Array; cum: Float64Array; mode: RailMode }

class TrackIndex {
  polys: Poly[] = [];
  private grid = new Map<string, number[]>(); // cell → packed (poly << 16 | seg) refs
  private cell = 200;

  add(mode: RailMode, xyz: Float32Array) {
    const n = xyz.length / 3;
    if (n < 2) return;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xyz[3 * i] - xyz[3 * i - 3], xyz[3 * i + 1] - xyz[3 * i - 2]);
    const pi = this.polys.length;
    this.polys.push({ xyz, cum, mode });
    for (let i = 0; i < n - 1; i++) {
      const x0 = xyz[3 * i], y0 = xyz[3 * i + 1], x1 = xyz[3 * i + 3], y1 = xyz[3 * i + 4];
      const cx0 = Math.floor(Math.min(x0, x1) / this.cell), cx1 = Math.floor(Math.max(x0, x1) / this.cell);
      const cy0 = Math.floor(Math.min(y0, y1) / this.cell), cy1 = Math.floor(Math.max(y0, y1) / this.cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const k = `${cx},${cy}`;
        let a = this.grid.get(k);
        if (!a) this.grid.set(k, (a = []));
        a.push(pi, i);
      }
    }
  }

  /** nearest point on each polyline (of `modes`) within r of (e, n) */
  near(e: number, n: number, r: number, modes: Set<Mode>): { poly: number; seg: number; t: number; d: number; x: number; y: number }[] {
    const best = new Map<number, { poly: number; seg: number; t: number; d: number; x: number; y: number }>();
    const c0x = Math.floor((e - r) / this.cell), c1x = Math.floor((e + r) / this.cell);
    const c0y = Math.floor((n - r) / this.cell), c1y = Math.floor((n + r) / this.cell);
    for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) {
      const a = this.grid.get(`${cx},${cy}`);
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) {
        const pi = a[k], si = a[k + 1];
        const p = this.polys[pi];
        if (!modes.has(p.mode)) continue;
        const x0 = p.xyz[3 * si], y0 = p.xyz[3 * si + 1], x1 = p.xyz[3 * si + 3], y1 = p.xyz[3 * si + 4];
        const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((e - x0) * dx + (n - y0) * dy) / L2)) : 0;
        const x = x0 + dx * t, y = y0 + dy * t;
        const d = Math.hypot(e - x, n - y);
        if (d > r) continue;
        const cur = best.get(pi);
        if (!cur || d < cur.d) best.set(pi, { poly: pi, seg: si, t, d, x, y });
      }
    }
    return [...best.values()].sort((a, b) => a.d - b.d);
  }

  /** point (E, N, z) and unit tangent at arc length s along poly */
  at(pi: number, s: number): { e: number; n: number; z: number; tx: number; ty: number } {
    const p = this.polys[pi];
    const n = p.cum.length;
    s = Math.max(0, Math.min(p.cum[n - 1], s));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (p.cum[m] <= s) lo = m; else hi = m;
    }
    const L = p.cum[hi] - p.cum[lo] || 1;
    const t = (s - p.cum[lo]) / L;
    const a = 3 * lo, b = 3 * hi;
    const tx = (p.xyz[b] - p.xyz[a]) / L, ty = (p.xyz[b + 1] - p.xyz[a + 1]) / L;
    return { e: p.xyz[a] + (p.xyz[b] - p.xyz[a]) * t, n: p.xyz[a + 1] + (p.xyz[b + 1] - p.xyz[a + 1]) * t, z: p.xyz[a + 2] + (p.xyz[b + 2] - p.xyz[a + 2]) * t, tx, ty };
  }

  arc(pi: number, seg: number, t: number): number {
    const p = this.polys[pi];
    return p.cum[seg] + (p.cum[seg + 1] - p.cum[seg]) * t;
  }
}

// ---------------------------------------------------------------- stations
interface BuiltStation {
  key: string;
  e: number; n: number; // reference (local origin of the geometry)
  pos: Float32Array; nrm: Float32Array; col: Float32Array; idx: Uint32Array;
}

interface LabelGroup {
  name: string;
  e: number; n: number;
  h: number;
  el: HTMLDivElement;
  badges: string;
  attached: boolean;
}

function cleanName(s: string): string {
  return s
    .replace(/^UP Express\s+/i, '')
    .replace(/\s*-\s*Subway$/i, '')
    .replace(/\s+(GO|UP Express|UP)(\s+Station)?$/i, '')
    .replace(/\s+(Station|Stn)$/i, '')
    .replace(/\s+(GO|UP Express)$/i, '')
    .replace(/\s+LRT$/i, '')
    .trim();
}

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const st = document.createElement('style');
  st.textContent = `
.stations-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.stn-label { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 4px; white-space: nowrap;
  font: 700 11px var(--ui, system-ui, sans-serif); color: #1d232b; background: rgba(255,255,255,0.88); border-radius: 4px;
  padding: 2px 6px 2px 3px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); will-change: transform; transition: opacity 0.25s; }
.stn-label::after { content: ''; position: absolute; left: 50%; bottom: -5px; margin-left: -4px; border: 4px solid transparent;
  border-bottom: 0; border-top-color: rgba(255,255,255,0.88); }
.stn-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 3px;
  border-radius: 8px; font: 800 10px/1 var(--ui, system-ui, sans-serif); box-sizing: border-box; }
.stn-badge.sq { border-radius: 3px; }
`;
  document.head.appendChild(st);
}

export class StationsLayer implements Layer {
  readonly id = 'stations';
  private engine!: Engine;
  private system: TransitSystem;
  private tracks: TrackIndex | null = null;
  private stations: StationMeta[] = [];
  private built = new Map<string, BuiltStation | null>();
  private groups: LabelGroup[] = [];
  private mesh: THREE.Mesh;
  private material: THREE.MeshStandardMaterial;
  private dataSig = '';
  private buildCentre = new THREE.Vector2(Infinity, Infinity);
  private anchorVersion = -1;
  private root = document.createElement('div');
  private v = new THREE.Vector3();
  /** stats for debugging: stations in the current batch, triangles */
  stats = { stations: 0, tris: 0, labels: 0 };

  constructor(system: TransitSystem) {
    this.system = system;
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
    this.material.name = 'stations';
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'stations';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  init(engine: Engine) {
    this.engine = engine;
    injectCss();
    this.root.className = 'stations-layer';
    engine.renderer.domElement.parentElement?.appendChild(this.root);
    engine.scene.add(this.mesh);
  }

  private railSignature(): string {
    return this.system.feedsInfo().filter((f) => f.kind === 'rail').map((f) => `${f.agency}:${f.profile}`).join(',');
  }

  /** (Re)build the track index + label groups when the loaded rail feeds change. */
  private prepare() {
    const idx = this.system.index;
    if (!idx) return;
    const t = new TrackIndex();
    for (const m of RAIL_MODES) {
      for (const rl of this.system.routeLines({ modes: [m] })) for (const l of rl.lines) t.add(m, l);
    }
    this.tracks = t;
    this.stations = idx.stations.filter((s) => s.modes.some((m) => (RAIL_MODES as Mode[]).includes(m)));
    this.built.clear();
    this.buildLabels();
    this.buildCentre.set(Infinity, Infinity);
  }

  // ---------------------------------------------------------------- labels
  private buildLabels() {
    for (const g of this.groups) g.el.remove();
    this.groups = [];
    const routes = new Map(this.system.routes.map((r) => [r.id, r]));
    const clusters: { st: StationMeta[]; e: number; n: number }[] = [];
    for (const s of this.stations) {
      const c = clusters.find((c) => Math.hypot(c.e - s.pos[0], c.n - s.pos[1]) < 380);
      if (c) c.st.push(s);
      else clusters.push({ st: [s], e: s.pos[0], n: s.pos[1] });
    }
    for (const c of clusters) {
      const names = c.st.map((s) => cleanName(s.name));
      names.sort((a, b) => a.length - b.length);
      const name = names[0];
      const badges: string[] = [];
      const seen = new Set<string>();
      const add = (key: string, html: string) => { if (!seen.has(key)) { seen.add(key); badges.push(html); } };
      // order: subway lines, LRT, GO, UP, VIA
      const order: Mode[] = ['subway', 'lrt', 'commuter_rail', 'airport_rail', 'intercity_rail'];
      for (const m of order) {
        for (const s of c.st) {
          if (!s.modes.includes(m)) continue;
          if (m === 'subway' || m === 'lrt') {
            for (const rid of s.routes) {
              const r = routes.get(rid);
              if (!r || r.mode !== m) continue;
              add(rid, `<span class="stn-badge" style="background:${r.color};color:${r.textColor}">${r.short}</span>`);
            }
          } else if (m === 'commuter_rail') add('go', `<span class="stn-badge sq" style="background:#3e8a36;color:#fff">GO</span>`);
          else if (m === 'airport_rail') add('up', `<span class="stn-badge sq" style="background:#f58220;color:#fff">UP</span>`);
          else add('via', `<span class="stn-badge sq" style="background:#f5c400;color:#1a2a55">VIA</span>`);
        }
      }
      const el = document.createElement('div');
      el.className = 'stn-label';
      el.innerHTML = `${badges.join('')}<span>${escapeHtml(name)}</span>`;
      el.style.opacity = '0';
      this.groups.push({ name, e: c.e, n: c.n, h: NaN, el, badges: badges.join(''), attached: false });
    }
  }

  // ---------------------------------------------------------------- geometry
  private buildStation(s: StationMeta, m: RailMode, placed: { e: number; n: number; m: RailMode }[]): BuiltStation | null {
    const tr = this.tracks!;
    const spec = SPEC[m];
    const [se, sn] = s.pos;
    const heavy = HEAVY.has(m);
    const modeSet = new Set<Mode>(heavy ? ['commuter_rail', 'airport_rail', 'intercity_rail'] : [m]);
    const own = tr.near(se, sn, spec.search, new Set<Mode>([m]));
    if (!own.length) return null;
    const ref = own[0];
    // dedupe (e.g. "Kennedy Station" + "Kennedy Station - Subway", VIA at a GO station)
    const dup = placed.some((p) => Math.hypot(p.e - ref.x, p.n - ref.y) < (heavy ? 150 : 80) && (p.m === m || (heavy && HEAVY.has(p.m))));
    if (dup) return null;
    placed.push({ e: ref.x, n: ref.y, m });
    const sRef = tr.arc(ref.poly, ref.seg, ref.t);
    const c = tr.at(ref.poly, sRef);
    const nx = -c.ty, ny = c.tx; // left normal
    // lateral offsets of all parallel tracks near the reference point
    const offs: number[] = [0];
    for (const h of tr.near(ref.x, ref.y, heavy ? 70 : 30, modeSet)) {
      if (h.poly === ref.poly) continue;
      const q = tr.at(h.poly, tr.arc(h.poly, h.seg, h.t));
      if (Math.abs(q.tx * c.tx + q.ty * c.ty) < 0.94) continue;
      offs.push((h.x - ref.x) * nx + (h.y - ref.y) * ny);
    }
    offs.sort((a, b) => a - b);
    const tracks: number[] = [];
    for (const o of offs) if (!tracks.length || o - tracks[tracks.length - 1] > 1.4) tracks.push(o);
    // platform lateral extents [a, b] and which sides face a track
    const plats: { a: number; b: number; trackA: boolean; trackB: boolean }[] = [];
    const E = spec.edge;
    const stationSide = (se - ref.x) * nx + (sn - ref.y) * ny >= 0 ? 1 : -1;
    if (tracks.length === 1) {
      const t0 = tracks[0];
      if (m === 'subway') {
        plats.push({ a: t0 - E - spec.width, b: t0 - E, trackA: false, trackB: true });
        plats.push({ a: t0 + E, b: t0 + E + spec.width, trackA: true, trackB: false });
      } else if (stationSide > 0) plats.push({ a: t0 + E, b: t0 + E + spec.width, trackA: true, trackB: false });
      else plats.push({ a: t0 - E - spec.width, b: t0 - E, trackA: false, trackB: true });
    } else {
      let islands = 0;
      for (let i = 0; i < tracks.length - 1; i++) {
        const gap = tracks[i + 1] - tracks[i];
        if (gap >= 8.5) {
          plats.push({ a: tracks[i] + E, b: tracks[i + 1] - E, trackA: true, trackB: true });
          islands++;
        }
      }
      if (islands === 0 && tracks.length <= 4) {
        plats.push({ a: tracks[0] - E - spec.width, b: tracks[0] - E, trackA: false, trackB: true });
        plats.push({ a: tracks[tracks.length - 1] + E, b: tracks[tracks.length - 1] + E + spec.width, trackA: true, trackB: false });
      } else if (islands === 0) {
        const t0 = stationSide > 0 ? tracks[tracks.length - 1] : tracks[0];
        plats.push(stationSide > 0
          ? { a: t0 + E, b: t0 + E + spec.width, trackA: true, trackB: false }
          : { a: t0 - E - spec.width, b: t0 - E, trackA: false, trackB: true });
      }
    }
    // sample the reference line
    const L = spec.length;
    const poly = tr.polys[ref.poly];
    const total = poly.cum[poly.cum.length - 1];
    let s0 = sRef - L / 2, s1 = sRef + L / 2;
    if (s0 < 0) { s1 = Math.min(total, s1 - s0); s0 = 0; }
    if (s1 > total) { s0 = Math.max(0, s0 - (s1 - total)); s1 = total; }
    const nSeg = Math.max(2, Math.ceil((s1 - s0) / 12));
    const samples: { e: number; n: number; z: number; nx: number; ny: number; s: number }[] = [];
    for (let i = 0; i <= nSeg; i++) {
      const s = s0 + ((s1 - s0) * i) / nSeg;
      const p = tr.at(ref.poly, s);
      // smooth tangent over ±6 m
      const pa = tr.at(ref.poly, s - 6), pb = tr.at(ref.poly, s + 6);
      let tx = pb.e - pa.e, ty = pb.n - pa.n;
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      samples.push({ e: p.e, n: p.n, z: p.z, nx: -ty, ny: tx, s });
    }
    const oe = ref.x, on = ref.y;
    const b = new MeshBuilder();
    const P = (i: number, lat: number, dy: number) => {
      const q = samples[i];
      return new THREE.Vector3(q.e + q.nx * lat - oe, q.z + dy, -(q.n + q.ny * lat - on));
    };
    const up = new THREE.Vector3(0, 1, 0);
    const H = spec.height;
    for (const pl of plats) {
      const midLat = (pl.a + pl.b) / 2;
      for (let i = 0; i < samples.length - 1; i++) {
        // top surface (tactile strips along track edges)
        const ta = pl.trackA ? pl.a + 0.6 : pl.a, tb = pl.trackB ? pl.b - 0.6 : pl.b;
        b.quad(P(i, ta, H), P(i + 1, ta, H), P(i + 1, tb, H), P(i, tb, H), COL.concrete, 0, up);
        if (pl.trackA) b.quad(P(i, pl.a, H), P(i + 1, pl.a, H), P(i + 1, ta, H), P(i, ta, H), COL.tactile, 0, up);
        if (pl.trackB) b.quad(P(i, tb, H), P(i + 1, tb, H), P(i + 1, pl.b, H), P(i, pl.b, H), COL.tactile, 0, up);
        // side faces
        const q = samples[i];
        const outA = new THREE.Vector3(-q.nx, 0, q.ny), outB = new THREE.Vector3(q.nx, 0, -q.ny);
        b.quad(P(i, pl.a, -0.3), P(i + 1, pl.a, -0.3), P(i + 1, pl.a, H), P(i, pl.a, H), COL.concreteSide, 0, outA);
        b.quad(P(i, pl.b, -0.3), P(i + 1, pl.b, -0.3), P(i + 1, pl.b, H), P(i, pl.b, H), COL.concreteSide, 0, outB);
      }
      // end caps
      const last = samples.length - 1;
      const t0 = samples[0], tl = samples[last];
      b.quad(P(0, pl.a, -0.3), P(0, pl.b, -0.3), P(0, pl.b, H), P(0, pl.a, H), COL.concreteSide, 0, new THREE.Vector3(-t0.ny, 0, -t0.nx));
      b.quad(P(last, pl.a, -0.3), P(last, pl.b, -0.3), P(last, pl.b, H), P(last, pl.a, H), COL.concreteSide, 0, new THREE.Vector3(tl.ny, 0, tl.nx));

      // canopy (GO / UP / VIA) over the middle of the platform
      const w = pl.b - pl.a;
      if (spec.canopy > 0 && w >= 3) {
        const ca = pl.a + 0.4, cb = pl.b - 0.4;
        const roofY = H + 3.6;
        let lastPost = -1e9;
        for (let i = 0; i < samples.length - 1; i++) {
          const sm = (samples[i].s + samples[i + 1].s) / 2;
          if (Math.abs(sm - sRef) > spec.canopy / 2) continue;
          b.quad(P(i, ca, roofY + 0.25), P(i + 1, ca, roofY + 0.25), P(i + 1, cb, roofY + 0.25), P(i, cb, roofY + 0.25), COL.roof, 0, up);
          b.quad(P(i, ca, roofY), P(i + 1, ca, roofY), P(i + 1, cb, roofY), P(i, cb, roofY), COL.roofUnder, 0, new THREE.Vector3(0, -1, 0));
          const q = samples[i];
          const fasc = m === 'commuter_rail' ? COL.go : m === 'airport_rail' ? COL.up : COL.via;
          b.quad(P(i, ca, roofY), P(i + 1, ca, roofY), P(i + 1, ca, roofY + 0.25), P(i, ca, roofY + 0.25), fasc, 0, new THREE.Vector3(-q.nx, 0, q.ny));
          b.quad(P(i, cb, roofY), P(i + 1, cb, roofY), P(i + 1, cb, roofY + 0.25), P(i, cb, roofY + 0.25), fasc, 0, new THREE.Vector3(q.nx, 0, -q.ny));
          if (samples[i].s - lastPost >= 11.5) {
            lastPost = samples[i].s;
            post(b, P(i, midLat, H), 0.3, roofY - H, COL.post);
          }
        }
      }
      // LRT shelter
      if (spec.shelter && w >= 2.5) {
        const i = Math.floor(samples.length / 2);
        const c0 = P(i, midLat, H);
        orientedBox(b, c0, samples[i], 8, Math.min(2.2, w - 0.8), H + 0.05, H + 2.7, COL.glass, true);
        orientedBox(b, c0, samples[i], 8.6, Math.min(2.8, w - 0.4), H + 2.7, H + 2.95, COL.roof, false);
      }
      // name sign on two posts at the reference point
      const im = samples.findIndex((q) => q.s >= sRef) >= 0 ? samples.findIndex((q) => q.s >= sRef) : samples.length >> 1;
      const sc = P(im, midLat, H);
      const sgCol: RGB = m === 'commuter_rail' ? COL.go : m === 'airport_rail' ? COL.up : m === 'intercity_rail' ? COL.via : COL.sign;
      orientedBox(b, sc, samples[im], 3.2, 0.14, H + 2.2, H + 2.9, sgCol, false);
      post(b, P(im, midLat, H).addScaledVector(dirOf(samples[im]), 1.3), 0.12, 2.2, COL.post);
      post(b, P(im, midLat, H).addScaledVector(dirOf(samples[im]), -1.3), 0.12, 2.2, COL.post);
    }
    if (!b.triCount) return null;
    return {
      key: `${s.id}|${m}`, e: oe, n: on,
      pos: new Float32Array(b.pos), nrm: new Float32Array(b.nrm), col: new Float32Array(b.col), idx: new Uint32Array(b.idx),
    };
  }

  private rebuild(ctx: FrameContext) {
    const fe = ctx.focus.x, fn = -ctx.focus.z;
    this.buildCentre.set(fe, fn);
    const anchor = ctx.anchor.origin;
    const parts: BuiltStation[] = [];
    // built lazily and cached; `placedAll` dedupes stations that share a track spot
    for (const s of this.stations) {
      if (Math.hypot(s.pos[0] - fe, s.pos[1] - fn) > STREAM_RADIUS + 400) continue;
      for (const m of RAIL_MODES) {
        if (!s.modes.includes(m)) continue;
        const key = `${s.id}|${m}`;
        let bs = this.built.get(key);
        if (bs === undefined) {
          bs = this.buildStation(s, m, this.placedAll);
          this.built.set(key, bs);
        }
        if (bs) parts.push(bs);
      }
    }
    let nV = 0, nI = 0;
    for (const p of parts) { nV += p.pos.length / 3; nI += p.idx.length; }
    const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), col = new Float32Array(nV * 3), idx = new Uint32Array(nI);
    let v = 0, k = 0;
    for (const p of parts) {
      const dx = p.e - anchor.x, dz = -p.n - anchor.z;
      const cnt = p.pos.length / 3;
      for (let i = 0; i < cnt; i++) {
        pos[3 * (v + i)] = p.pos[3 * i] + dx;
        pos[3 * (v + i) + 1] = p.pos[3 * i + 1];
        pos[3 * (v + i) + 2] = p.pos[3 * i + 2] + dz;
      }
      nrm.set(p.nrm, 3 * v);
      col.set(p.col, 3 * v);
      for (let i = 0; i < p.idx.length; i++) idx[k + i] = p.idx[i] + v;
      v += cnt; k += p.idx.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.mesh.position.copy(anchor);
    this.stats.stations = parts.length;
    this.stats.tris = nI / 3;
  }

  private placedAll: { e: number; n: number; m: RailMode }[] = [];

  update(ctx: FrameContext) {
    const sig = this.railSignature();
    if (sig !== this.dataSig && this.system.tripCount > 0) {
      this.dataSig = sig;
      this.placedAll = [];
      this.prepare();
    }
    const on = useApp.getState().layers.rail;
    this.mesh.visible = on && !!this.tracks;
    this.root.style.display = on ? '' : 'none';
    if (!this.tracks || !on) return;
    const fe = ctx.focus.x, fn = -ctx.focus.z;
    if (ctx.anchor.version !== this.anchorVersion || Math.hypot(fe - this.buildCentre.x, fn - this.buildCentre.y) > REBUILD_DIST) {
      this.anchorVersion = ctx.anchor.version;
      this.rebuild(ctx);
    }
    this.updateLabels(ctx);
  }

  private updateLabels(ctx: FrameContext) {
    const { width, height } = ctx.viewport;
    const cam = ctx.camera;
    const show = ctx.altitude < LABEL_MAX_ALT;
    let nVis = 0;
    for (const g of this.groups) {
      const dist = Math.hypot(g.e - ctx.cameraPos.x, -g.n - ctx.cameraPos.z);
      if (!show || dist > LABEL_MAX_DIST + 500) {
        if (g.attached) { g.el.remove(); g.attached = false; }
        continue;
      }
      if (!g.attached) { this.root.appendChild(g.el); g.attached = true; }
      if (Number.isNaN(g.h) || ctx.frame % 90 === 0) g.h = this.engine.heightAt(g.e, g.n);
      this.v.set(g.e, g.h + 14, -g.n).project(cam);
      const vis = this.v.z > -1 && this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05;
      if (!vis) { g.el.style.opacity = '0'; continue; }
      const x = (this.v.x * 0.5 + 0.5) * width, y = (-this.v.y * 0.5 + 0.5) * height;
      g.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) translateY(-5px)`;
      const fd = Math.max(0, Math.min(1, (LABEL_MAX_DIST - dist) / 1000));
      const fa = Math.max(0, Math.min(1, (LABEL_MAX_ALT - ctx.altitude) / 1500));
      const o = fd * fa;
      g.el.style.opacity = o.toFixed(2);
      g.el.style.zIndex = String(Math.round(10000 - dist / 2));
      if (o > 0.05) nVis++;
    }
    this.stats.labels = nVis;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.root.remove();
  }
}

// ---------------------------------------------------------------- helpers
function dirOf(q: { nx: number; ny: number }) {
  // along-track unit vector in three coords (tangent = (ny, -nx) in E/N → (ny, 0, nx))
  return new THREE.Vector3(q.ny, 0, q.nx);
}

/** vertical square post from base point p (three coords) */
function post(b: MeshBuilder, p: THREE.Vector3, w: number, h: number, c: RGB) {
  b.box(p.x - w / 2, p.x + w / 2, p.y, p.y + h, p.z - w / 2, p.z + w / 2, c, 0, 'bottom');
}

/** box aligned with the track at sample q: length along track, width across; y absolute (relative to q.z) */
function orientedBox(b: MeshBuilder, c: THREE.Vector3, q: { z: number; nx: number; ny: number }, len: number, wid: number, y0: number, y1: number, col: RGB, skipBottom: boolean) {
  const t = dirOf(q);
  const n = new THREE.Vector3(q.nx, 0, -q.ny);
  const base = q.z;
  const corner = (a: number, s: number, y: number) =>
    new THREE.Vector3(c.x + t.x * a + n.x * s, base + y, c.z + t.z * a + n.z * s);
  const hl = len / 2, hw = wid / 2;
  const up = new THREE.Vector3(0, 1, 0);
  b.quad(corner(-hl, -hw, y1), corner(hl, -hw, y1), corner(hl, hw, y1), corner(-hl, hw, y1), col, 0, up);
  if (!skipBottom) b.quad(corner(-hl, -hw, y0), corner(hl, -hw, y0), corner(hl, hw, y0), corner(-hl, hw, y0), col, 0, up.clone().negate());
  b.quad(corner(-hl, hw, y0), corner(hl, hw, y0), corner(hl, hw, y1), corner(-hl, hw, y1), col, 0, n);
  b.quad(corner(-hl, -hw, y0), corner(hl, -hw, y0), corner(hl, -hw, y1), corner(-hl, -hw, y1), col, 0, n.clone().negate());
  b.quad(corner(hl, -hw, y0), corner(hl, hw, y0), corner(hl, hw, y1), corner(hl, -hw, y1), col, 0, t);
  b.quad(corner(-hl, -hw, y0), corner(-hl, hw, y0), corner(-hl, hw, y1), corner(-hl, -hw, y1), col, 0, t.clone().negate());
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
