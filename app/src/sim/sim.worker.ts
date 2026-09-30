// Traffic simulation worker: streams road-graph tiles around the focus into
// the Rust/wasm `Sim`, steps it for every render tick and publishes agent
// snapshots into a SharedArrayBuffer (see protocol.ts for the layout).
import init, { Sim } from './pkg/sim.js';
import { decodeTbn, type Tbn } from '../data/tbn';
import {
  bottleneckOf, CAR_STRIDE, H, HEADER_BYTES, HF, HF_COUNT, MAX_CARS, MAX_PEDS, MAX_RAIL, MAX_RAIL_PTS, MAX_SIGNALS, PED_STRIDE, RAIL_OFFSET, RAIL_PATH_OFFSET,
  RAIL_STRIDE, SIG_OFFSET, SIG_STRIDE, SLOT_BYTES, SLOT_HEADER, SLOTS, MAX_BUS, MAX_BUS_PTS, BUS_OFFSET, BUS_PATH_OFFSET, BUS_STRIDE,
  type FromWorker, type TickMsg, type ToWorker,
} from './protocol';

const TILE = 1024;
/** max sim seconds per sub-step (IDM stability) */
const MAX_SUBSTEP = 0.2;
/** wall-clock budget per tick for stepping (ms) */
const BUDGET_MS = 4;
const MAX_SUBSTEPS = 8;
const MAX_FETCHES = 6;

let sim: Sim | null = null;
let memory: WebAssembly.Memory;
let sab: SharedArrayBuffer;
let hdr: Int32Array;
let hf: Float64Array;
let dataRoot = '';
let build = 0;
let available: Set<string> | null = null;
const loaded = new Map<string, { names: string[]; eName: Uint16Array }>();
const pending = new Set<string>();
const missing = new Set<string>();
let stepAvg = 0;
let plansVersion = -1;
let plansAt = 0;
// building footprints (player collisions): level-0 render tiles around the player
const fpPending = new Set<string>();
const fpMissing = new Set<string>();
let fpCache: Promise<Cache | null> | null = null;
let lastRoad: string | null | undefined;

// congestion tier
let majorsKey: Map<string, number> | null = null;
let majorsCount = 0;
const measuredCache = new Map<number, { r: number; t: number }>();

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const key = (tx: number, ty: number) => `${tx}_${ty}`;
const q = (url: string) => (build ? `${url}?v=${build}` : url);

async function fetchBin(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(q(url));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const raw = await res.arrayBuffer();
  const u = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
  if (u[0] !== 0x1f || u[1] !== 0x8b) return raw; // already decoded by the server
  const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}

type GraphHeader = { names?: string[] };

// ----------------------------------------------------------------------------- rail agents
let railNetLoaded: Promise<boolean> | null = null;
let railProfile = '';
let railLoading = false;
let railDepots: { group: number; agencies: string[]; edges: number[] }[] = [];
const u32 = (a: ArrayLike<number>) => (a instanceof Uint32Array ? a : Uint32Array.from(a));

async function loadRailNet(): Promise<boolean> {
  const buf = await fetchBin(`${dataRoot}/rail/network.bin.gz`);
  if (!buf || !sim) return false;
  const t = decodeTbn<{ depots?: typeof railDepots }>(buf);
  const a = t.arrays;
  railDepots = t.header.depots ?? [];
  sim.rail_network(
    a.n_xyz as Float32Array, a.n_flags as Uint8Array, u32(a.e_from), u32(a.e_to), u32(a.e_off), a.e_xyz as Float32Array,
    a.e_vlim as Uint8Array, a.e_len as Float32Array, a.e_kind as Uint8Array, a.e_service as Uint8Array, a.e_dir as Uint8Array,
    a.e_flags as Uint8Array, u32(a.c_off), u32(a.c_to),
  );
  return true;
}

