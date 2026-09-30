// Handcrafted airport surfaces (docs/AIR.md "Surfaces"): clean runway
// rectangles with procedural TP 312 markings, filleted taxiways, apron slabs,
// yellow taxi/hold/stand markings and night lighting, from
// data/air/surfaces.bin.gz (pipeline/tpipe/airports.py).
//
// Draw calls per visible airport: runway + pavement (always, up to FAR_*),
// markings + lights only within DETAIL m of the camera (built on demand,
// released beyond DETAIL_DROP). Vertex data is relative to each airport's
// 64 m-aligned origin (f32-safe); the scene itself is world-space.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { fetchTbn, type TypedArray } from '../data/tbn';
import { lightMaterial, markingMaterial, pavementMaterial, runwayMaterial, terminalMaterial } from '../air/surfaces/materials';
import { labelGeometry } from '../air/apron/labels';
import { ApronFurniture } from '../air/apron/ApronFurniture';
import type { AirSystem } from '../air/AirSystem';
import { CULL } from '../engine/view';
import { releaseObject } from '../engine/dispose';

interface AirportMeta {
  key: string;
  icao: string | null;
  name: string | null;
  origin: [number, number];
  bbox: [number, number, number, number];
  runways: { des: string; len: number; width: number; disp: number[]; kind: number }[];
  /** [vertexOffset, vertexCount, indexOffset, indexCount] */
  rw: number[]; pv: number[]; mk: number[];
  /** terminal / hangar massing missing from the tiles (v2) */
  tm?: number[];
  /** [offset, count] */
  lt: number[];
  /** apron furniture rows [offset, count] (v2): jet bridges (9 floats), GSE (5), masts (3) */
  jb?: number[]; gse?: number[]; mast?: number[];
  /** service-road paths for moving GSE: [first path, count] into sr_off / sr_xyz */
  sr?: number[];
  /** stand numbers: [ref, x, h, z, bearing] (origin-relative) */
  labels?: [string, number, number, number, number][];
}

const DETAIL = 15000; // markings + lights within this distance of the airport bbox
const DETAIL_DROP = 18000;
/** apron ground equipment (tugs, carts, loaders: 2–4 m) within this distance of the airport bbox */
const GSE_FAR = CULL ? 2200 : Infinity;
const FAR_MAJOR = 90000; // airports with a ≥ 1500 m paved runway
const FAR_MINOR = 25000;

interface Entry {
  meta: AirportMeta;
  major: boolean;
  root: THREE.Group;
  base: THREE.Mesh[];
  detail: THREE.Object3D[] | null;
  apron: ApronFurniture | null;
}

export class AirportLayer implements Layer {
  readonly id = 'airports';
  private engine!: Engine;
  private root = new THREE.Group();
  private entries: Entry[] = [];
  private arrays: Record<string, TypedArray> = {};
  private detailOn = true;
  private mats!: { rw: THREE.Material; pv: THREE.Material; mk: THREE.Material; tm: THREE.Material };

  async init(engine: Engine) {
    this.engine = engine;
    this.root.name = 'airports';
    engine.scene.add(this.root);
    const q = new URLSearchParams(location.search).get('airports'); // debug: 0 = off, base = no markings/lights
    if (q === '0') return;
    this.detailOn = q !== 'base';
    let tbn;
    try {
      tbn = await fetchTbn<{ airports: AirportMeta[] }>(`${engine.dataRoot}/air/surfaces.bin.gz`);
    } catch (e) {
      console.warn('airport surfaces unavailable', e);
      return;
    }
    if (!tbn) return;
    this.arrays = tbn.arrays;
    this.mats = { rw: runwayMaterial(), pv: pavementMaterial(), mk: markingMaterial(), tm: terminalMaterial() };
    for (const meta of tbn.header.airports) {
      const root = new THREE.Group();
      root.name = `airport:${meta.icao ?? meta.key}`;
      root.visible = false;
      this.root.add(root);
      const base: THREE.Mesh[] = [];
      const pv = this.mesh('pv', meta.pv, [['ps', 1, 'u8']], this.mats.pv, meta.key);
      if (pv) { pv.renderOrder = -2; base.push(pv); }
      const rw = this.mesh('rw', meta.rw, [['ra', 4], ['rb', 4], ['rc', 4]], this.mats.rw, meta.key);
      if (rw) { rw.renderOrder = -1; base.push(rw); }
      for (const m of base) { m.receiveShadow = true; root.add(m); }
      const tm = meta.tm ? this.mesh('tm', meta.tm, [['tm', 4]], this.mats.tm, meta.key) : null;
      if (tm) {
        flatNormals(tm.geometry);
        tm.castShadow = tm.receiveShadow = true;
        base.push(tm);
        root.add(tm);
      }
      const major = meta.runways.some((r) => r.kind !== 2 && r.len >= 1500);
      this.entries.push({ meta, major, root, base, detail: null, apron: null });
    }
    Object.assign(window as object, { __airports: this });
  }

