import { build } from '../core/build';
import type { NetDesc } from '../core/desc';
import { loadTile } from '../tiles';
import { simJson } from './encode';
import initSim, { World } from './pkg/netsim';

export type SimIn =
  | { type: 'region'; root: string; tiles: [number, number][]; seed: number; speed: number }
  | { type: 'speed'; speed: number };

export interface SimFrame { type: 'frame'; agents: Float32Array; nodes: string[]; sig: Uint8Array; groups: Uint8Array; gates: Float32Array; t: number }

let world: World | null = null;
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
  world?.free();
  world = new World(simJson(b), seed);
  nodes = b.nodes.map((n) => n.id);
  groupsPer = nodes.map((id) => b.signals.find((s) => s.node === id)?.groups.length ?? 0);
  let drive = 0, walk = 0;
  for (const l of b.lanes) {
    if (l.node) continue;
    let len = 0;
    for (let i = 1; i < l.pts.length; i++) len += Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].y - l.pts[i - 1].y);
    if (l.kind === 'drive') drive += len; else if (l.kind === 'walk') walk += len;
  }
  world.populate(Math.round(drive / 70), Math.round(drive / 2500), 0, 0, Math.round(walk / 60));
  for (let i = 0; i < 300; i++) world.step(0.1);
}

self.onmessage = (ev: MessageEvent<SimIn>) => {
  const m = ev.data;
  if (m.type === 'region') void region(m.root, m.tiles, m.seed);
  if (m.type === 'speed') speed = m.speed;
};

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000) * speed;
  last = now;
  if (!world) return;
  let left = dt;
  while (left > 1e-4) { const h = Math.min(0.05, left); world.step(h); left -= h; }
  const agents = new Float32Array(world.frame());
  const sig = new Uint8Array(nodes.length * 4);
  for (let n = 0; n < nodes.length; n++) for (let g = 0; g < Math.min(4, groupsPer[n] || 1); g++) sig[n * 4 + g] = world.signal(n, g);
  const gates = new Float32Array(nodes.length);
  for (let n = 0; n < nodes.length; n++) gates[n] = world.gate(n);
  const msg: SimFrame = { type: 'frame', agents, nodes, sig, groups: Uint8Array.from(groupsPer), gates, t: world.time() };
  (self as unknown as Worker).postMessage(msg, [agents.buffer, sig.buffer, gates.buffer]);
}, 33);