/** (re)load the rail timetables of `profile` as agent feeds */
async function loadRail(profile: string) {
  if (!sim || railLoading) return;
  railLoading = true;
  try {
    railNetLoaded ??= loadRailNet();
    if (!(await railNetLoaded)) return;
    const res = await fetch(q(`${dataRoot}/transit/index.json`));
    if (!res.ok) return;
    const index = (await res.json()) as { agencies: { id: string; profiles: Record<string, { files: Record<string, { file: string }> }> }[] };
    sim.rail_clear_feeds();
    const agencies: string[] = [];
    for (const ag of index.agencies) {
      const f = ag.profiles[profile]?.files.rail;
      if (!f) continue;
      const buf = await fetchBin(`${dataRoot}/transit/${f.file}`);
      if (!buf || !sim) continue;
      const a = decodeTbn(buf).arrays;
      if (!a.pat_redge) continue; // data from before rail routing: timetable only
      const id = agencies.length;
      agencies.push(ag.id);
      sim.rail_add_feed(
        id, a.pat_mode as Uint8Array, a.pat_len as Float32Array, a.pat_rflags as Uint8Array, a.pat_rstart as Float32Array,
        u32(a.pat_redge_off), u32(a.pat_redge), u32(a.pat_stop_off), a.pat_stop_dist as Float32Array, a.pat_stop_flag as Uint8Array,
        u32(a.tp_off), a.tp_arr as Uint16Array, a.tp_dwell as Uint16Array, a.trip_start as Int32Array, u32(a.trip_pattern), u32(a.trip_tp),
        (a.trip_next as Int32Array | undefined) ?? new Int32Array(0),
      );
    }
    // depots: feed masks follow the feed ids just assigned
    const off = [0], edges: number[] = [], groups: number[] = [], masks: number[] = [];
    for (const d of railDepots) {
      let mask = 0;
      for (const ag of d.agencies) { const i = agencies.indexOf(ag); if (i >= 0 && i < 32) mask |= 1 << i; }
      if (!mask) continue;
      groups.push(d.group); masks.push(mask >>> 0); edges.push(...d.edges); off.push(edges.length);
    }
    sim.rail_set_depots(Uint8Array.from(groups), Uint32Array.from(masks), Uint32Array.from(off), Uint32Array.from(edges));
    railProfile = profile;
    post({ type: 'railFeeds', profile, agencies });
  } catch (e) {
    console.warn('[sim] rail', e);
  } finally {
    railLoading = false;
  }
}

async function loadTile(tx: number, ty: number) {
  const k = key(tx, ty);
  pending.add(k);
  try {
    const buf = await fetchBin(`${dataRoot}/graph/${tx}_${ty}.bin.gz`);
    if (!buf) { missing.add(k); return; }
    const t: Tbn<GraphHeader> = decodeTbn<GraphHeader>(buf);
    const a = t.arrays;
    const names = t.header.names ?? [];
    const eName = a.e_name as Uint16Array;
    const bn = new Float32Array(eName.length);
    const cache = new Map<number, number>();
    for (let i = 0; i < eName.length; i++) {
      const ni = eName[i];
      if (ni === 0xffff) continue;
      let v = cache.get(ni);
      if (v === undefined) { v = bottleneckOf(names[ni]); cache.set(ni, v); }
      bn[i] = v;
    }
    if (!sim || sim.has_tile(tx, ty)) return;
    sim.add_tile(
      tx, ty,
      a.n_id as Float64Array, a.n_xyz as Float32Array, a.n_flags as Uint8Array,
      a.e_from as Uint32Array, a.e_to as Uint32Array, a.e_off as Uint32Array, a.e_xyz as Float32Array,
      a.e_class as Uint8Array, a.e_lanes_fwd as Uint8Array, a.e_lanes_bwd as Uint8Array,
      a.e_speed as Float32Array, a.e_flags as Uint8Array, bn,
      (a.e_width as Float32Array | undefined) ?? new Float32Array(0), (a.e_side as Uint8Array | undefined) ?? new Uint8Array(0),
    );
    loaded.set(k, { names, eName: new Uint16Array(eName) });
  } catch (e) {
    console.warn('[sim] tile', k, e);
    missing.add(k);
  } finally {
    pending.delete(k);
  }
}

