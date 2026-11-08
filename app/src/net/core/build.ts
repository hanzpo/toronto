import { asset as getAsset, layout, oneway, registerAssets, type Asset } from './assets';
import type { NetDesc, SegDesc } from './desc';
import { type V2, add, angle, left, mul, norm, sub, dist } from './geom';
import { Path, fillet, hermite, profileFn } from './path';
import { Sink } from './mesh';
import type { Built, Leg, LegBand, Node, Seg } from './model';
import { Ctx } from './ctx';
import { classify, setbacks, buildNode } from './nodes';
import { buildSegment } from './segments';
import { resolveStructures } from './structures';
import { conformTerrain } from './terrain';
import { linkLanes } from './lanes';

export function legBands(seg: Seg, end: 'a' | 'b'): LegBand[] {
  if (end === 'a') return seg.lay.map((b) => ({ band: b.band, l: b.l, r: b.r, hl: b.hl, hr: b.hr }));
  return [...seg.lay].reverse().map((b) => ({ band: b.band, l: -b.r, r: -b.l, hl: b.hr, hr: b.hl }));
}

function segGeometry(d: SegDesc, a: Asset, pa0: V2, pb0: V2): V2[] {
  const inner = d.pts ?? [];
  const da = norm(sub(inner[0] ?? pb0, pa0)), db = norm(sub(pb0, inner[inner.length - 1] ?? pa0));
  const pa = d.offA ? add(pa0, mul(left(da), d.offA)) : pa0;
  const pb = d.offB ? add(pb0, mul(left(db), d.offB)) : pb0;
  const ctrl = [pa, ...inner, pb];
  if (d.curve === 'raw') return ctrl;
  if (d.curve === 'hermite' || d.ta || d.tb) {
    if ((d.pts ?? []).length === 0) {
      const ta = d.ta ?? norm(sub(pb, pa)), tb = d.tb ?? norm(sub(pb, pa));
      return hermite(pa, ta, pb, tb);
    }
  }
  return fillet(ctrl, d.r ?? Math.max(a.rh, 8));
}

export function build(desc: NetDesc, opts: { origin?: { x: number; y: number } } = {}): Built {
  if (desc.assets) registerAssets(desc.assets);
  const ctx = new Ctx(desc);
  const nodes = new Map<string, Node>();
  for (const nd of desc.nodes) nodes.set(nd.id, { desc: nd, p: { x: nd.x, y: nd.y }, z: nd.z, legs: [], kind: 'end', control: nd.control ?? 'auto' });
  const segs: Seg[] = [];
  for (const sd of desc.segments) {
    const a = getAsset(sd.asset);
    const na = nodes.get(sd.a), nb = nodes.get(sd.b);
    if (!na || !nb) throw new Error(`segment ${sd.id}: missing node`);
    const pts = segGeometry(sd, a, na.p, nb.p);
    const tmp = new Path(pts, () => 0);
    const L = tmp.length;
    const ctrl = [{ s: 0, z: na.z }, ...(sd.z ?? []).map((q) => ({ s: q.s <= 1 && q.s >= 0 && L > 1 ? q.s * L : q.s, z: q.z })), { s: L, z: nb.z }];
    const zf = profileFn(ctrl, a.rv);
    const path = new Path(pts, zf);
    const seg = { desc: sd, asset: a, path, lay: layout(a), dir: sd.dir ?? (a.family === 'rail' || a.family === 'subway' ? 'both' : 'fwd') } as Seg;
    seg.legA = makeLeg(seg, 'a', na);
    seg.legB = makeLeg(seg, 'b', nb);
    na.legs.push(seg.legA);
    nb.legs.push(seg.legB);
    segs.push(seg);
  }
  ctx.segs = segs;
  ctx.nodes = [...nodes.values()];
  for (const n of ctx.nodes) {
    const key = (l: (typeof n.legs)[number]) => Math.atan2(l.o.y + l.u.y * 25 - n.p.y, l.o.x + l.u.x * 25 - n.p.x);
    n.legs.sort((p, q) => key(p) - key(q));
    classify(ctx, n);
  }
  for (const n of ctx.nodes) setbacks(ctx, n);
  resolveStructures(ctx);
  const ownS = desc.own ? new Set(desc.own.segs) : null, ownN = desc.own ? new Set(desc.own.nodes) : null;
  const guarded = (owned: boolean, f: () => void) => {
    if (owned) { f(); return; }
    const np = ctx.props.length, nt = ctx.tracks.length, nl = ctx.linear.length, nf = ctx.footprints.length;
    ctx.sink.mute = true;
    f();
    ctx.sink.mute = false;
    ctx.props.length = np; ctx.tracks.length = nt; ctx.linear.length = nl; ctx.footprints.length = nf;
  };
  for (const s of segs) guarded(!ownS || ownS.has(s.desc.id), () => buildSegment(ctx, s));
  for (const n of ctx.nodes) guarded(!ownN || ownN.has(n.desc.id), () => buildNode(ctx, n));
  linkLanes(ctx);
  if (desc.terrain) {
    const keepF = ctx.footprints;
    conformTerrain(ctx, desc.terrain);
    ctx.footprints = keepF;
  }
  return ctx.finish(opts.origin);
}

function makeLeg(seg: Seg, end: 'a' | 'b', node: Node): Leg {
  const p = seg.path;
  const o = end === 'a' ? { x: p.x[0], y: p.y[0] } : { x: p.x[p.n - 1], y: p.y[p.n - 1] };
  const look = Math.min(2, p.length / 2);
  const f = p.at(end === 'a' ? look : p.length - look);
  const u = end === 'a' ? { x: f.tx, y: f.ty } : { x: -f.tx, y: -f.ty };
  const bands = legBands(seg, end);
  const carr = bands.filter((b) => ['lane', 'parking', 'bike', 'shoulder', 'median', 'row', 'row_edge', 'barrier', 'track', 'path', 'platform'].includes(b.band.kind));
  const curbL = carr.length ? carr[0].l : bands[0].l;
  const curbR = carr.length ? carr[carr.length - 1].r : bands[bands.length - 1].r;
  return {
    seg, end, node, o, u, n: left(u), ang: angle(u), bands, curbL, curbR, rowL: bands[0].l, rowR: bands[bands.length - 1].r,
    setback: 0, cut: null, tStop: 0, tExit: 0, markEnd: 0, crosswalk: false, z: node.z,
  };
}

export function legS(l: Leg, t: number) {
  return l.end === 'a' ? t : l.seg.path.length - t;
}

export function legPt(l: Leg, t: number, lat: number): { x: number; y: number; z: number } {
  const f = l.seg.path.at(legS(l, t));
  const u = l.end === 'a' ? { x: f.tx, y: f.ty } : { x: -f.tx, y: -f.ty };
  const n = left(u);
  return { x: f.x + n.x * lat, y: f.y + n.y * lat, z: f.z };
}

export function legDir(l: Leg, t: number): V2 {
  const f = l.seg.path.at(legS(l, t));
  return l.end === 'a' ? { x: f.tx, y: f.ty } : { x: -f.tx, y: -f.ty };
}

export { add, mul, dist, oneway, Sink };
