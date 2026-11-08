import * as THREE from 'three/webgpu';
import type { Mat } from '../core/assets';
import type { Built, LinearOut, TrackOut } from '../core/model';
import { flat, material, terrainVC } from './materials';

const LAND: Record<number, number> = {
  0: 0x8d9a62, 1: 0x5f87a3, 2: 0x6f9149, 3: 0x4f6435, 4: 0x7d9655, 5: 0x8a8781, 6: 0x86827a, 7: 0x9c9862, 8: 0xd2c39a,
  9: 0x77746e, 10: 0x857d72, 11: 0x6d6b67, 12: 0x76935a, 13: 0x6a9a4a, 15: 0x77746e, 16: 0x67744d, 17: 0x7f9a58,
  18: 0x96866a, 19: 0x5a9142, 21: 0xa9a49a, 23: 0x8aa864,
};
import { PropsView } from './props';

let OX = 0, OY = 0;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x - OX, z, -(y - OY));

export class NetView {
  group = new THREE.Group();
  props: PropsView;
  private ground?: Uint8Array;
  private stride: number;
  private crop: number;
  constructor(b: Built, origin = { x: 0, y: 0 }, ground?: Uint8Array, stride = 1, crop = 0) {
    OX = origin.x; OY = origin.y;
    this.ground = ground;
    this.stride = stride;
    this.crop = crop;
    for (const [m, buf] of b.meshes) this.group.add(this.mesh(m, buf));
    if (b.terrain) this.group.add(this.terrain(b.terrain));
    this.group.add(this.tracks(b.tracks));
    this.group.add(this.linear(b.linear));
    this.props = new PropsView(b.props, v3);
    this.group.add(this.props.group);
  }