function rectDist(tx: number, ty: number, e: number, n: number) {
  const dx = Math.max(tx * TILE - e, 0, e - (tx + 1) * TILE);
  const dy = Math.max(ty * TILE - n, 0, n - (ty + 1) * TILE);
  return Math.hypot(dx, dy);
}

function manageTiles(m: TickMsg) {
  if (!sim || m.radius <= 0) return;
  const R = m.radius + 250;
  const want: [number, number, number][] = [];
  const x0 = Math.floor((m.focusE - R) / TILE), x1 = Math.floor((m.focusE + R) / TILE);
  const y0 = Math.floor((m.focusN - R) / TILE), y1 = Math.floor((m.focusN + R) / TILE);
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const k = key(tx, ty);
      if (loaded.has(k) || pending.has(k) || missing.has(k)) continue;
      if (available && !available.has(k)) continue;
      const d = rectDist(tx, ty, m.focusE, m.focusN);
      if (d <= R) want.push([d, tx, ty]);
    }
  }
  want.sort((a, b) => a[0] - b[0]);
  for (const [, tx, ty] of want) {
    if (pending.size >= MAX_FETCHES) break;
    void loadTile(tx, ty);
  }
  // evict with hysteresis
  for (const k of [...loaded.keys()]) {
    const [tx, ty] = k.split('_').map(Number);
    if (rectDist(tx, ty, m.focusE, m.focusN) > R + 1200) {
      sim.remove_tile(tx, ty);
      loaded.delete(k);
    }
  }
  Atomics.store(hdr, H.TILES, loaded.size);
  Atomics.store(hdr, H.PENDING, pending.size);
}

function publish(m: TickMsg) {
  if (!sim) return;
  const slot = (Atomics.load(hdr, H.SLOT) + 1) % SLOTS;
  const base = HEADER_BYTES + slot * SLOT_BYTES;
  const nc = Math.min(sim.car_count(), MAX_CARS);
  const np = Math.min(sim.ped_count(), MAX_PEDS);
  const mem = memory.buffer;
  if (nc) new Float32Array(sab, base + SLOT_HEADER, nc * CAR_STRIDE).set(new Float32Array(mem, sim.car_ptr(), nc * CAR_STRIDE));
  if (np) new Float32Array(sab, base + SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4, np * PED_STRIDE).set(new Float32Array(mem, sim.ped_ptr(), np * PED_STRIDE));
  const ns = Math.min(sim.signal_count(), MAX_SIGNALS);
  if (ns) new Float32Array(sab, base + SIG_OFFSET, ns * SIG_STRIDE).set(new Float32Array(mem, sim.signal_ptr(), ns * SIG_STRIDE));
  let nr = Math.min(sim.rail_count(), MAX_RAIL);
  const npts = sim.rail_path_len();
  if (npts > MAX_RAIL_PTS) nr = 0; // (never expected) drop rather than publish truncated paths
  if (nr) {
    new Float32Array(sab, base + RAIL_OFFSET, nr * RAIL_STRIDE).set(new Float32Array(mem, sim.rail_ptr(), nr * RAIL_STRIDE));
    if (npts) new Float32Array(sab, base + RAIL_PATH_OFFSET, npts * 3).set(new Float32Array(mem, sim.rail_path_ptr(), npts * 3));
  }
  let nb = Math.min(sim.bus_count(), MAX_BUS);
  const nbp = sim.bus_path_len();
  if (nbp > MAX_BUS_PTS) nb = 0;
  if (nb) {
    new Float32Array(sab, base + BUS_OFFSET, nb * BUS_STRIDE).set(new Float32Array(mem, sim.bus_ptr(), nb * BUS_STRIDE));
    new Float32Array(sab, base + BUS_PATH_OFFSET, nbp * 3).set(new Float32Array(mem, sim.bus_path_ptr(), nbp * 3));
  }
  const si = new Int32Array(sab, base, 12);
  const sf = new Float64Array(sab, base, 4);
  si[0] = nc; si[1] = np; si[8] = ns; si[9] = nr; si[10] = nr ? npts : 0; si[11] = nb;
  new Float64Array(sab, base, 8)[6] = nb ? nbp : 0;
  sf[1] = m.originE; sf[2] = m.originN; sf[3] = m.simMs;
  Atomics.store(hdr, H.SLOT, slot);
  Atomics.add(hdr, H.SEQ, 1);
}

