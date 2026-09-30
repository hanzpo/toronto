// Debug inspection: camera/time/location info and "what's under the cursor",
// read from the raw tile data (the same arrays the pipeline wrote), so a bug
// report carries exact OSM ids, classes and coordinates.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import { decodeTbn, gunzip, type TypedArray } from '../data/tbn';
import { clock, torontoParts, torontoToUtc } from '../state/clock';
import { useApp } from '../state/store';

// ---------------------------------------------------------------- projection
// Inverse Transverse Mercator (WGS84, k0 = 1) around Toronto City Hall — the
// pipeline's projection (pipeline/tpipe/geo.py).
const LAT0 = 43.6532, LON0 = -79.3832;
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const rad = Math.PI / 180;

function meridian(phi: number) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
}
const M0 = meridian(LAT0 * rad);

/** world metres (E, N) → [lat, lon] degrees */
export function toLatLon(e: number, n: number): [number, number] {
  const M = M0 + n;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const C1 = EP2 * c * c, T1 = t * t, N1 = A / Math.sqrt(1 - E2 * s * s), R1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5;
  const D = e / N1;
  const lat = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [lat / rad, LON0 + lon / rad];
}

// ---------------------------------------------------------------- live info

export interface LiveInfo {
  simIso: string; dayType: string; speed: number; playing: boolean;
  cam: { e: number; n: number; elev: number; lat: number; lon: number; alt: number; dist: number; headingDeg: number; pitchDeg: number };
  focus: { e: number; n: number };
  tile: string;
  build: number | string;
  url: string;
  stats: { fps: number; draws: number; tris: number; tiles: string; cpuMs: number };
  qa: Record<string, number> | null;
}

const pad = (v: number) => String(v).padStart(2, '0');

export function simIso(ms = clock.simMs): string {
  const p = torontoParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function liveInfo(engine: Engine): LiveInfo {
  const st = useApp.getState();
  const cur = engine.controls.cur;
  const cp = engine.camera.position;
  const e = cp.x, n = -cp.z;
  const [lat, lon] = toLatLon(e, n);
  const headingDeg = ((cur.heading / rad) % 360 + 360) % 360, pitchDeg = cur.pitch / rad;
  const S0 = engine.tiles.manifest.tileSize['0'] ?? 1024;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('cam', [cur.e, cur.n, cur.dist, headingDeg, pitchDeg].map((v) => Math.round(v * 10) / 10).join(','));
  url.searchParams.set('t', simIso());
  url.searchParams.set('dbg', '1');
  const s = st.stats;
  const qa = (window as unknown as { __qa?: { counters?: () => Record<string, number> } }).__qa;
  return {
    simIso: simIso(),
    dayType: st.dayTypeOverride ?? ['sunday', 'weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'saturday'][clock.parts().weekday],
    speed: st.speedIndex, playing: st.playing,
    cam: { e, n, elev: cp.y, lat, lon, alt: s.altitude, dist: cur.dist, headingDeg, pitchDeg },
    focus: { e: cur.e, n: cur.n },
    tile: `0/${Math.floor(cur.e / S0)}_${Math.floor(cur.n / S0)}`,
    build: engine.tiles.manifest.build ?? '?',
    url: url.toString(),
    stats: { fps: s.fps, draws: s.drawCalls, tris: s.triangles, tiles: `${s.tilesVisible}/${s.tilesLoaded}`, cpuMs: s.frameMs },
    qa: qa?.counters ? qa.counters() : null,
  };
}

/** Apply `?t=YYYY-MM-DDTHH:MM[:SS]` (Toronto local) and `?speed=<index>` from the URL. */
export function applyUrlTime() {
  const q = new URLSearchParams(location.search);
  const t = q.get('t');
  const m = t?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) clock.set(torontoToUtc(+m[1], +m[2], +m[3], +m[4] * 3600 + +m[5] * 60 + +(m[6] ?? 0)));
  const sp = q.get('speed');
  if (sp !== null && !Number.isNaN(+sp)) useApp.getState().setSpeedIndex(+sp);
}

// ---------------------------------------------------------------- cursor inspection

const tileCache = new Map<string, Promise<{ a: Record<string, TypedArray>; names: string[] } | null>>();

function rawTile(engine: Engine, L: number, tx: number, ty: number) {
  const key = `${L}/${tx}_${ty}`;
  let p = tileCache.get(key);
  if (!p) {
    const b = engine.tiles.manifest.build;
    p = fetch(`${engine.dataRoot}/tiles/${key}.bin.gz${b ? `?v=${b}` : ''}`)
      .then(async (r) => {
        if (!r.ok) return null;
        const t = decodeTbn<{ names?: string[] }>(await gunzip(r));
        return { a: t.arrays, names: (t.header.names as string[]) ?? [] };
      })
      .catch(() => null);
    tileCache.set(key, p);
    if (tileCache.size > 24) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

const GROUND = ['land', 'water', 'grass/park', 'forest', 'residential', 'commercial', 'industrial', 'farmland', 'sand/beach', 'road',
  'rail', 'parking', 'cemetery', 'golf', 'aeroway', 'major road', 'wetland', 'institutional', 'construction', 'sports pitch',
  'runway/taxiway', 'platform/plaza', 'building', 'airfield grass'];
const ROAD = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'pedestrian', 'footway/path', 'track'];
const RAIL = ['rail', 'siding/yard', 'subway', 'light rail', 'tram', 'other'];
const KIND = ['generic', 'house', 'apartments', 'office/commercial', 'retail', 'industrial', 'civic', 'education', 'religious',
  'transport', 'hospital', 'garage/shed', 'stadium', 'hotel', 'parking', 'roof/canopy', 'construction'];

function distToPolyline(px: number, py: number, xyz: TypedArray, a: number, b: number) {
  let best = Infinity;
  for (let i = a; i < b - 1; i++) {
    const x0 = xyz[i * 3], y0 = xyz[i * 3 + 1], x1 = xyz[i * 3 + 3], y1 = xyz[i * 3 + 4];
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2));
    best = Math.min(best, Math.hypot(px - x0 - t * dx, py - y0 - t * dy));
  }
  return best;
}

