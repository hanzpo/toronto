// Niagara Falls: curtains, plunge-pool foam, talus and mist, built from the
// landmarks.json waterfall entries (pipeline/tpipe/falls.py, curated/falls.json).
//
// References: Niagara Parks (Horseshoe crest ~670 m, average drop 57 m, plunge
// pool 35 m deep; American Falls crest ~260 m, 21-34 m onto talus), Wikipedia
// (Horseshoe / American / Bridal Veil Falls). The ground (tpipe.ground) already
// ends the upper river at each crest at its brink level and holds the gorge
// flat at the Maid of the Mist pool level; this module fills the drop.
//
//   curtain  per crest vertex a ballistic profile: the water leaves the lip
//            with the river's speed and falls x = throw·√(s/H); textured with
//            foam streaks that fall at √(2gs) (the pattern is scrolled in fall
//            time, so it accelerates down the sheet), glassy green at the lip,
//            aerated white below, dissolving into spray at the base.
//   foam     boil on the pool where the Horseshoe lands, advected downstream;
//            a band along the talus toe of the American / Bridal Veil falls.
//   talus    low-poly boulder slope from the curtain foot to the river, white
//            water running down it.
//   mist     instanced sprites rising from the plunge zone (the Horseshoe's
//            plume towers above the rim); all motion in the vertex shader.
// Four draws in total, no per-frame CPU work.
import * as THREE from 'three/webgpu';
import {
  attribute, clamp, float, fract, instancedBufferAttribute, length, max, mix, pow, sin, smoothstep, sqrt,
  texture, uniform, uv, vec2, vec3, vec4, abs, select,
} from 'three/tsl';
import { U } from '../render/uniforms';
import { streetTexture } from '../render/tiles/roadMaterial';
import type { LandmarkEntry } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type V2 = [number, number];

export interface FallEntry extends LandmarkEntry {
  line: V2[];
  /** downstream edge of the OSM waterfall area: curtain foot / talus toe */
  toe?: V2[];
  top: number;
  /** where the free fall lands: the pool, or the top of the talus */
  foot?: number;
  bottom: number;
  talus?: boolean;
  /** share of the river's flow (Horseshoe ~0.9) */
  flow?: number;
}

const G = 9.81;
/** daylight 0..1 (mist and spray are unlit sprites) */
const DAY = uniform(1);
export function setFallsDaylight(d: number) { DAY.value = d; }

// ------------------------------------------------------------------ geometry helpers

function resample(p: V2[], step: number): V2[] {
  const out: V2[] = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i];
    const L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** light Chaikin-free smoothing of a polyline (keeps the ends) */
function smooth(p: V2[], iters: number): V2[] {
  let q = p;
  for (let it = 0; it < iters; it++) {
    const r: V2[] = [q[0]];
    for (let i = 1; i + 1 < q.length; i++) r.push([(q[i - 1][0] + 2 * q[i][0] + q[i + 1][0]) / 4, (q[i - 1][1] + 2 * q[i][1] + q[i + 1][1]) / 4]);
    r.push(q[q.length - 1]);
    q = r;
  }
  return q;
}

function distToPolyline(x: number, y: number, p: V2[]): number {
  let best = Infinity;
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i];
    const ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey;
    let t = L > 0 ? ((x - ax) * ex + (y - ay) * ey) / L : 0;
    t = Math.min(1, Math.max(0, t));
    best = Math.min(best, Math.hypot(ax + ex * t - x, ay + ey * t - y));
  }
  return best;
}