function playerInfo() {
  if (!sim) return;
  const p = sim.player_state();
  for (let i = 0; i < 14 && i < p.length; i++) hf[HF.PLAYER + i] = p[i];
  let road: string | null = null;
  if (p[0] && p[10] >= 0) {
    const t = loaded.get(key(p[8], p[9]));
    const ni = t?.eName[p[10]];
    if (t && ni !== undefined && ni !== 0xffff) road = t.names[ni] ?? null;
  }
  if (road !== lastRoad) {
    lastRoad = road;
    post({ type: 'player', roadName: road });
  }
}

function tick(m: TickMsg) {
  if (!sim) { if (hdr) Atomics.add(hdr, H.ACK, 1); return; }
  Atomics.store(hdr, H.BUSY, 1);
  try {
    manageTiles(m);
    if (m.radius > 0) {
      const t0 = performance.now();
      sim.set_view(m.focusE, m.focusN, m.radius, m.pedRadius);
      if (m.railProfile && m.railProfile !== railProfile) void loadRail(m.railProfile);
      sim.rail_set_radius(m.railRadius ?? 0);
      if (m.railCmd) sim.rail_player_input(m.railCmd.cmd, m.railCmd.emergency);
      if (m.camera) sim.rail_set_camera(m.camera[0], m.camera[1], m.camera[2], m.camera[3]);
      if (m.busPatterns) for (const p of m.busPatterns) sim.bus_pattern(p.id, p.xy, p.stopD, p.stopFlag);
      if (m.busRetrip) for (const b of m.busRetrip) sim.bus_retrip(b.old, b.trip, b.pat, b.arr, b.dep);
      if (m.busPullin) for (const b of m.busPullin) sim.bus_pullin(b.trip, b.gx, b.gy);
      if (m.busPullout) for (const b of m.busPullout) sim.bus_pullout(b.trip, b.pat, b.len, b.arr, b.dep, b.gx, b.gy);
      if (m.busSpawn) for (const b of m.busSpawn) { const r = sim.bus_spawn(b.trip, b.pat, b.len, b.front, b.v, b.arr, b.dep); hf[HF.BUSX + Math.min(r, 5)]++; }
      const pl = m.player;
      sim.set_obstacles(m.obst ?? new Float64Array(0));
      if (pl) manageFootprints(hf[HF.PLAYER + 1], hf[HF.PLAYER + 2]);
      if (pl && m.simDt > 0) sim.player_step(m.realDt, pl.throttle, pl.brake, pl.steer, pl.handbrake, pl.groundZ);
      let remaining = Math.min(m.simDt, 3600);
      sim.set_time(m.tod - remaining, m.weekday);
      let k = 0;
      let per = 0;
      while (remaining > 1e-4 && k < MAX_SUBSTEPS) {
        const ts = performance.now();
        // stop before a sub-step would blow the frame budget (always run at least one)
        if (k > 0 && ts - t0 + per > BUDGET_MS) break;
        const h = Math.min(MAX_SUBSTEP, remaining);
        sim.step(h);
        remaining -= h;
        k++;
        per = Math.max(per * 0.5, performance.now() - ts);
      }
      const fast = remaining > 0.01;
      sim.set_time(m.tod, m.weekday);
      sim.set_fast(fast);
      // rail agents (cheap) follow the full sim time in their own steps; only when the clock
      // runs far too fast for them does the timetable take over (never under the player)
      const tr0 = performance.now();
      let rrem = Math.min(m.simDt, 3600);
      let rt = m.tod - rrem;
      let rk = 0;
      while (rrem > 1e-4 && rk < 240) {
        const h = Math.min(0.25, rrem);
        rt += h;
        rrem -= h;
        sim.rail_step(h, rt);
        rk++;
      }
      if (rrem > 1 && !sim.rail_has_player()) sim.rail_reset();
      const rms = performance.now() - tr0;
      hf[HF.RAIL_MS] = hf[HF.RAIL_MS] ? hf[HF.RAIL_MS] * 0.95 + rms * 0.05 : rms;
      sim.write_output(m.originE, m.originN);
      const ms = performance.now() - t0;
      stepAvg = stepAvg ? stepAvg * 0.95 + ms * 0.05 : ms;
      hf[HF.STEP_MS] = ms;
      hf[HF.STEP_AVG] = stepAvg;
      Atomics.store(hdr, H.SUBSTEPS, k);
      Atomics.store(hdr, H.FAST, fast ? 1 : 0);
      const rs = sim.rail_stats();
      for (let i = 0; i < 4; i++) hf[HF.RAIL + i] = rs[i];
      for (let i = 4; i < 7; i++) hf[HF.RAILX + i - 4] = rs[i];
      const rp = sim.rail_player_state();
      for (let i = 0; i < 14; i++) hf[HF.RAILP + i] = rp[i] ?? 0;
      const st = sim.stats();
      hf[HF.TARGET_CARS] = st[0];
      hf[HF.TARGET_PEDS] = st[1];
      hf[HF.CARS] = st[2];
      hf[HF.PEDS] = st[3];
      hf[HF.BOX_STOPPED] = st[6] ?? 0;
      playerInfo();
      publish(m);
      const gv = sim.graph_version();
      if (gv !== plansVersion && performance.now() - plansAt > 1000) {
        plansVersion = gv;
        plansAt = performance.now();
        const plans = new Float64Array(sim.signal_plans());
        post({ type: 'plans', plans }, [plans.buffer]);
      }
    } else if (sim.rail_count() > 0) {
      // camera too high for agents: the timetable draws every train
      sim.rail_set_radius(0);
      sim.write_output(m.originE, m.originN);
      publish(m);
    }
  } finally {
    Atomics.store(hdr, H.BUSY, 0);
    Atomics.add(hdr, H.ACK, 1);
  }
}

