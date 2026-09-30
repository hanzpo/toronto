#!/usr/bin/env node
// Dump the client's placed street furniture + vegetation for every level-0
// tile (or a bbox) to pipeline/work/qa_props/{tx}_{ty}.bin, for the static QA
// (pipeline/tpipe/qa: tree_on_road / tree_on_rail / prop_in_lane ...).
//
//   node app/qa/props_dump.mjs [--bbox E0,N0,E1,N1] [--workers 4] [--force]
//
// Bundles app/qa/props_entry.ts with Vite (SSR build), then runs it in worker
// threads. Incremental: a tile is redone when its data file is newer than its
// dump or when the bundled placement code changed (hash stamp).
import { build } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TILES = path.join(ROOT, 'app/public/data/tiles/0');
const OUT = path.join(ROOT, 'pipeline/work/qa_props');

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const force = args.includes('--force');
  const nw = Math.min(4, Number(opt('--workers', 4)));
  const bbox = opt('--bbox', null)?.split(',').map(Number);
  const t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-props-'));
  await build({
    configFile: false, root: path.join(ROOT, 'app'), logLevel: 'error',
    build: { ssr: path.join(HERE, 'props_entry.ts'), outDir: tmp, emptyOutDir: false, minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: 'props.mjs' } } },
  });
  const bundle = path.join(tmp, 'props.mjs');
  const hash = createHash('sha1').update(fs.readFileSync(bundle)).digest('hex').slice(0, 12);
  fs.mkdirSync(OUT, { recursive: true });
  const stampF = path.join(OUT, 'STAMP');
  const stamp = fs.existsSync(stampF) ? fs.readFileSync(stampF, 'utf8').trim() : '';
  const redoAll = force || stamp !== hash;
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/public/data/manifest.json'), 'utf8'));
  let tiles = manifest.tiles['0'];
  if (bbox) tiles = tiles.filter(([tx, ty]) => (tx + 1) * 1024 > bbox[0] && tx * 1024 < bbox[2] && (ty + 1) * 1024 > bbox[1] && ty * 1024 < bbox[3]);
  const todo = tiles.filter(([tx, ty]) => {
    if (redoAll) return true;
    const o = path.join(OUT, `${tx}_${ty}.bin`);
    if (!fs.existsSync(o)) return true;
    const src = path.join(TILES, `${tx}_${ty}.bin.gz`);
    return fs.existsSync(src) && fs.statSync(src).mtimeMs > fs.statSync(o).mtimeMs;
  });
  let done = 0, errors = 0;
  const chunks = Array.from({ length: nw }, (_, w) => todo.filter((_, i) => i % nw === w));
  await Promise.all(chunks.map((list) => new Promise((resolve) => {
    if (!list.length) return resolve();
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { bundle, list } });
    w.on('message', (m) => { if (m.err) { errors++; console.error(m.err); } else done++; });
    w.on('exit', resolve);
    w.on('error', (e) => { console.error(e); resolve(); });
  })));
  if (!errors) fs.writeFileSync(stampF, hash);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({ tiles: tiles.length, placed: done, skipped: tiles.length - todo.length, errors, hash, s: (Date.now() - t0) / 1000 }));
} else {
  const { placeTile, setZones } = await import(pathToFileURL(workerData.bundle).href);
  // station zones (paved, tree-free platforms / Union deck), as the client's tile worker gets them
  try { setZones(JSON.parse(fs.readFileSync(path.join(ROOT, 'app/public/data/stations.json'), 'utf8')).zones ?? []); } catch { /* optional */ }
  for (const [tx, ty] of workerData.list) {
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(path.join(TILES, `${tx}_${ty}.bin.gz`)));
      const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const out = placeTile(ab, tx, ty);
      fs.writeFileSync(path.join(OUT, `${tx}_${ty}.bin`), Buffer.from(out.buffer, out.byteOffset, out.byteLength));
      parentPort.postMessage({ ok: 1 });
    } catch (e) {
      parentPort.postMessage({ err: `${tx}_${ty}: ${e?.stack ?? e}` });
    }
  }
}