/** hash in [0, 1) */
function h1(a: number, b = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

interface Column {
  /** crest point (E, N), downstream unit normal, arc length, throw (m) */
  x: number; y: number; dx: number; dy: number; u: number; throw: number;
  /** 0..1: how deep / green the water is at the lip (the Horseshoe's notch) */
  thick: number;
}

/** crest columns with a downstream normal (toward the base line) and throw */
function columns(f: FallEntry): Column[] {
  const crest = smooth(resample(f.line, 5), 2);
  // directions from a heavily smoothed crest (the OSM crest is jagged at the metre scale)
  const dirs = smooth(crest, 12);
  const base = f.toe && f.toe.length > 1 ? f.toe : null;
  const H = f.top - (f.foot ?? f.bottom);
  const cols: Column[] = [];
  let u = 0;
  // pick the side (left / right of travel) the base line is on
  const n0 = normalAt(dirs, Math.floor(crest.length / 2));
  let side = 1;
  if (base) {
    const m = crest[Math.floor(crest.length / 2)];
    const dl = distToPolyline(m[0] + n0[0] * 15, m[1] + n0[1] * 15, base), dr = distToPolyline(m[0] - n0[0] * 15, m[1] - n0[1] * 15, base);
    side = dl <= dr ? 1 : -1;
  }
  // the deepest notch: the crest point farthest upstream
  const mean = crest.reduce((a, _p, i) => { const n = normalAt(dirs, i); return [a[0] + n[0] * side, a[1] + n[1] * side]; }, [0, 0]);
  const ml = Math.hypot(mean[0], mean[1]) || 1;
  const along = crest.map((p) => (p[0] * mean[0] + p[1] * mean[1]) / ml);
  const amin = Math.min(...along), amax = Math.max(...along);
  const big = (f.flow ?? 0.1) > 0.5;
  for (let i = 0; i < crest.length; i++) {
    if (i > 0) u += Math.hypot(crest[i][0] - crest[i - 1][0], crest[i][1] - crest[i - 1][1]);
    const [nx, ny] = normalAt(dirs, i);
    const dx = nx * side, dy = ny * side;
    // throw: the Horseshoe's heavy sheet carries ~15-20 m out over 57 m; thin sheets less
    let thr = big ? 17 : 6;
    if (base) thr = Math.min(thr, Math.max(4, 0.6 * distToPolyline(crest[i][0], crest[i][1], base)));
    thr *= Math.sqrt(Math.max(H, 5) / 57) ** 0.3;
    const deep = big ? Math.pow(1 - (along[i] - amin) / Math.max(amax - amin, 1), 2.5) : 0;
    cols.push({ x: crest[i][0], y: crest[i][1], dx, dy, u, throw: thr, thick: deep });
  }
  return cols;
}

function normalAt(p: V2[], i: number): V2 {
  const a = p[Math.max(i - 1, 0)], b = p[Math.min(i + 1, p.length - 1)];
  const tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty) || 1;
  return [-ty / L, tx / L]; // left of travel
}