// ----------------------------------------------------------------------------- building footprints
// While the player drives, the building outlines of the level-0 render tiles
// around the car are handed to the sim for collisions. The bytes normally come
// straight from the tile worker's Cache Storage (same URL), so this costs no
// extra download.

async function tileBuffer(url: string): Promise<ArrayBuffer | null> {
  fpCache ??= typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(`tiles-${build}`).catch(() => null);
  const cache = await fpCache;
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  const raw = hit ? await hit.arrayBuffer() : await (async () => {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.arrayBuffer();
  })();
  if (!raw) return null;
  const u = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
  if (u[0] !== 0x1f || u[1] !== 0x8b) return raw;
  return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function loadFootprints(tx: number, ty: number) {
  const k = key(tx, ty);
  fpPending.add(k);
  try {
    const buf = await tileBuffer(`${dataRoot}/tiles/0/${tx}_${ty}.bin.gz${build ? `?v=${build}` : ''}`);
    if (!buf) { fpMissing.add(k); return; }
    const a = decodeTbn(buf).arrays;
    const x0 = tx * TILE, y0 = ty * TILE;
    const off: number[] = [0];
    const xy: number[] = [];
    // buildings: outer ring of each (skip overhangs / canopies that start well above the street)
    const bro = a.b_ring_off as Uint32Array | undefined, bvo = a.b_vert_off as Uint32Array | undefined, bxy = a.b_xy as Float32Array | undefined;
    const bmin = a.b_min as Float32Array | undefined;
    if (bro && bvo && bxy) {
      for (let b = 0; b + 1 < bro.length; b++) {
        if (bmin && bmin[b] > 2.5) continue;
        const r = bro[b];
        for (let v = bvo[r]; v < bvo[r + 1]; v++) xy.push(x0 + bxy[v * 2], y0 + bxy[v * 2 + 1]);
        off.push(xy.length / 2);
      }
    }
    // instanced houses: oriented rectangles
    const hxy = a.h_xy as Float32Array | undefined, ha = a.h_angle as Float32Array | undefined;
    const hl = a.h_len as Float32Array | undefined, hw = a.h_wid as Float32Array | undefined;
    if (hxy && ha && hl && hw) {
      for (let i = 0; i < ha.length; i++) {
        const c = Math.cos(ha[i]), s = Math.sin(ha[i]), L = hl[i] / 2, W = hw[i] / 2;
        const cx = x0 + hxy[i * 2], cy = y0 + hxy[i * 2 + 1];
        for (const [u, v] of [[L, W], [-L, W], [-L, -W], [L, -W]]) xy.push(cx + u * c - v * s, cy + u * s + v * c);
        off.push(xy.length / 2);
      }
    }
    if (sim && !sim.has_footprints(tx, ty)) sim.add_footprints(tx, ty, Uint32Array.from(off), Float32Array.from(xy));
  } catch (e) {
    console.warn('[sim] footprints', k, e);
    fpMissing.add(k);
  } finally {
    fpPending.delete(k);
  }
}

function manageFootprints(e: number, n: number) {
  if (!sim || !Number.isFinite(e)) return;
  const cx = Math.floor(e / TILE), cy = Math.floor(n / TILE);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const tx = cx + dx, ty = cy + dy, k = key(tx, ty);
      // only the tiles the car is near (within 150 m of their edge)
      if (rectDist(tx, ty, e, n) > 150 || fpPending.has(k) || fpMissing.has(k) || sim.has_footprints(tx, ty)) continue;
      if (available && !available.has(k)) continue;
      void loadFootprints(tx, ty);
    }
  }
  const t = sim.footprint_tiles();
  for (let i = 0; i + 1 < t.length; i += 2) {
    if (Math.abs(t[i] - cx) > 2 || Math.abs(t[i + 1] - cy) > 2) sim.remove_footprints(t[i], t[i + 1]);
  }
}

