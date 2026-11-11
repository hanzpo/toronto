// Bakes what the pipeline and the far view need from the network description, by running the
// engine (src/net/core) on the net tiles:
//   --far DIR      far road and rail LOD per pyramid tile: DIR/{level}/{tx}_{ty}.bin.gz
//   --lanes DIR    vehicle lanes per 4x4 block for transit shape matching: DIR/{bx}_{by}.bin.gz
//   --rail FILE    drawn track centrelines (rail/network.bin.gz)
//   --majors FILE  major roads for the congestion overlay (congestion/majors.bin.gz)
//
//   node scripts/net-bake.mjs --net public/data/net --far public/data/net/far --lanes ../pipeline/work/net/lanes \
//     --rail public/data/rail/network.bin.gz --majors public/data/congestion/majors.bin.gz [--bbox W,S,E,N]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { runnerImport } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const { module: bake } = await runnerImport(join(here, '../src/net/bake.ts'));
const { module: tiles } = await runnerImport(join(here, '../src/net/tiles.ts'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const NET = args.net;
if (!NET) throw new Error('--net DIR required');
const bbox = args.bbox ? args.bbox.split(',').map(Number) : null;
const S0 = 1024, S = { 0: 1024, 1: 4096, 2: 16384 };
const TOL = { 0: 0.5, 1: 3, 2: 10 };
const KEEP = { 1: (p) => (p.road ? p.cls <= 4 : p.cls !== 1), 2: (p) => (p.road ? p.cls <= 2 : p.cls === 0) };
const BLOCK = 4;

const DT = new Map([[Int8Array, 'i8'], [Uint8Array, 'u8'], [Int16Array, 'i16'], [Uint16Array, 'u16'], [Int32Array, 'i32'], [Uint32Array, 'u32'], [Float32Array, 'f32'], [Float64Array, 'f64']]);
function writeTbn(path, arrays, extra = {}) {
  const index = {};
  const blobs = [];
  let off = 0;
  for (const [name, a] of Object.entries(arrays)) {
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    index[name] = [DT.get(a.constructor), off, a.length];
    const pad = (8 - (b.length % 8)) % 8;
    blobs.push(b, Buffer.alloc(pad));
    off += b.length + pad;
  }
  const hj = Buffer.from(JSON.stringify({ arrays: index, ...extra }));
  const head = Buffer.alloc(8);
  head.write('TBN1', 0, 'latin1');
  head.writeUInt32LE(hj.length, 4);
  const hpad = (8 - ((8 + hj.length) % 8)) % 8;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(Buffer.concat([head, hj, Buffer.alloc(hpad), ...blobs]), { level: 6 }));
}

function loadTile(tx, ty) {
  const f = join(NET, `${tx}_${ty}.json.gz`);
  if (!existsSync(f)) return null;
  const j = JSON.parse(gunzipSync(readFileSync(f)).toString());
  const d = join(NET, `${tx}_${ty}.dtm.gz`);
  j.terrain = j.terrain && existsSync(d) ? tiles.decodeTerrain(j.terrain, gunzipSync(readFileSync(d))) : undefined;
  return j;
}

const index = JSON.parse(readFileSync(join(NET, 'index.json'), 'utf8'));
const inBox = (x0, y0, s) => !bbox || (x0 < bbox[2] && x0 + s > bbox[0] && y0 < bbox[3] && y0 + s > bbox[1]);
const all = index.tiles.map((t) => t.tile).filter(([tx, ty]) => inBox(tx * S0, ty * S0, S0));
const blocks = new Map();
for (const [tx, ty] of all) {
  const k = `${Math.floor(tx / BLOCK)}_${Math.floor(ty / BLOCK)}`;
  if (!blocks.has(k)) blocks.set(k, []);
  blocks.get(k).push([tx, ty]);
}

const far = { 1: [], 2: [] };
const majors = [];
const rail = [];
const t0 = performance.now();
let done = 0, nLanes = 0;
for (const [bk, list] of blocks) {
  const descs = [];
  const prepared = new Map();
  for (const [tx, ty] of list) {
    const d = loadTile(tx, ty);
    if (!d) continue;
    descs.push(d);
    const { ctx, pieces } = bake.tilePieces(d);
    const own = new Set(d.own?.segs ?? []);
    for (const s of ctx.segs) if (own.has(s.desc.id)) prepared.set(s.desc.id, { ctx, seg: s });
    if (args.far) {
      const { arrays, names } = bake.farArrays(pieces, tx * S0, ty * S0, S0, TOL[0]);
      writeTbn(join(args.far, '0', `${tx}_${ty}.bin.gz`), arrays, { names });
    }
    for (const p of pieces) {
      if (!own.has(p.seg)) continue;
      if (p.road && p.cls <= 2) majors.push(p);
      if (KEEP[1](p)) {
        const keep = bake.simplify(p.pts, p.vf, 1);
        far[1].push({ ...p, pts: keep.flatMap((i) => [p.pts[i * 3], p.pts[i * 3 + 1], p.pts[i * 3 + 2]]), dz: keep.map((i) => p.dz[i]), vf: keep.map((i) => p.vf[i]) });
      }
    }
  }
  if ((args.lanes || args.rail) && descs.length) {
    const lanes = bake.blockLanes(descs, prepared);
    nLanes += lanes.length;
    for (const l of lanes) if (l.rail !== 255) rail.push(l);
    if (args.lanes) {
      const { arrays, keys, next, groups } = bake.laneArrays(lanes);
      writeTbn(join(args.lanes, `${bk}.bin.gz`), arrays, { keys, next, groups });
    }
  }
  done++;
  if (done % 10 === 0 || done === blocks.size) console.log(`${done}/${blocks.size} blocks, ${nLanes} lanes, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}

if (args.far) {
  far[2] = far[1].filter(KEEP[2]);
  const manifest = JSON.parse(readFileSync(join(NET, '..', 'manifest.json'), 'utf8'));
  for (const L of [1, 2]) {
    const s = S[L];
    const bins = new Map();
    for (const p of far[L]) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < p.pts.length; i += 3) { x0 = Math.min(x0, p.pts[i]); x1 = Math.max(x1, p.pts[i]); y0 = Math.min(y0, p.pts[i + 1]); y1 = Math.max(y1, p.pts[i + 1]); }
      for (let tx = Math.floor(x0 / s); tx <= Math.floor(x1 / s); tx++) for (let ty = Math.floor(y0 / s); ty <= Math.floor(y1 / s); ty++) {
        const k = `${tx}_${ty}`;
        if (!bins.has(k)) bins.set(k, []);
        bins.get(k).push(p);
      }
    }
    let n = 0;
    for (const [tx, ty] of manifest.tiles[String(L)]) {
      if (!inBox(tx * s, ty * s, s)) continue;
      const { arrays, names } = bake.farArrays(bins.get(`${tx}_${ty}`) ?? [], tx * s, ty * s, s, TOL[L]);
      writeTbn(join(args.far, String(L), `${tx}_${ty}.bin.gz`), arrays, { names });
      n++;
    }
    console.log(`far level ${L}: ${n} tiles`);
  }
}
if (args.rail) {
  writeTbn(args.rail, bake.railArrays(rail));
  console.log(`rail: ${rail.length} tracks`);
}
if (args.majors) {
  const { arrays, names } = bake.majorArrays(majors, 6);
  writeTbn(args.majors, arrays, { names });
  console.log(`majors: ${arrays.s_class.length} segments`);
}
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