class Buf {
  pos: number[] = []; uv: number[] = []; ex: number[] = []; idx: number[] = [];
  v(x: number, y: number, z: number, u: number, v: number, e0 = 0, e1 = 0) {
    this.pos.push(x, y, z); this.uv.push(u, v); this.ex.push(e0, e1);
    return this.pos.length / 3 - 1;
  }
  grid(cols: number, rows: number, first: number) {
    for (let i = 0; i + 1 < cols; i++) for (let j = 0; j + 1 < rows; j++) {
      const a = first + i * rows + j, b = a + rows;
      this.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('fx', new THREE.Float32BufferAttribute(this.ex, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ build

export function buildFalls(entries: LandmarkEntry[]): THREE.Group | null {
  // only entries from tpipe.falls (curated levels matching the ground's gorge and rapids); older
  // landmarks.json files carry a bare brink line whose levels don't match the ground
  const falls = (entries as unknown as FallEntry[]).filter((e) => e.kind === 'waterfall' && (e.line?.length ?? 0) > 1 && e.foot != null && e.toe);
  if (!falls.length) return null;
  // local origin: first crest's first vertex (every vertex stays < 2 km from it)
  const [ox, on] = falls[0].line[0];
  const curtain = new Buf(), foam = new Buf(), talus = new Buf();
  const mist: number[] = []; // local x, y, z, seed, kind (0 spray · 1 plume), scale
  const L = (e: number, n: number): [number, number] => [e - ox, -(n - on)];

  for (const f of falls) {
    const cols = columns(f);
    const foot = f.foot ?? f.bottom;
    const H = Math.max(f.top - foot, 3);
    const isTalus = !!f.talus && foot > f.bottom + 1;
    const flow = f.flow ?? 0.1;
    // ---- curtain: lip roll-over (from 6 m upstream) + ballistic sheet
    const R = 12;
    const first = curtain.pos.length / 3;
    for (const c of cols) {
      const rows: [number, number, number][] = []; // (horizontal offset, y, fall s)
      rows.push([-6, f.top + 0.3, -6], [-2.5, f.top + 0.22, -2.5], [0, f.top + 0.05, 0]);
      for (let j = 1; j <= R; j++) {
        const s = H * Math.pow(j / R, 1.6);
        rows.push([c.throw * Math.sqrt(s / H), f.top - s, s]);
      }
      // below the pool / into the talus
      rows.push([c.throw * 1.02, foot - (isTalus ? 2 : 1.5), H + 1.5]);
      for (const [off, y, s] of rows) {
        const [lx, lz] = L(c.x + c.dx * off, c.y + c.dy * off);
        curtain.v(lx, y, lz, c.u, s, H, c.thick * (flow > 0.5 ? 1 : 0) + (isTalus ? 2 : 0));
      }
    }
    curtain.grid(cols.length, R + 4, first);

    // ---- plunge foam (pool) or toe foam (talus)
    const fr = 5;
    const f0 = foam.pos.length / 3;
    const W = isTalus ? 16 : 26 + 70 * flow;
    for (const c of cols) {
      const start = isTalus ? (f.toe ? distToPolyline(c.x, c.y, f.toe) : c.throw + 20) - 4 : c.throw - 6;
      for (let k = 0; k < fr; k++) {
        const d = start + (W * k) / (fr - 1);
        const [lx, lz] = L(c.x + c.dx * d, c.y + c.dy * d);
        foam.v(lx, f.bottom + 0.22, lz, c.u, (W * k) / (fr - 1), W, isTalus ? 1 : 0);
      }
    }
    foam.grid(cols.length, fr, f0);

    // ---- talus: boulder slope from the curtain foot to the river (toe = base line)
    if (isTalus) {
      const tr = 12;
      const t0 = talus.pos.length / 3;
      cols.forEach((c, i) => {
        const toe = f.toe ? distToPolyline(c.x, c.y, f.toe) : c.throw + 30;
        // the pile reaches the river at the OSM toe line, 25-80 m out from the face
        const d0 = c.throw - 2, d1 = Math.min(Math.max(toe, d0 + 25), d0 + 80) + 3;
        for (let k = 0; k < tr; k++) {
          const t = k / (tr - 1);
          // concave scree profile, jittered into boulders (not at the waterline row)
          const jit = k > 0 && k < tr - 1 ? 1 : 0;
          const d = d0 + (d1 - d0) * t + (h1(i, k) - 0.5) * 2.5 * jit;
          const y = foot + 1 - (foot + 1 - (f.bottom - 1.2)) * Math.pow(t, 0.7) + (h1(k, i + 7) - 0.5) * 2.2 * jit;
          const side = (h1(i + 3, k * 5) - 0.5) * 1.6 * jit;
          const [lx, lz] = L(c.x + c.dx * d - c.dy * side, c.y + c.dy * d + c.dx * side);
          talus.v(lx, y, lz, c.u, t, flow, 0);
        }
      });
      talus.grid(cols.length, tr, t0);
    }

    // ---- mist: spray sprites along the plunge line, plume sprites over the Horseshoe
    const nSpray = Math.round(14 + 110 * flow), nPlume = flow > 0.5 ? 30 : 0;
    for (let k = 0; k < nSpray + nPlume; k++) {
      const c = cols[Math.floor(h1(k, 1.3 + flow) * cols.length)];
      const plume = k >= nSpray ? 1 : 0;
      const off = c.throw + (isTalus ? 10 : 8) + h1(k, 2.1) * (plume ? 60 : 25);
      const [lx, lz] = L(c.x + c.dx * off, c.y + c.dy * off);
      const scale = (isTalus ? 0.6 : 1) * (0.7 + 0.6 * h1(k, 5.5)) * (plume ? 1.6 : 1);
      mist.push(lx, (isTalus ? foot - 6 : f.bottom) + 1, lz, h1(k, 9.9 + flow), plume, scale);
    }
  }

  const group = new THREE.Group();
  group.name = 'niagara-falls';
  group.position.set(ox, 0, -on);
  const mk = (b: Buf, m: THREE.Material, name: string, order: number) => {
    if (!b.idx.length) return;
    const mesh = new THREE.Mesh(b.geometry(), m);
    mesh.name = name;
    mesh.renderOrder = order;
    mesh.castShadow = false;
    mesh.receiveShadow = name !== 'falls-mist';
    group.add(mesh);
  };
  mk(talus, talusMaterial(), 'falls-talus', 0);
  mk(foam, foamMaterial(), 'falls-foam', 3);
  mk(curtain, curtainMaterial(), 'falls-curtain', 4);
  if (mist.length) group.add(mistSprites(mist));
  group.userData.noShadow = true;
  return group;
}

// ------------------------------------------------------------------ materials

const noiseTex = () => streetTexture('ground_detail_b.webp', false);

/** two-channel cloudy noise in [0, 1] */
function cloud(p: N) {
  const t = noiseTex();
  return texture(t, p).b.mul(0.6).add(texture(t, p.mul(2.7).add(0.37)).g.mul(0.4));
}

function curtainMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, transparent: true });
  m.name = 'falls-curtain';
  const u = uv().x, s = max(uv().y, 0); // arc length m, fall distance m
  const fx = attribute('fx', 'vec2');
  const H = fx.x, tal = f01(fx.y.greaterThan(1.5)), thick = fx.y.sub(tal.mul(2));
  const vn = clamp(s.div(H), 0, 1);
  const t = U.time;
  // fall time from the lip: scrolling in it makes the pattern accelerate down the sheet
  const tf = sqrt(s.mul(2 / G).add(0.02));
  const lipT = clamp(uv().y.add(6).div(6), 0, 1); // 0 upstream edge .. 1 at the brink
  const ropes = cloud(vec2(u.div(23), 0.13)); // thicker / thinner ropes of water along the crest
  const a = cloud(vec2(u.div(3.1), tf.mul(0.55).sub(t.mul(0.55))));
  const b = cloud(vec2(u.div(1.3).add(0.5), tf.mul(1.4).sub(t.mul(1.4))));
  const streak = a.mul(0.6).add(b.mul(0.4)).add(ropes.sub(0.5).mul(0.5));
  // colour: glassy green over the lip (deepest in the Horseshoe's notch), aerating to white
  const aer = smoothstep(0.5, mix(float(9), float(22), thick), s); // 0 solid sheet .. 1 white water
  const glass = mix(vec3(0.2, 0.36, 0.3), vec3(0.08, 0.3, 0.2), thick);
  const white = mix(vec3(0.62, 0.68, 0.7), vec3(0.97, 0.98, 0.98), smoothstep(0.25, 0.75, streak));
  let col: N = mix(glass, white, aer);
  // lip highlight (the smooth rollover catches the sky)
  const lip = smoothstep(0.35, 0.95, lipT).mul(float(1).sub(smoothstep(0, 3, s)));
  col = mix(col, vec3(0.75, 0.85, 0.82), lip.mul(0.35));
  m.colorNode = col;
  m.roughnessNode = mix(float(0.15), float(0.75), aer);
  m.metalness = 0;
  // water scatters light: white water stays bright in shade
  (m as unknown as { emissiveNode: N }).emissiveNode = col.mul(mix(float(0.05), float(0.22), aer)).mul(float(1).sub(U.night.mul(0.8)));
  // opacity: solid sheet; thin sheets (talus falls) torn into streaks; dissolving into spray at the foot
  const torn = mix(float(0.97), smoothstep(0.2, 0.6, streak).mul(0.5).add(0.45), tal);
  const spray = smoothstep(0.72, 1.0, vn);
  const edgeIn = smoothstep(0, 0.35, lipT); // feather the upstream edge into the river
  m.opacityNode = torn.mul(float(1).sub(spray.mul(mix(float(0.9), streak, 0.4)))).mul(edgeIn);
  m.depthWrite = true;
  return m;
}

function foamMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.name = 'falls-foam';
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  const u = uv().x, d = uv().y; // along the crest, out from the plunge line (m)
  const fx = attribute('fx', 'vec2');
  const W = fx.x, toe = fx.y;
  const t = U.time;
  // boil: two phases advected away from the falls (flow map, bounded offsets)
  const P = 3.0;
  const ph0 = fract(t.div(P)), ph1 = fract(t.div(P).add(0.5));
  const w0 = float(1).sub(abs(ph0.mul(2).sub(1)));
  const L = (ph: N, k: number) => cloud(vec2(u.div(11).add(k * 0.37), d.sub(ph.mul(P).mul(2.5)).div(9)));
  const boil = L(ph0, 0).mul(w0).add(L(ph1, 1).mul(float(1).sub(w0)));
  const fade = pow(float(1).sub(clamp(d.div(W), 0, 1)), mix(float(1.3), float(2.2), toe));
  const cover = smoothstep(0.25, 0.7, boil.add(fade.mul(0.55)).sub(0.2)).mul(fade);
  const col = mix(vec3(0.55, 0.66, 0.62), vec3(0.95, 0.97, 0.96), smoothstep(0.3, 0.8, boil));
  m.colorNode = col;
  m.roughnessNode = float(0.7);
  m.metalness = 0;
  (m as unknown as { emissiveNode: N }).emissiveNode = col.mul(0.15).mul(float(1).sub(U.night.mul(0.8)));
  m.opacityNode = clamp(cover.mul(1.25), 0, 0.96);
  return m;
}

function talusMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ flatShading: true, side: THREE.DoubleSide }); // winding follows the crest direction
  m.name = 'falls-talus';
  const u = uv().x, v = uv().y; // along the crest m, 0 foot .. 1 toe
  const t = U.time;
  const rock = mix(vec3(0.3, 0.29, 0.27), vec3(0.5, 0.48, 0.44), cloud(vec2(u.div(6), v.mul(3))));
  // water spilling over the boulders: streaks running down the slope
  const run = cloud(vec2(u.div(2.2), v.mul(3.5).sub(t.mul(0.9))));
  const chutes = cloud(vec2(u.div(17), 0.61)); // where the sheet lands hardest
  const wet = smoothstep(0.6, 0.85, run.add(chutes.sub(0.5).mul(0.6)).add(float(0.25).mul(float(1).sub(smoothstep(0, 0.35, v)))));
  const col = mix(rock.mul(mix(float(1), float(0.55), smoothstep(0.1, 0.5, run))), vec3(0.92, 0.95, 0.95), wet.mul(0.85));
  m.colorNode = col;
  m.roughnessNode = mix(float(0.85), float(0.35), wet);
  m.metalness = 0;
  (m as unknown as { emissiveNode: N }).emissiveNode = vec3(0.92, 0.95, 0.95).mul(wet).mul(0.12).mul(float(1).sub(U.night.mul(0.8)));
  return m;
}