async function loadMajors() {
  if (!sim || majorsKey) return;
  const buf = await fetchBin(`${dataRoot}/congestion/majors.bin.gz`);
  if (!buf) { console.warn('[sim] no congestion/majors.bin.gz'); return; }
  const t = decodeTbn<{ names?: string[] }>(buf);
  const a = t.arrays;
  const off = a.s_off as Uint32Array, xyz = a.s_xyz as Float32Array;
  const cls = a.s_class as Uint8Array, flags = a.s_flags as Uint8Array, name = a.s_name as Uint16Array;
  const tile = a.s_tile as Int32Array, edge = a.s_edge as Uint32Array;
  const names = t.header.names ?? [];
  const n = cls.length;
  const bn = new Float32Array(n);
  const geo = new Float32Array(n * 4);
  const bnByName = names.map((s) => bottleneckOf(s));
  majorsKey = new Map();
  for (let i = 0; i < n; i++) {
    bn[i] = name[i] === 0xffff ? 0 : bnByName[name[i]];
    const a0 = off[i] * 3, a1 = (off[i + 1] - 1) * 3;
    const dx = xyz[a1] - xyz[a0], dy = xyz[a1 + 1] - xyz[a0 + 1];
    const l = Math.hypot(dx, dy) || 1;
    geo[i * 4] = (xyz[a0] + xyz[a1]) / 2; geo[i * 4 + 1] = (xyz[a0 + 1] + xyz[a1 + 1]) / 2;
    geo[i * 4 + 2] = dx / l; geo[i * 4 + 3] = dy / l;
    majorsKey.set(`${tile[i * 2]}_${tile[i * 2 + 1]}_${edge[i]}`, i);
  }
  majorsCount = n;
  sim.set_majors(cls, flags, bn, geo);
  const offC = new Uint32Array(off), xyzC = new Float32Array(xyz), clsC = new Uint8Array(cls), nameC = new Uint16Array(name);
  post({ type: 'majorsGeom', off: offC, xyz: xyzC, cls: clsC, names, name: nameC }, [offC.buffer, xyzC.buffer, clsC.buffer, nameC.buffer]);
}

