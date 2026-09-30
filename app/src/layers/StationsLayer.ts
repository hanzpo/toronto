// Rail stations (subway, LRT, GO, UP, VIA) from the curated station table
// (data/stations.json, see docs/STATIONS.md): platforms snapped onto the
// tracks the trains run on, canopies, shelters, name boards, underground
// station boxes, surface entrances and bus-bay canopies (layers/stations/
// build.ts), plus DOM station labels with line badges, decluttered through
// the shared label board.
//
// Streaming: stations within STREAM_RADIUS of the camera focus are merged
// into two meshes (lit surface + unlit underground, vertex colours → 2 draws);
// stations within SIGN_RADIUS get one textured sign mesh each (per-station
// atlas: name tiles, name boards, logos). Rebuilt when the focus moves more
// than REBUILD_DIST, the floating anchor rebases, or a station that was built
// before its terrain tile loaded can now be finished.
//
// Tunnel API: `stationBoxesNear(e, n, r)` returns the underground station
// boxes (reference track path, lateral extents, platforms, wall colour) so
// the cab-view tunnel (interact/tunnel.ts) can match them.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { labelBoard, visibleFrom } from '../render/labelBoard';
import { useApp } from '../state/store';
import type { Mode, RouteMeta, TransitSystem } from '../transit';
import { buildStation, type Built, type StationBox } from './stations/build';
import { fallbackStations, HEAVY, loadStations, RAIL_MODES, type StationRec } from './stations/data';
import { makeAtlas, wallColour, type Bullet } from './stations/signs';
import { TrackIndex } from './stations/tracks';
import { fetchTbn } from '../data/tbn';

export type { StationBox } from './stations/build';

const STREAM_RADIUS = 3500;
const SIGN_RADIUS = 900;
const REBUILD_DIST = 400;

let active: StationsLayer | null = null;

/**
 * Underground station boxes within r of (e, n) (world E/N metres). Built on
 * demand; empty until the rail feeds and stations.json have loaded.
 */
export function stationBoxesNear(e: number, n: number, r = 400): StationBox[] {
  return active ? active.boxesNear(e, n, r) : [];
}

interface Label {
  st: StationRec;
  el: HTMLDivElement | null;
  html: string;
  h: number;
  occ: boolean;
  occAt: number;
  attached: boolean;
}

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const st = document.createElement('style');
  st.textContent = `
.stations-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.stn-label { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 3px; white-space: nowrap; opacity: 0;
  font: 600 11.5px/1 var(--ui, system-ui, sans-serif); letter-spacing: -0.005em; color: #161a20; background: #fff; border-radius: 6px;
  padding: 3px 7px 3px 3px; box-shadow: 0 0 0 1px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.22); will-change: transform, opacity; }
.stn-label.r1 { font-size: 10.5px; padding: 2px 6px 2px 2px; border-radius: 5px; }
.stn-label.r3 { font-size: 12.5px; font-weight: 650; }
.stn-label::after { content: ''; position: absolute; left: 50%; bottom: -4px; margin-left: -4px; border: 4px solid transparent;
  border-bottom: 0; border-top-color: #fff; }
.stn-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 4px;
  border-radius: 9px; font: 700 10.5px/1 var(--ui, system-ui, sans-serif); box-sizing: border-box; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15); }
.stn-badge:last-of-type { margin-right: 2px; }
.stn-label.r1 .stn-badge { min-width: 15px; height: 15px; font-size: 9.5px; }
.stn-badge.sq { border-radius: 4px; padding: 0 4px; letter-spacing: 0.01em; }
`;
  document.head.appendChild(st);
}

