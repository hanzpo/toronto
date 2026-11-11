import { build } from '../core/build';
import type { NetDesc } from '../core/desc';
import { loadTile } from '../tiles';
import { simJson } from './encode';
import initSim, { World } from './pkg/netsim';
import { LaneIndex, matchTrip, type TripKind } from './match';

export interface TripIn { trip: number; kind: TripKind; variant: number; pts: Float32Array; dist: Float32Array; at: number; v: number; stops: { dist: number; dep: number }[] }

export type SimIn =
  | { type: 'region'; root: string; tiles: [number, number][]; seed: number; speed: number }
  | { type: 'speed'; speed: number }
  | { type: 'trips'; clock: number; trips: TripIn[] }
  | { type: 'take'; id: number; x: number; y: number; r: number }
  | { type: 'input'; throttle: number; brake: number; steer: number; handbrake: boolean; ground: number }
  | { type: 'release' }
  | { type: 'walker'; x: number; y: number; z: number }
  | { type: 'clearWalker' }
  | { type: 'drop'; trip: number };

export interface SimReply { type: 'reply'; id: number; ok: boolean; player: number[] }
export interface SimRegion { type: 'region'; trips: number[] }

export interface SimTrips { type: 'trips'; accepted: number[]; done: number[] }

export interface SimFrame { type: 'frame'; agents: Float32Array; nodes: string[]; sig: Uint8Array; groups: Uint8Array; gates: Float32Array; t: number; player: number[]; stamp: number }

let world: World | null = null;
let index: LaneIndex | null = null;
let keys: string[] = [];

const laneKey = (l: { kind: string; pts: { x: number; y: number }[] }) => {
  const a = l.pts[0], b = l.pts[l.pts.length - 1];
  return `${l.kind}|${a.x.toFixed(1)},${a.y.toFixed(1)}|${b.x.toFixed(1)},${b.y.toFixed(1)}`;
};
let nodes: string[] = [];
let groupsPer: number[] = [];
let speed = 1;
let gen = 0;
const ready = initSim();

async function region(root: string, tiles: [number, number][], seed: number) {
  const my = ++gen;
  const descs = (await Promise.all(tiles.map(([x, y]) => loadTile(root, x, y)))).filter((d): d is NonNullable<typeof d> => !!d);
  if (my !== gen) return;
  const nmap = new Map<string, NetDesc['nodes'][number]>(), smap = new Map<string, NetDesc['segments'][number]>(), amap = new Map<string, object>();
  for (const d of descs) {
    for (const n of d.nodes) nmap.set(n.id, n);
    for (const s of d.segments) smap.set(s.id, s);
    for (const a of d.assets ?? []) amap.set((a as { id: string }).id, a);
  }
  const desc: NetDesc = { nodes: [...nmap.values()], segments: [...smap.values()], assets: [...amap.values()] as NetDesc['assets'] };
  const b = build(desc, { lanesOnly: true });
  await ready;
  if (my !== gen) return;
  const old = world;
  const oldKeys = keys;
  world = new World(simJson(b), seed);
  index = new LaneIndex(b.lanes);
  keys = b.lanes.map(laneKey);
  let carried = 0;
  if (old) {
    const at = new Map(keys.map((k, i) => [k, i]));
    const map = Int32Array.from(oldKeys, (k) => at.get(k) ?? -1);
    world.set_clock(old.clock());
    carried = world.import_state(old.export_state(), map);
    world.import_free(old.export_free());
    old.free();
  }
  nodes = b.nodes.map((n) => n.id);
  groupsPer = nodes.map((id) => b.signals.find((s) => s.node === id)?.groups.length ?? 0);
  let drive = 0, walk = 0;
  for (const l of b.lanes) {
    if (l.node) continue;
    let len = 0;
    for (let i = 1; i < l.pts.length; i++) len += Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].y - l.pts[i - 1].y);
    if (l.kind === 'drive') drive += len; else if (l.kind === 'walk') walk += len;
  }
  const target = [Math.round(drive / 70), Math.round(drive / 2500), 0, 0, Math.round(walk / 60)] as const;
  if (carried) world.set_targets(...target);
  else {
    world.populate(...target);
    for (let i = 0; i < 300; i++) world.step(0.1);
  }
  (self as unknown as Worker).postMessage({ type: 'region', trips: [...world.trips()] } satisfies SimRegion);
}

self.onmessage = (ev: MessageEvent<SimIn>) => {
  const m = ev.data;
  if (m.type === 'region') void region(m.root, m.tiles, m.seed);
  if (m.type === 'speed') speed = m.speed;
  if (m.type === 'take') { const ok = !!world?.take_over_nearest(m.x, m.y, m.r); (self as unknown as Worker).postMessage({ type: 'reply', id: m.id, ok, player: world ? [...world.player()] : [] } satisfies SimReply); }
  if (m.type === 'input') world?.set_player_input(m.throttle, m.brake, m.steer, m.handbrake, m.ground);
  if (m.type === 'release') world?.release_player();
  if (m.type === 'walker') world?.set_walker(m.x, m.y, m.z);
  if (m.type === 'clearWalker') world?.clear_walker();
  if (m.type === 'drop') world?.drop_trip(m.trip);
  if (m.type === 'trips' && world && index) {
    world.set_clock(m.clock);
    const accepted: number[] = [];
    for (const t of m.trips) {
      if (world.has_trip(t.trip)) { accepted.push(t.trip); continue; }
      const r = matchTrip(index, t.kind, t.pts, t.dist, t.at, t.stops);
      if (!r || r.lanes.length < 2) continue;
      if (world.add_trip(t.kind, t.variant, t.trip, Uint32Array.from(r.lanes), Int8Array.from(r.dirs), r.d, t.v, Uint32Array.from(r.stopStep), Float32Array.from(r.stopD), Float64Array.from(r.stopDep))) accepted.push(t.trip);
    }
    const out: SimTrips = { type: 'trips', accepted, done: [...world.take_done()] };
    (self as unknown as Worker).postMessage(out);
  }
};

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000) * speed;
  last = now;
  if (!world) return;
  let left = dt;
  while (left > 1e-4) { const h = Math.min(0.05, left); world.step(h); left -= h; }
  const agents = new Float32Array(world.frame2());
  const sig = new Uint8Array(nodes.length * 4);
  for (let n = 0; n < nodes.length; n++) for (let g = 0; g < Math.min(4, groupsPer[n] || 1); g++) sig[n * 4 + g] = world.signal(n, g);
  const gates = new Float32Array(nodes.length);
  for (let n = 0; n < nodes.length; n++) gates[n] = world.gate(n);
  const msg: SimFrame = { type: 'frame', agents, nodes, sig, groups: Uint8Array.from(groupsPer), gates, t: world.time(), player: [...world.player()], stamp: performance.timeOrigin + performance.now() };
  (self as unknown as Worker).postMessage(msg, [agents.buffer, sig.buffer, gates.buffer]);
}, 33);