  /** build one mesh from a slice of the packed arrays; attrs: [name, itemSize, srcType?] (sequential in `<tag>_attr`) */
  private mesh(tag: string, r: number[], attrs: [string, number, string?][], mat: THREE.Material, key: string): THREE.Mesh | null {
    const [v0, nv, i0, ni] = r;
    if (!nv || !ni) return null;
    const A = this.arrays;
    const g = new THREE.BufferGeometry();
    const pos = (A[`${tag}_pos`] as Float32Array).subarray(v0 * 3, (v0 + nv) * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const nrm = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) nrm[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const stride = attrs.reduce((s, a) => s + a[1], 0);
    const src = A[`${tag}_attr`];
    const raw = src.subarray(v0 * stride, (v0 + nv) * stride);
    let off = 0;
    for (const [name, size] of attrs) {
      // de-interleave into float32 (WebGPU has no 1-component 8-bit vertex format)
      const out = new Float32Array(nv * size);
      for (let i = 0; i < nv; i++) for (let c = 0; c < size; c++) out[i * size + c] = raw[i * stride + off + c];
      g.setAttribute(name, new THREE.BufferAttribute(out, size));
      off += size;
    }
    g.setIndex(new THREE.BufferAttribute((A[`${tag}_idx`] as Uint32Array).subarray(i0, i0 + ni), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = `${key}:${tag}`;
    return m;
  }

  private buildDetail(e: Entry) {
    const out: THREE.Object3D[] = [];
    const mk = this.mesh('mk', e.meta.mk, [['mk', 4]], this.mats.mk, e.meta.key);
    if (mk) { mk.renderOrder = 1; mk.receiveShadow = true; out.push(mk); }
    const [l0, nl] = e.meta.lt;
    if (nl) {
      const pos = new THREE.InstancedBufferAttribute((this.arrays.lt_pos as Float32Array).slice(l0 * 3, (l0 + nl) * 3), 3);
      const kind = new THREE.InstancedBufferAttribute(Float32Array.from((this.arrays.lt_kind as Uint8Array).subarray(l0, l0 + nl)), 1);
      const s = new THREE.Sprite(lightMaterial(pos, kind));
      s.count = nl;
      s.frustumCulled = false;
      s.renderOrder = 5;
      s.name = `${e.meta.key}:lights`;
      out.push(s);
    }
    // painted stand numbers (same material as the markings)
    const lg = e.meta.labels?.length ? labelGeometry(e.meta.labels) : null;
    if (lg) {
      const lm = new THREE.Mesh(lg, this.mats.mk);
      lm.renderOrder = 1;
      lm.receiveShadow = true;
      lm.name = `${e.meta.key}:labels`;
      out.push(lm);
    }
    for (const o of out) e.root.add(o);
    e.detail = out;
    // boarding bridges, GSE, floodlight masts
    const rows = (name: 'jb' | 'gse' | 'mast', w: number) => {
      const r = e.meta[name], a = this.arrays[name] as Float32Array | undefined;
      return r && a && r[1] ? a.subarray(r[0] * w, (r[0] + r[1]) * w) : new Float32Array(0);
    };
    const jb = rows('jb', 9), gse = rows('gse', 5), mast = rows('mast', 3);
    const paths: Float32Array[] = [];
    const sr = e.meta.sr, so = this.arrays.sr_off as Uint32Array | undefined, sx = this.arrays.sr_xyz as Float32Array | undefined;
    if (sr && so && sx) for (let i = sr[0]; i < sr[0] + sr[1]; i++) paths.push(sx.subarray(so[i] * 3, so[i + 1] * 3));
    if (jb.length || gse.length || mast.length || paths.length) {
      e.apron = new ApronFurniture({ icao: e.meta.icao, jb, gse, mast, paths, origin: e.meta.origin });
      const [x0, y0, x1, y1] = e.meta.bbox, [ox, on] = e.meta.origin;
      if (CULL) e.apron.setBounds(new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2 - ox, 40, -((y0 + y1) / 2 - on)), Math.hypot(x1 - x0, y1 - y0) / 2 + 150));
      e.root.add(e.apron.root);
    }
  }

  private dropDetail(e: Entry) {
    for (const o of e.detail ?? []) {
      e.root.remove(o);
      // sprites share one module-level geometry in three.js: never dispose it
      if ((o as THREE.Sprite).isSprite) ((o as THREE.Sprite).material as THREE.Material).dispose();
      releaseObject(o);
    }
    e.detail = null;
    if (e.apron) { e.root.remove(e.apron.root); e.apron.dispose(); e.apron = null; }
  }

  update(ctx: FrameContext) {
    const cx = ctx.cameraPos.x, cn = -ctx.cameraPos.z;
    const night = 1 - ctx.daylight;
    for (const e of this.entries) {
      const [x0, y0, x1, y1] = e.meta.bbox;
      const dx = Math.max(x0 - cx, 0, cx - x1), dy = Math.max(y0 - cn, 0, cn - y1);
      const d = Math.hypot(dx, dy, Math.max(0, ctx.cameraPos.y - 300) * 0.5);
      const vis = d < (e.major ? FAR_MAJOR : FAR_MINOR);
      e.root.visible = vis;
      if (!vis) { if (e.detail) this.dropDetail(e); continue; }
      e.root.position.set(e.meta.origin[0], 0, -e.meta.origin[1]); // scene is world-space; vertex data is origin-relative
      if (d < DETAIL && !e.detail && this.detailOn) this.buildDetail(e);
      else if (d > DETAIL_DROP && e.detail) this.dropDetail(e);
      if (e.detail) for (const o of e.detail) if ((o as THREE.Sprite).isSprite) o.visible = night > 0.05;
      if (e.apron) {
        e.apron.setGseVisible(d < (e.apron.gseVisible ? GSE_FAR + 200 : GSE_FAR));
        // inside the sun's orthographic shadow frustum: distance of the apron from its axis
        // (the sun direction through the camera focus) against its half-size (render/atmosphere.ts)
        const vx = (x0 + x1) / 2 - ctx.focus.x, vy = this.engine.heightAt((x0 + x1) / 2, (y0 + y1) / 2) - ctx.focus.y, vz = -(y0 + y1) / 2 - ctx.focus.z, sd = ctx.sunDir;
        const al = vx * sd.x + vy * sd.y + vz * sd.z;
        const axis = Math.hypot(vx - al * sd.x, vy - al * sd.y, vz - al * sd.z) - Math.hypot(x1 - x0, y1 - y0) / 2;
        e.apron.setShadows(!CULL || axis < Math.min(1800, Math.max(200, ctx.altitude * 1.2 + 150)) * 1.25 * 1.42 + 60);
      }
      if (e.apron) e.apron.update(ctx, (window as unknown as { __air?: { system: AirSystem } }).__air?.system ?? null);
    }
  }

  dispose() {
    for (const e of this.entries) {
      this.dropDetail(e);
      for (const m of e.base) m.geometry.dispose();
    }
    this.engine.scene.remove(this.root);
  }
}

/** per-triangle normals for the unshared massing faces; roof (tm.y = -1) faces straight up */
function flatNormals(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position'), n = g.getAttribute('normal') as THREE.BufferAttribute, t = g.getAttribute('tm');
  const idx = g.index!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    const i0 = idx.getX(i), i1 = idx.getX(i + 1), i2 = idx.getX(i + 2);
    a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
    c.sub(b); a.sub(b); c.cross(a).normalize();
    if (t.getY(i0) < -0.5) c.set(0, 1, 0);
    for (const k of [i0, i1, i2]) n.setXYZ(k, c.x, c.y, c.z);
  }
  n.needsUpdate = true;
}