export class StationsLayer implements Layer {
  readonly id = 'stations';
  private engine!: Engine;
  private system: TransitSystem;
  private tracks: TrackIndex | null = null;
  /** every rail network track (clearance clipping), from data/rail/network.bin.gz */
  private allTracks: TrackIndex | null = null;
  private curated: StationRec[] | null = null;
  private curatedLoaded = false;
  private stations: StationRec[] = [];
  private built = new Map<string, Built | null>();
  private labels: Label[] = [];
  private lit: THREE.Mesh;
  private under: THREE.Mesh;
  private litMat: THREE.MeshStandardMaterial;
  private underMat: THREE.MeshBasicMaterial;
  private signMeshes = new Map<string, THREE.Mesh>();
  private atlases = new Map<string, THREE.CanvasTexture>();
  private dataSig = '';
  private buildCentre = new THREE.Vector2(Infinity, Infinity);
  private anchorVersion = -1;
  private lastPendingCheck = 0;
  private root = document.createElement('div');
  private v = new THREE.Vector3();
  private routes = new Map<string, RouteMeta>();
  /** stats for debugging: stations in the current batch, triangles, visible labels */
  stats = { stations: 0, tris: 0, underTris: 0, signs: 0, labels: 0 };

  constructor(system: TransitSystem) {
    this.system = system;
    this.litMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
    this.litMat.name = 'stations';
    this.underMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.underMat.name = 'stations-under';
    this.lit = new THREE.Mesh(new THREE.BufferGeometry(), this.litMat);
    this.lit.name = 'stations';
    this.lit.castShadow = true;
    this.lit.receiveShadow = true;
    this.lit.frustumCulled = false;
    this.under = new THREE.Mesh(new THREE.BufferGeometry(), this.underMat);
    this.under.name = 'stations-under';
    this.under.frustumCulled = false;
  }

  init(engine: Engine) {
    this.engine = engine;
    active = this;
    injectCss();
    this.root.className = 'stations-layer';
    engine.renderer.domElement.parentElement?.appendChild(this.root);
    engine.scene.add(this.lit);
    engine.scene.add(this.under);
    fetchTbn(`${engine.dataRoot}/rail/network.bin.gz`).then((t) => {
      if (!t) return;
      const a = t.arrays;
      const off = a.e_off as Uint32Array, xyz = a.e_xyz as Float32Array, kind = a.e_kind as Uint8Array;
      const idx = new TrackIndex();
      for (let e = 0; e + 1 < off.length; e++) {
        if (kind[e] === 3) continue; // street-running tram
        idx.add(kind[e] === 1 ? 'subway' : kind[e] === 2 ? 'lrt' : 'commuter_rail', '', xyz.subarray(3 * off[e], 3 * off[e + 1]));
      }
      this.allTracks = idx;
      this.built.clear();
      this.buildCentre.set(Infinity, Infinity);
    }).catch(() => {});
    loadStations(engine.dataRoot).then((s) => {
      this.curated = s;
      this.curatedLoaded = true;
      this.dataSig = ''; // re-prepare with the curated table
    });
  }

  private railSignature(): string {
    return this.system.feedsInfo().filter((f) => f.kind === 'rail').map((f) => `${f.agency}:${f.profile}`).join(',');
  }

  /** (Re)build the track index + labels when the loaded rail feeds (or the station table) change. */
  private prepare() {
    const idx = this.system.index;
    if (!idx) return;
    const t = new TrackIndex();
    for (const m of RAIL_MODES) {
      for (const rl of this.system.routeLines({ modes: [m] })) for (const l of rl.lines) t.add(m, rl.meta.id, l);
    }
    this.tracks = t;
    this.routes = new Map(this.system.routes.map((r) => [r.id, r]));
    this.stations = this.curated ?? fallbackStations(idx);
    this.built.clear();
    for (const m of this.signMeshes.values()) this.disposeSign(m);
    this.signMeshes.clear();
    this.buildLabels();
    this.buildCentre.set(Infinity, Infinity);
  }

  // ---------------------------------------------------------------- labels
  private badges(st: StationRec): { html: string; bullets: Bullet[] } {
    const idx = this.system.index!;
    const byId = new Map(idx.stations.map((s) => [s.id, s]));
    const out: string[] = [];
    const bullets: Bullet[] = [];
    const seen = new Set<string>();
    const add = (key: string, html: string) => { if (!seen.has(key)) { seen.add(key); out.push(html); } };
    const order: Mode[] = ['subway', 'lrt', 'commuter_rail', 'airport_rail', 'intercity_rail'];
    const members = st.ids.map((i) => byId.get(i)).filter((s) => !!s);
    for (const m of order) {
      for (const s of members) {
        if (!s.modes.includes(m)) continue;
        if (m === 'subway' || m === 'lrt') {
          for (const rid of s.routes) {
            const r = this.routes.get(rid);
            if (!r || r.mode !== m) continue;
            if (!seen.has(rid)) bullets.push({ text: r.short, bg: r.color, fg: r.textColor });
            add(rid, `<span class="stn-badge" style="background:${r.color};color:${r.textColor}">${escapeHtml(r.short)}</span>`);
          }
        } else if (m === 'commuter_rail') add('go', `<span class="stn-badge sq" style="background:#3d8b37;color:#fff">GO</span>`);
        else if (m === 'airport_rail') add('up', `<span class="stn-badge sq" style="background:#e8641b;color:#fff">UP</span>`);
        else add('via', `<span class="stn-badge sq" style="background:#ffd400;color:#1a2a55">VIA</span>`);
      }
    }
    return { html: out.join(''), bullets };
  }

