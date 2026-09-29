// Traffic simulation worker: streams road-graph tiles around the focus into
// the Rust/wasm `Sim`, steps it for every render tick and publishes agent
// snapshots into a SharedArrayBuffer (see protocol.ts for the layout).
import init, { Sim } from './pkg/sim.js';
import { decodeTbn, type Tbn } from '../data/tbn';
import {
  bottleneckOf, CAR_STRIDE, H, HEADER_BYTES, HF, MAX_CARS, MAX_PEDS, PED_STRIDE, SLOT_BYTES, SLOT_HEADER, SLOTS,
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
  const si = new Int32Array(sab, base, 2);
  const sf = new Float64Array(sab, base, 4);
  si[0] = nc; si[1] = np;
  sf[1] = m.originE; sf[2] = m.originN; sf[3] = m.simMs;
  Atomics.store(hdr, H.SLOT, slot);
  Atomics.add(hdr, H.SEQ, 1);
}

function playerInfo() {
  if (!sim) return;
  const p = sim.player_state();
  for (let i = 0; i < 12 && i < p.length; i++) hf[HF.PLAYER + i] = p[i];
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
      const pl = m.player;
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
      sim.write_output(m.originE, m.originN);
      const ms = performance.now() - t0;
      stepAvg = stepAvg ? stepAvg * 0.95 + ms * 0.05 : ms;
      hf[HF.STEP_MS] = ms;
      hf[HF.STEP_AVG] = stepAvg;
      Atomics.store(hdr, H.SUBSTEPS, k);
      Atomics.store(hdr, H.FAST, fast ? 1 : 0);
      const st = sim.stats();
      hf[HF.TARGET_CARS] = st[0];
      hf[HF.TARGET_PEDS] = st[1];
      playerInfo();
      publish(m);
    }
  } finally {
    Atomics.store(hdr, H.BUSY, 0);
    Atomics.add(hdr, H.ACK, 1);
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
        hf = new Float64Array(sab, 0, 32);
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
  if (hadMajors) void loadMajors();
  console.warn('[sim] recovered from a simulation panic');
}
