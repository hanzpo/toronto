import earcut from 'earcut';
import type { Mat } from './assets';
import type { V2 } from './geom';

export interface P3 { x: number; y: number; z: number }

export class MeshBuf {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  get count() { return this.pos.length / 3; }

  vert(x: number, y: number, z: number, u: number, v: number) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }
}

export class Sink {
  bufs = new Map<Mat, MeshBuf>();
  private scratch = new MeshBuf();
  mute = false;

  buf(m: Mat) {
    if (this.mute) { this.scratch.pos.length = 0; this.scratch.uv.length = 0; this.scratch.idx.length = 0; return this.scratch; }
    let b = this.bufs.get(m);
    if (!b) { b = new MeshBuf(); this.bufs.set(m, b); }
    return b;
  }

  strip(m: Mat, a: (P3 & { s?: number })[], b: (P3 & { s?: number })[], va = 0, vb = 1, up = true) {
    if (a.length < 2 || b.length < 2) return;
    const buf = this.buf(m);
    const n = Math.min(a.length, b.length);
    if (a.length !== b.length) {
      this.stripUneven(m, a, b, va, vb, up);
      return;
    }
    const base = buf.count;
    for (let i = 0; i < n; i++) {
      buf.vert(a[i].x, a[i].y, a[i].z, a[i].s ?? 0, va);
      buf.vert(b[i].x, b[i].y, b[i].z, b[i].s ?? 0, vb);
    }
    for (let i = 0; i < n - 1; i++) {
      const p = base + i * 2;
      if (up) buf.idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
      else buf.idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
    }
  }

  stripUneven(m: Mat, a: (P3 & { s?: number })[], b: (P3 & { s?: number })[], va: number, vb: number, up: boolean) {
    const buf = this.buf(m);
    const ia = a.map((p) => buf.vert(p.x, p.y, p.z, p.s ?? 0, va));
    const ib = b.map((p) => buf.vert(p.x, p.y, p.z, p.s ?? 0, vb));
    const ta = cum(a), tb = cum(b);
    let i = 0, j = 0;
    const tri = (p: number, q: number, r: number) => { if (up) buf.idx.push(p, q, r); else buf.idx.push(p, r, q); };
    while (i < a.length - 1 || j < b.length - 1) {
      const advA = j >= b.length - 1 || (i < a.length - 1 && ta[i + 1] <= tb[j + 1]);
      if (advA) { tri(ia[i], ia[i + 1], ib[j]); i++; } else { tri(ia[i], ib[j + 1], ib[j]); j++; }
    }
  }

  wall(m: Mat, top: (P3 & { s?: number })[], depth: number | ((i: number) => number), outward = true) {
    const bot = top.map((p, i) => ({ ...p, z: p.z - (typeof depth === 'number' ? depth : depth(i)) }));
    const buf = this.buf(m);
    const base = buf.count;
    for (let i = 0; i < top.length; i++) {
      const u = top[i].s ?? i;
      buf.vert(top[i].x, top[i].y, top[i].z, u, top[i].z);
      buf.vert(bot[i].x, bot[i].y, bot[i].z, u, bot[i].z);
    }
    for (let i = 0; i < top.length - 1; i++) {
      const p = base + i * 2;
      if (outward) buf.idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
      else buf.idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
    }
  }

  wallBetween(m: Mat, top: P3[], bot: P3[], outward = true) {
    const buf = this.buf(m);
    const base = buf.count;
    let u = 0;
    for (let i = 0; i < top.length; i++) {
      if (i > 0) u += Math.hypot(top[i].x - top[i - 1].x, top[i].y - top[i - 1].y);
      buf.vert(top[i].x, top[i].y, top[i].z, u, top[i].z);
      buf.vert(bot[i].x, bot[i].y, bot[i].z, u, bot[i].z);
    }
    for (let i = 0; i < top.length - 1; i++) {
      const p = base + i * 2;
      if (outward) buf.idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
      else buf.idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
    }
  }

  poly(m: Mat, ring: P3[], holes: P3[][] = []) {
    if (ring.length < 3) return;
    const all = [ring, ...holes];
    const flat: number[] = [];
    const holeIdx: number[] = [];
    for (let k = 0; k < all.length; k++) {
      if (k > 0) holeIdx.push(flat.length / 2);
      for (const p of all[k]) flat.push(p.x, p.y);
    }
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    const buf = this.buf(m);
    const base = buf.count;
    for (const r of all) for (const p of r) buf.vert(p.x, p.y, p.z, p.x, p.y);
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b = tris[i + 1], c = tris[i + 2];
      const cz = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      if (cz >= 0) buf.idx.push(base + a, base + b, base + c);
      else buf.idx.push(base + a, base + c, base + b);
    }
  }

  quad(m: Mat, a: P3, b: P3, c: P3, d: P3) {
    const buf = this.buf(m);
    const i0 = buf.vert(a.x, a.y, a.z, 0, 0), i1 = buf.vert(b.x, b.y, b.z, 1, 0);
    const i2 = buf.vert(c.x, c.y, c.z, 1, 1), i3 = buf.vert(d.x, d.y, d.z, 0, 1);
    buf.idx.push(i0, i1, i2, i0, i2, i3);
  }

  box(m: Mat, c: P3, dir: V2, l: number, w: number, h: number) {
    const ux = dir.x * l / 2, uy = dir.y * l / 2, vx = -dir.y * w / 2, vy = dir.x * w / 2;
    const corners = [
      { x: c.x - ux - vx, y: c.y - uy - vy }, { x: c.x + ux - vx, y: c.y + uy - vy },
      { x: c.x + ux + vx, y: c.y + uy + vy }, { x: c.x - ux + vx, y: c.y - uy + vy },
    ];
    const top = corners.map((p) => ({ ...p, z: c.z + h }));
    this.quad(m, top[0], top[1], top[2], top[3]);
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      this.quad(m, { ...a, z: c.z }, { ...b, z: c.z }, { ...b, z: c.z + h }, { ...a, z: c.z + h });
    }
  }
}

function cum(p: P3[]) {
  const out = [0];
  for (let i = 1; i < p.length; i++) out.push(out[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y));
  const t = out[out.length - 1] || 1;
  return out.map((v) => v / t);
}