function congestion(tod: number, weekday: number) {
  if (!sim || !majorsKey) return;
  const ratio = sim.major_ratios(tod, weekday);
  // blend in speeds measured from local agents (kept for 15 sim-minutes)
  const m = sim.measured();
  const now = tod;
  for (let i = 0; i + 3 < m.length; i += 4) {
    const s = majorsKey.get(`${m[i]}_${m[i + 1]}_${m[i + 2]}`);
    if (s !== undefined) measuredCache.set(s, { r: m[i + 3], t: now });
  }
  for (const [s, v] of measuredCache) {
    if (Math.abs(now - v.t) > 900) { measuredCache.delete(s); continue; }
    if (s < majorsCount) ratio[s] = Math.round(ratio[s] * 0.35 + v.r * 255 * 0.65);
  }
  post({ type: 'majorsRatio', ratio, tod }, [ratio.buffer]);
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init': {
        const wasm = await init();
        memory = wasm.memory;
        sab = m.sab;
        hdr = new Int32Array(sab, 0, 64);
        hf = new Float64Array(sab, 0, HF_COUNT);
        dataRoot = m.dataRoot;
        build = m.build;
        if (m.tiles.length) available = new Set(m.tiles.map(([x, y]) => key(x, y)));
        sim = new Sim((Math.random() * 1e9) >>> 0, MAX_CARS - 64, MAX_PEDS - 64);
        post({ type: 'ready' });
        break;
      }
      case 'tick': tick(m); break;
      case 'stops': sim?.set_stops(m.xyz); break;
      case 'spawnPlayer': {
        const ok = sim?.spawn_player(m.e, m.n, m.heading) ?? false;
        lastRoad = undefined;
        playerInfo();
        post({ type: 'player', roadName: lastRoad ?? null, ok });
        break;
      }
      case 'takeOver': {
        const ok = sim?.take_over(m.id) ?? false;
        lastRoad = undefined;
        playerInfo();
        post({ type: 'player', roadName: lastRoad ?? null, ok });
        break;
      }
      case 'releasePlayer': sim?.release_player(); playerInfo(); break;
      case 'majors': await loadMajors(); break;
      case 'railPlayer': post({ type: 'railPlayer', ok: sim?.rail_player_attach(m.feed, m.trip) ?? false }); break;
      case 'railRelease': sim?.rail_player_release(); break;
      case 'congestion': congestion(m.tod, m.weekday); break;
    }
  } catch (e) {
    console.error('[sim]', e);
    post({ type: 'error', message: String((e as Error)?.message ?? e) });
    recover(e);
  }
};

/** A Rust panic poisons the Sim object: start over with a fresh one (tiles reload). */
function recover(e: unknown) {
  if (!(e instanceof WebAssembly.RuntimeError) || !sim) return;
  const hadMajors = !!majorsKey;
  try { sim.free(); } catch { /* poisoned */ }
  sim = new Sim((Math.random() * 1e9) >>> 0, MAX_CARS - 64, MAX_PEDS - 64);
  loaded.clear();
  majorsKey = null;
  railNetLoaded = null;
  railProfile = '';
  if (hadMajors) void loadMajors();
  console.warn('[sim] recovered from a simulation panic');
}