  private mesh(m: Mat, buf: { pos: Float32Array; uv: Float32Array; idx: Uint32Array }) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(buf.pos.length);
    for (let i = 0; i < buf.pos.length; i += 3) { p[i] = buf.pos[i]; p[i + 1] = buf.pos[i + 2]; p[i + 2] = -buf.pos[i + 1]; }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(buf.uv, 2));
    g.setIndex(new THREE.BufferAttribute(buf.idx, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material(m));
    mesh.receiveShadow = true;
    mesh.castShadow = m === 'deck' || m === 'wall' || m === 'curb' || m === 'pier';
    mesh.name = m;
    return mesh;
  }

  private terrain(t0: NonNullable<Built['terrain']>) {
    const st = this.stride;
    const t = st === 1 ? { ...t0 } : (() => {
      const nx = Math.floor((t0.nx - 1) / st) + 1, ny = Math.floor((t0.ny - 1) / st) + 1;
      const h = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let m = Infinity;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const jj = Math.min(t0.ny - 1, Math.max(0, j * st + dj)), ii = Math.min(t0.nx - 1, Math.max(0, i * st + di));
          m = Math.min(m, t0.h[jj * t0.nx + ii]);
        }
        h[j * nx + i] = m;
      }
      return { ...t0, nx, ny, cell: t0.cell * st, h };
    })();
    if (this.crop) {
      const i0 = Math.max(0, Math.round((OX - t.x0) / t.cell)), j0 = Math.max(0, Math.round((OY - t.y0) / t.cell));
      const i1 = Math.min(t.nx - 1, Math.round((OX + this.crop - t.x0) / t.cell)), j1 = Math.min(t.ny - 1, Math.round((OY + this.crop - t.y0) / t.cell));
      const nx = i1 - i0 + 1, ny = j1 - j0 + 1;
      const h = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = t.h[(j + j0) * t.nx + i + i0];
      Object.assign(t, { x0: t.x0 + i0 * t.cell, y0: t.y0 + j0 * t.cell, nx, ny, h });
    }
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(t.nx * t.ny * 3);
    for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
      const k = (j * t.nx + i) * 3;
      pos[k] = t.x0 - OX + i * t.cell; pos[k + 1] = t.h[j * t.nx + i]; pos[k + 2] = -(t.y0 - OY + j * t.cell);
    }
    const idx = new Uint32Array((t.nx - 1) * (t.ny - 1) * 6);
    let q = 0;
    for (let j = 0; j < t.ny - 1; j++) for (let i = 0; i < t.nx - 1; i++) {
      const a = j * t.nx + i, b = a + 1, c = a + t.nx, d = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = c;
      idx[q++] = b; idx[q++] = d; idx[q++] = c;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    let mat = material('terrain');
    if (this.ground) {
      const col = new Float32Array(t.nx * t.ny * 3);
      const c = new THREE.Color();
      for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
        const lx = t.x0 - OX + i * t.cell, ly = t.y0 - OY + j * t.cell;
        const gi = Math.min(255, Math.max(0, Math.floor(lx / 4))), gj = Math.min(255, Math.max(0, Math.floor(ly / 4)));
        const cls = this.ground[gj * 256 + gi];
        c.set(LAND[cls] ?? LAND[0]);
        const k = (j * t.nx + i) * 3;
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      mat = terrainVC();
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  private tracks(ts: TrackOut[]) {
    const grp = new THREE.Group();
    const railPos: number[] = [], grooves: number[] = [];
    const ties: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    for (const t of ts) {
      const half = t.gauge / 2 + 0.036;
      const pts = t.pts;
      for (const side of [-1, 1]) {
        const off = pts.map((p, i) => {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
          return { x: p.x - (dy / l) * half * side, y: p.y + (dx / l) * half * side, z: p.z, nx: -dy / l, ny: dx / l };
        });
        if (t.flush) {
          sweep(grooves, off, 0.11, 0.012, 0.0);
          sweep(railPos, off, 0.07, 0.016, 0.0);
        } else {
          sweep(railPos, off, 0.072, 0.17, 0.17);
        }
      }
      if (!t.flush && t.kind !== 'grass' && t.kind !== 'slab') {
        let acc = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const seg = Math.hypot(b.x - a.x, b.y - a.y);
          let s = (0.6 - acc) % 0.6;
          while (s <= seg) {
            const f = s / Math.max(1e-6, seg);
            const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, z = a.z + (b.z - a.z) * f;
            dummy.position.copy(v3(x, y, z - 0.17 - 0.09));
            dummy.rotation.set(0, Math.atan2(b.y - a.y, b.x - a.x), 0);
            dummy.updateMatrix();
            ties.push(dummy.matrix.clone());
            s += 0.6;
          }
          acc = (acc + seg) % 0.6;
        }
      }
    }
    const mk = (arr: number[], m: THREE.Material) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };
    if (railPos.length) grp.add(mk(railPos, material('rail')));
    if (grooves.length) grp.add(mk(grooves, flat(0x151515, 0.9)));
    if (ties.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.18, 2.6), material('tie'), ties.length);
      ties.forEach((m, i) => im.setMatrixAt(i, m));
      im.receiveShadow = true;
      im.castShadow = true;
      grp.add(im);
    }
    return grp;
  }

  private linear(ls: LinearOut[]) {
    const grp = new THREE.Group();
    const by = new Map<string, number[]>();
    for (const l of ls) {
      const arr = by.get(l.kind) ?? [];
      const pts = l.pts.map((p, i) => {
        const a = l.pts[Math.max(0, i - 1)], b = l.pts[Math.min(l.pts.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        return { x: p.x, y: p.y, z: p.z, nx: -dy / len, ny: dx / len };
      });
      const w = l.kind === 'jersey' ? 0.6 : l.kind === 'parapet' ? 0.35 : l.kind === 'fence' ? 0.05 : 0.08;
      sweep(arr, pts, w, l.h, l.h);
      by.set(l.kind, arr);
    }
    for (const [k, arr] of by) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeVertexNormals();
      const m = k === 'handrail' || k === 'fence' ? flat(0x5b5e62, 0.6, 0.4) : material('barrier');
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      grp.add(mesh);
    }
    return grp;
  }
}

function sweep(out: number[], pts: { x: number; y: number; z: number; nx: number; ny: number }[], w: number, top: number, h: number) {
  const hw = w / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const c = (p: typeof a, s: number, dz: number) => v3(p.x + p.nx * hw * s, p.y + p.ny * hw * s, p.z + dz);
    const aL = c(a, 1, top), aR = c(a, -1, top), bL = c(b, 1, top), bR = c(b, -1, top);
    const aLb = c(a, 1, top - h), aRb = c(a, -1, top - h), bLb = c(b, 1, top - h), bRb = c(b, -1, top - h);
    const quad = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3) => {
      out.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z, p.x, p.y, p.z, r.x, r.y, r.z, s.x, s.y, s.z);
    };
    quad(aR, bR, bL, aL);
    if (h > 0.001) {
      quad(aRb, bRb, bR, aR);
      quad(bLb, aLb, aL, bL);
    }
  }
}