function inRing(px: number, py: number, xy: TypedArray, a: number, b: number) {
  let inside = false;
  for (let i = a, j = b - 1; i < b; j = i++) {
    const xi = xy[i * 2], yi = xy[i * 2 + 1], xj = xy[j * 2], yj = xy[j * 2 + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/** Everything we know about the point under a screen position. */
export async function inspectAt(engine: Engine, clientX: number, clientY: number): Promise<Record<string, unknown>> {
  const r = engine.renderer.domElement.getBoundingClientRect();
  _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, engine.camera);
  // skip invisible helpers (night light pools, shadow-only proxies, overlays)
  const skip = /glow|shadow|overlay|lines-|stops|sel-|lakePlane/i;
  const hits = _ray.intersectObject(engine.scene, true).filter((h) => {
    if (!(h.object as THREE.Mesh).isMesh) return false;
    for (let o: THREE.Object3D | null = h.object; o; o = o.parent) if (!o.visible || skip.test(o.name)) return false;
    return true;
  });
  const first = hits[0];
  const ground = engine.pickGround(clientX, clientY);
  const pt = first ? { e: first.point.x, n: -first.point.z, h: first.point.y } : ground;
  const out: Record<string, unknown> = {};
  if (!pt) return { note: 'nothing under cursor' };
  const [lat, lon] = toLatLon(pt.e, pt.n);
  out.point = { e: +pt.e.toFixed(1), n: +pt.n.toFixed(1), elev: +pt.h.toFixed(1), lat: +lat.toFixed(6), lon: +lon.toFixed(6),
    terrain: +engine.heightAt(pt.e, pt.n).toFixed(1) };
  if (first) {
    const path: string[] = [];
    for (let o: THREE.Object3D | null = first.object; o && o !== engine.scene; o = o.parent) path.push(o.name || o.type);
    out.object = path.join(' < ') + (first.instanceId !== undefined ? ` #${first.instanceId}` : '');
  }
  // vehicles / stops / cars (interaction layer's picker)
  const ix = (window as unknown as { __interact?: { pick?: (x: number, y: number) => unknown } }).__interact;
  const pick = ix?.pick?.(clientX, clientY) as { kind?: string; trip?: number; label?: string } | null | undefined;
  if (pick) {
    out.pick = pick;
    const tr = (window as unknown as { __transit?: { system?: { tripInfo?: (t: number) => unknown } } }).__transit;
    if (pick.trip !== undefined && tr?.system?.tripInfo) {
      const info = tr.system.tripInfo(pick.trip) as { routeMeta?: { id: string; short: string }; headsign?: string; name?: string } | null;
      if (info) out.trip = { trip: pick.trip, route: info.routeMeta?.id, short: info.routeMeta?.short, headsign: info.headsign, name: info.name };
    }
  }
  // raw tile data at the point
  const S = engine.tiles.manifest.tileSize['0'] ?? 1024;
  const tx = Math.floor(pt.e / S), ty = Math.floor(pt.n / S);
  const raw = await rawTile(engine, 0, tx, ty);
  out.tile = `0/${tx}_${ty}`;
  if (!raw) return out;
  const a = raw.a, lx = pt.e - tx * S, ly = pt.n - ty * S;
  if (a.ground) {
    const i = Math.min(255, Math.max(0, Math.floor((lx / S) * 256))), j = Math.min(255, Math.max(0, Math.floor((ly / S) * 256)));
    const g = a.ground[j * 256 + i];
    out.ground = `${g} ${GROUND[g] ?? ''}`;
  }
  const nearestLine = (prefix: 'r' | 'l', max: number) => {
    const off = a[`${prefix}_off`], xyz = a[`${prefix}_xyz`];
    if (!off || !xyz) return null;
    let best = -1, bd = max;
    for (let k = 0; k < off.length - 1; k++) {
      const d = distToPolyline(lx, ly, xyz, off[k], off[k + 1]);
      if (d < bd) { bd = d; best = k; }
    }
    return best < 0 ? null : { k: best, d: bd };
  };
  const rd = nearestLine('r', 40);
  if (rd) {
    const k = rd.k, fl = a.r_flags?.[k] ?? 0, ni = a.r_name?.[k] ?? 0xffff;
    out.road = {
      osm: a.r_osm?.[k], name: ni !== 0xffff ? raw.names[ni] : undefined, class: `${a.r_class[k]} ${ROAD[a.r_class[k]] ?? ''}`,
      width: a.r_width ? +a.r_width[k].toFixed(1) : undefined, lanes: a.r_lanes?.[k], layer: a.r_layer?.[k],
      flags: [fl & 1 && 'oneway', fl & 2 && 'bridge', fl & 4 && 'tunnel', fl & 8 && 'link', fl & 16 && 'roundabout'].filter(Boolean).join(','),
      dist: +rd.d.toFixed(1),
    };
  }
  const rl = nearestLine('l', 25);
  if (rl) {
    const k = rl.k, fl = a.l_flags?.[k] ?? 0;
    out.rail = { osm: a.l_osm?.[k], class: `${a.l_class[k]} ${RAIL[a.l_class[k]] ?? ''}`,
      flags: [fl & 2 && 'bridge', fl & 4 && 'tunnel'].filter(Boolean).join(','), dist: +rl.d.toFixed(1) };
  }
  const ro = a.b_ring_off, vo = a.b_vert_off, bxy = a.b_xy;
  if (ro && vo && bxy) {
    for (let b = 0; b < ro.length - 1; b++) {
      const r0 = ro[b];
      if (inRing(lx, ly, bxy, vo[r0], vo[r0 + 1])) {
        out.building = { osm: a.b_osm?.[b], kind: `${a.b_kind[b]} ${KIND[a.b_kind[b]] ?? ''}`, height: +a.b_height[b].toFixed(1),
          min: a.b_min ? +a.b_min[b].toFixed(1) : 0, base: a.b_base ? +a.b_base[b].toFixed(1) : undefined, roof: a.b_roof?.[b],
          color: a.b_color?.[b] ? '#' + a.b_color[b].toString(16).padStart(6, '0') : undefined };
        break;
      }
    }
  }
  return out;
}

/** Plain-text bug report for the clipboard. */
export function reportText(info: LiveInfo, inspected: Record<string, unknown> | null, note = ''): string {
  return [
    '### GTA Twin debug report',
    note && `note: ${note}`,
    `url: ${info.url}`,
    `sim time: ${info.simIso} (${info.dayType}), speed index ${info.speed}${info.playing ? '' : ' (paused)'}`,
    `camera: E ${info.cam.e.toFixed(1)} N ${info.cam.n.toFixed(1)} elev ${info.cam.elev.toFixed(1)} (alt ${info.cam.alt.toFixed(1)} m) · lat ${info.cam.lat.toFixed(6)} lon ${info.cam.lon.toFixed(6)}`,
    `view: focus E ${info.focus.e.toFixed(1)} N ${info.focus.n.toFixed(1)} · dist ${info.cam.dist.toFixed(1)} · heading ${info.cam.headingDeg.toFixed(1)}° · pitch ${info.cam.pitchDeg.toFixed(1)}° · tile ${info.tile}`,
    `data build: ${info.build} · app: ${import.meta.env.MODE} ${__APP_VERSION__}`,
    `perf: ${info.stats.fps.toFixed(0)} fps · ${info.stats.draws} draws · ${(info.stats.tris / 1e6).toFixed(2)} M tris · tiles ${info.stats.tiles} · ${info.stats.cpuMs.toFixed(1)} ms cpu`,
    info.qa && `qa: ${JSON.stringify(info.qa)}`,
    inspected && `inspect: ${JSON.stringify(inspected, null, 1)}`,
    `ua: ${navigator.userAgent}`,
  ].filter(Boolean).join('\n');
}