  private buildLabels() {
    for (const l of this.labels) if (l.el) { labelBoard.remove(l.el); l.el.remove(); }
    this.labels = this.stations.map((st) => ({ st, el: null, html: `${this.badges(st).html}<span>${escapeHtml(cleanName(st.name))}</span>`, h: NaN, occ: false, occAt: -1e9, attached: false }));
  }

  // ---------------------------------------------------------------- geometry
  private brand(st: StationRec): 'ttc' | 'go' | 'up' | 'via' | 'lrt' {
    const m = new Set(st.levels.map((l) => l.mode));
    if (st.ids.some((i) => i.startsWith('ttc:'))) return 'ttc';
    if (m.has('subway') || m.has('lrt')) return 'lrt';
    if (m.has('commuter_rail')) return 'go';
    if (m.has('airport_rail')) return 'up';
    return 'via';
  }

  private hasHeights(e: number, n: number): boolean {
    const S = this.engine.tiles.manifest?.tileSize[0];
    if (!S) return false;
    return !!this.engine.tiles.tiles.get(`0/${Math.floor(e / S)}/${Math.floor(n / S)}`)?.heights;
  }

  private getBuilt(st: StationRec): Built | null {
    let b = this.built.get(st.id);
    if (b === undefined) {
      b = buildStation(st, {
        tracks: this.tracks!,
        allTracks: this.allTracks,
        heightAt: (e, n) => this.engine.heightAt(e, n),
        hasHeights: (e, n) => this.hasHeights(e, n),
        wall: wallColour(cleanName(st.name), st.levels.find((l) => l.wall)?.wall),
        brand: this.brand(st),
      }, []);
      if (!b.lit.tris && !b.under.tris && !b.signs.tris && !b.pending) b = null;
      this.built.set(st.id, b);
    }
    return b;
  }

  /** Clearance QA over every station (builds all of them): platforms and track intrusions per station. */
  clearanceReport(): { stations: number; platforms: number; bad: { id: string; n: number; e: number; nn: number }[] } {
    let platforms = 0;
    const bad: { id: string; n: number; e: number; nn: number }[] = [];
    for (const st of this.stations) {
      const b = this.getBuilt(st);
      if (!b) continue;
      platforms += b.qa.platforms;
      if (b.qa.intrusions.length) bad.push({ id: st.id, n: b.qa.intrusions.length, e: Math.round(b.qa.intrusions[0].e), nn: Math.round(b.qa.intrusions[0].n) });
    }
    return { stations: this.stations.length, platforms, bad };
  }

  boxesNear(e: number, n: number, r: number): StationBox[] {
    if (!this.tracks) return [];
    const out: StationBox[] = [];
    for (const st of this.stations) {
      if (Math.hypot(st.c[0] - e, st.c[1] - n) > r + 300) continue;
      if (!st.levels.some((l) => l.grade === 'underground')) continue;
      const b = this.getBuilt(st);
      if (b) out.push(...b.boxes);
    }
    return out;
  }