function mistSprites(data: number[]): THREE.Sprite {
  const n = data.length / 6;
  const base = new Float32Array(n * 3), ex = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    base.set(data.slice(i * 6, i * 6 + 3), i * 3);
    ex.set(data.slice(i * 6 + 3, i * 6 + 6), i * 3);
  }
  const bA = new THREE.InstancedBufferAttribute(base, 3), eA = new THREE.InstancedBufferAttribute(ex, 3);
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  m.name = 'falls-mist';
  const b = instancedBufferAttribute(bA) as N, e = instancedBufferAttribute(eA) as N;
  const seed = e.x, plume = e.y, sc = e.z;
  const life = mix(float(9), float(26), plume);
  const age = fract(U.time.div(life).add(seed)); // 0..1 through each puff's life
  const rise = mix(float(18), float(170), plume).mul(pow(age, mix(float(0.7), float(0.85), plume)));
  // drift downstream-ish with a slow sway (wind); puffs spread as they rise
  const sway = sin(U.time.mul(0.07).add(seed.mul(40))).mul(6).mul(age);
  const size = sc.mul(mix(float(70), float(110), plume)).mul(age.mul(1.1).add(0.6));
  // lift by ~half the size: the quad's lower edge stays at the water line, where the radial
  // falloff hides the intersection (no hard cut through the pool)
  m.positionNode = b.add(vec3(sway.add(age.mul(10)), rise.add(size.mul(0.42)), sway.mul(0.6).sub(age.mul(8))));
  m.scaleNode = vec2(size, size);
  const r = length(uv().sub(0.5)).mul(2);
  const soft = smoothstep(1, 0.15, r);
  const clump = cloud(uv().mul(0.6).add(seed));
  const env = smoothstep(0, 0.12, age).mul(smoothstep(1, 0.55, age));
  const a = soft.mul(soft).mul(clump.mul(0.7).add(0.3)).mul(env).mul(mix(float(0.16), float(0.1), plume));
  const col = mix(U.skyHorizon as N, vec3(1, 1, 1), 0.55).mul(DAY.mul(0.85).add(0.15));
  m.colorNode = vec4(col, a);
  const sp = new THREE.Sprite(m);
  sp.count = n;
  sp.frustumCulled = false;
  sp.renderOrder = 6;
  sp.name = 'falls-mist';
  sp.castShadow = false;
  sp.receiveShadow = false;
  return sp;
}

const f01 = (c: N) => select(c, float(1), float(0));