  private rebuild(ctx: FrameContext) {
    const fe = ctx.focus.x, fn = -ctx.focus.z;
    this.buildCentre.set(fe, fn);
    const anchor = ctx.anchor.origin;
    const parts: Built[] = [];
    const near = new Set<string>();
    for (const st of this.stations) {
      const d = Math.hypot(st.c[0] - fe, st.c[1] - fn);
      if (d > STREAM_RADIUS + 300) continue;
      const b = this.getBuilt(st);
      if (!b) continue;
      parts.push(b);
      if (d < SIGN_RADIUS && b.signs.tris) near.add(st.id);
    }
    const merge = (pick: (b: Built) => { pos: number[]; nrm: number[]; col: number[]; idx: number[] }, mesh: THREE.Mesh, withNormals: boolean) => {
      let nV = 0, nI = 0;
      for (const p of parts) { const g = pick(p); nV += g.pos.length / 3; nI += g.idx.length; }
      const pos = new Float32Array(nV * 3), col = new Float32Array(nV * 3), idx = new Uint32Array(nI);
      const nrm = withNormals ? new Float32Array(nV * 3) : null;
      let v = 0, k = 0;
      for (const p of parts) {
        const g = pick(p);
        const dx = p.oe - anchor.x, dz = -p.on - anchor.z;
        const cnt = g.pos.length / 3;
        for (let i = 0; i < cnt; i++) {
          pos[3 * (v + i)] = g.pos[3 * i] + dx;
          pos[3 * (v + i) + 1] = g.pos[3 * i + 1];
          pos[3 * (v + i) + 2] = g.pos[3 * i + 2] + dz;
        }
        if (nrm) nrm.set(g.nrm, 3 * v);
        col.set(g.col, 3 * v);
        for (let i = 0; i < g.idx.length; i++) idx[k + i] = g.idx[i] + v;
        v += cnt; k += g.idx.length;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (nrm) geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      mesh.geometry.dispose();
      mesh.geometry = geo;
      mesh.position.copy(anchor);
      return nI / 3;
    };
    this.stats.tris = merge((b) => b.lit, this.lit, true);
    this.stats.underTris = merge((b) => b.under, this.under, false);
    this.stats.stations = parts.length;
    // sign meshes (one per nearby station)
    for (const [id, m] of this.signMeshes) if (!near.has(id)) { this.disposeSign(m); this.signMeshes.delete(id); }
    for (const b of parts) {
      if (!near.has(b.id)) continue;
      let m = this.signMeshes.get(b.id);
      if (m && m.userData.built !== b) { this.disposeSign(m); this.signMeshes.delete(b.id); m = undefined; }
      if (!m) {
        const st = this.stations.find((s) => s.id === b.id)!;
        let tex = this.atlases.get(b.id);
        if (!tex) {
          tex = makeAtlas(cleanName(st.name), wallColour(cleanName(st.name), st.levels.find((l) => l.wall)?.wall), this.badges(st).bullets);
          this.atlases.set(b.id, tex);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(b.signs.pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.signs.uv, 2));
        geo.setIndex(b.signs.idx);
        geo.computeBoundingSphere();
        const mat = new THREE.MeshBasicMaterial({ map: tex });
        m = new THREE.Mesh(geo, mat);
        m.name = `station-signs:${b.id}`;
        m.userData.built = b;
        this.engine.scene.add(m);
        this.signMeshes.set(b.id, m);
      }
      m.position.set(b.oe, 0, -b.on);
    }
    // atlases of stations far away are released
    for (const [id, t] of this.atlases) if (!near.has(id)) { t.dispose(); this.atlases.delete(id); }
    this.stats.signs = this.signMeshes.size;
  }

  private disposeSign(m: THREE.Mesh) {
    m.removeFromParent();
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }

  update(ctx: FrameContext) {
    const sig = this.railSignature() + (this.curatedLoaded ? '|c' : '');
    if (sig !== this.dataSig && this.system.tripCount > 0 && this.curatedLoaded) {
      this.dataSig = sig;
      this.prepare();
    }
    const on = useApp.getState().layers.rail;
    this.lit.visible = on && !!this.tracks;
    this.under.visible = this.lit.visible;
    for (const m of this.signMeshes.values()) m.visible = this.lit.visible;
    this.root.style.display = on ? '' : 'none';
    if (!this.tracks || !on) return;
    const fe = ctx.focus.x, fn = -ctx.focus.z;
    let dirty = ctx.anchor.version !== this.anchorVersion || Math.hypot(fe - this.buildCentre.x, fn - this.buildCentre.y) > REBUILD_DIST;
    // finish stations that were built before their terrain tile arrived
    if (!dirty && ctx.time - this.lastPendingCheck > 1.5) {
      this.lastPendingCheck = ctx.time;
      for (const [id, b] of this.built) {
        if (!b || !b.pending) continue;
        const d = Math.hypot(b.oe - fe, b.on - fn);
        if (d > STREAM_RADIUS) continue;
        const st = this.stations.find((s) => s.id === id)!;
        if (st.ents.concat().every((e) => e.k === 'underground' || e.k === 'path' || this.hasHeights(e.p[0], e.p[1])) && this.hasHeights(b.oe, b.on)) {
          this.built.delete(id);
          dirty = true;
        }
      }
    }
    if (dirty) {
      this.anchorVersion = ctx.anchor.version;
      this.rebuild(ctx);
    }
    this.updateLabels(ctx);
  }

  // ---------------------------------------------------------------- labels
  private updateLabels(ctx: FrameContext) {
    const { width, height } = ctx.viewport;
    const cam = ctx.camera;
    const cp = ctx.cameraPos;
    const alt = ctx.altitude;
    let nVis = 0;
    // distance limits by importance, growing with altitude; minor stops drop out first
    // street level: LRT stops ≤ 300 m, stations ≤ 500 m, major interchanges ≤ 800 m
    // (and only with a clear line of sight); the reach grows with altitude
    const altK = Math.min(14, 1 + alt / 120);
    const base = [0, 300, 500, 800];
    const altMax = [0, 1800, 5500, 12000];
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      const st = l.st;
      const r = Math.max(1, Math.min(3, st.rank));
      const maxD = base[r] * altK;
      const dist = Math.hypot(st.c[0] - cp.x, -st.c[1] - cp.z);
      const inRange = alt < altMax[r] && dist < maxD;
      if (!inRange) {
        if (l.el && l.attached && dist > maxD * 1.3 + 500) { labelBoard.remove(l.el); l.el.remove(); l.attached = false; }
        continue;
      }
      if (!l.el) {
        l.el = document.createElement('div');
        l.el.className = `stn-label r${r}`;
        l.el.innerHTML = l.html;
      }
      if (!l.attached) { this.root.appendChild(l.el); l.attached = true; }
      if (Number.isNaN(l.h) || ctx.frame % 90 === i % 90) {
        const b = this.built.get(st.id);
        l.h = b ? Math.max(b.labelH, this.engine.heightAt(st.c[0], st.c[1])) : this.engine.heightAt(st.c[0], st.c[1]);
      }
      const ah = l.h + (r === 3 ? 18 : 12);
      this.v.set(st.c[0], ah, -st.c[1]).project(cam);
      if (!(this.v.z > -1 && this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05)) continue;
      // line of sight (terrain + loaded buildings), refreshed ~3×/s per label
      if (ctx.time - l.occAt > 0.3 + (i % 7) * 0.02) {
        l.occAt = ctx.time;
        l.occ = alt < 1500 && !visibleFrom(this.engine, cp.x, cp.y, cp.z, st.c[0], st.c[1], ah, 45);
      }
      if (l.occ) continue;
      const x = (this.v.x * 0.5 + 0.5) * width, y = (-this.v.y * 0.5 + 0.5) * height;
      const fd = Math.max(0, Math.min(1, (maxD - dist) / (maxD * 0.25)));
      const fa = Math.max(0, Math.min(1, (altMax[r] - alt) / (altMax[r] * 0.25)));
      const want = fd * fa;
      if (want < 0.03) continue;
      labelBoard.submit(l.el, x, y, r * 100000 - dist, want, { ax: -0.5, ay: -1, dy: -5, pad: 3 });
      nVis++;
    }
    this.stats.labels = nVis;
  }

  dispose() {
    if (active === this) active = null;
    this.lit.removeFromParent();
    this.lit.geometry.dispose();
    this.under.removeFromParent();
    this.under.geometry.dispose();
    this.litMat.dispose();
    this.underMat.dispose();
    for (const m of this.signMeshes.values()) this.disposeSign(m);
    for (const t of this.atlases.values()) t.dispose();
    for (const l of this.labels) if (l.el) labelBoard.remove(l.el);
    this.root.remove();
  }
}

// ---------------------------------------------------------------- helpers
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

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

void HEAVY;
