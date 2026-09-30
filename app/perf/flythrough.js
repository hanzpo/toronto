/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// GPU memory / leak check (app/perf/run.sh <url> flythrough "t=2026-09-30T13:00:00"):
// ~3 minutes of camera moves across the region (street level, low oblique,
// high overview), sampling renderer.info.memory (geometries, textures), tile
// bytes, loaded tiles, scene object count and the JS heap every few seconds.
// Ends back at the start view; a leak shows as counts that keep climbing
// instead of returning to the first visit's level.
async page => {
  await page.routeWebSocket(/.*/, () => { /* swallow HMR */ });
  await page.reload();
  await page.waitForFunction(() => window.__engine && window.__app && window.__transit, null, { timeout: 120000 });
  const route = [
    ['ks', [-975, -867, 30, 90, 7]],
    ['harbour', [-600, -1500, 800, 0, 35]],
    ['dvp', [2600, 1800, 250, 20, 25]],
    ['scarb', [14000, 8000, 400, 300, 30]],
    ['glencairn', [-4610, 6133, 150, 0, 30]],
    ['yorkdale', [-1239, 5722, 60, 180, 10]],
    ['pearson', [-18400, 2600, 350, 200, 30]],
    ['sq1', [-24000, -4000, 300, 60, 20]],
    ['region', [-2000, 3000, 30000, -17, 52]],
    ['etobicoke', [-12000, -2000, 120, 90, 12]],
    ['ks', [-975, -867, 30, 90, 7]],
    ['harbour', [-600, -1500, 800, 0, 35]],
    ['glencairn', [-4610, 6133, 150, 0, 30]],
    ['ks', [-975, -867, 30, 90, 7]],
  ];
  const cdp = await page.context().newCDPSession(page);
  const gc = () => cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  const sample = async (tag) => { await gc(); const hu = await cdp.send('Runtime.getHeapUsage'); return page.evaluate(([tag, hu]) => {
    const e = window.__engine, m = e.renderer.info.memory, st = window.__app.getState().stats;
    let objs = 0;
    e.scene.traverse(() => { objs++; });
    const heap = Math.round(hu.usedSize / 1048576), buffersMB = hu.backingStorageSize ? Math.round(hu.backingStorageSize / 1048576) : null;
    // geometries the renderer still holds that no scene object references (not disposed)
    const inScene = new Set();
    e.scene.traverse((o) => { if (o.geometry) inScene.add(o.geometry); });
    const reg = e.renderer._geometries?._geometryDisposeListeners;
    let orphans = 0;
    const kinds = {};
    if (reg) for (const g of reg.keys()) {
      if (inScene.has(g)) continue;
      orphans++;
      const k = `${g.name || g.type}|${Object.keys(g.attributes).join(',')}|${g.index ? g.index.count : g.attributes.position?.count}`;
      kinds[k] = (kinds[k] || 0) + 1;
    }
    const top = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v}× ${k}`);
    return { tag, t: Math.round(performance.now() / 1000), geo: m.geometries, orphans, tex: m.textures, tileMB: Math.round(st.gpuMB), tiles: st.tilesLoaded, objs, heapMB: heap, buffersMB, draws: st.drawCalls, trisM: +(st.triangles / 1e6).toFixed(2), top };
  }, [tag, hu]); };
  const out = [];
  const t0 = Date.now();
  const profile = new URL(page.url()).searchParams.get('heapprof') === '1';

  for (const [name, c] of route) {
    await page.evaluate((c) => { const e = window.__engine; window.__interact?.leave?.(true); e.controls.jumpTo({ e: c[0], n: c[1], h: e.heightAt(c[0], c[1]) + 1.5, dist: c[2], heading: c[3] * Math.PI / 180, pitch: c[4] * Math.PI / 180 }); }, c);
    // orbit slowly while there (tiles stream in and out)
    for (let k = 0; k < 4; k++) {
      await page.waitForTimeout(3000);
      await page.evaluate(() => { const g = window.__engine.controls.goal ?? window.__engine.controls.cur; g.heading += 0.6; });
    }
    out.push(await sample(name));
  }
  out.push({ totalS: Math.round((Date.now() - t0) / 1000) });
  if (profile) {
    // every live ArrayBuffer (worker-transferred tile data doesn't show in a sampling profile):
    // total bytes, and how much of it the tiles / scene attributes still reference
    await gc();
    const { result: proto } = await cdp.send('Runtime.evaluate', { expression: 'ArrayBuffer.prototype' });
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.objectId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: objects.objectId, returnByValue: true,
      functionDeclaration: `function () {
        const e = window.__engine, known = new Map();
        const mark = (buf, tag) => { if (buf && buf.byteLength !== undefined && !known.has(buf)) known.set(buf, tag); };
        const walkVal = (v, tag, depth) => {
          if (!v || depth > 3) return;
          if (ArrayBuffer.isView(v)) { mark(v.buffer, tag); return; }
          if (v instanceof ArrayBuffer) { mark(v, tag); return; }
          if (typeof v === 'object' && !(v.isObject3D) && !(v.isMaterial)) for (const k of Object.keys(v)) walkVal(v[k], tag, depth + 1);
        };
        e.scene.traverse((o) => { const g = o.geometry; if (!g) return; for (const a of Object.values(g.attributes)) mark(a.array?.buffer ?? a.data?.array?.buffer, 'scene:' + (o.name || o.type)); if (g.index) mark(g.index.array.buffer, 'scene:' + (o.name || o.type)); });
        for (const t of e.tiles.tiles.values()) if (t.state === 'ready') for (const k of ['heights', 'houses', 'street', 'canopy', 'props', 'urban', 'collide', 'cuts', 'counts']) walkVal(t[k], 'tile.' + k, 0);
        const by = {}; let total = 0, n = 0;
        for (const b of this) { total += b.byteLength; n++; const tag = known.get(b) ?? ('unknown ' + (b.byteLength >= 1048576 ? '>=1MB' : b.byteLength >= 65536 ? '64k-1MB' : '<64k')); by[tag] = (by[tag] ?? 0) + b.byteLength; }
        return { n, totalMB: Math.round(total / 1048576), by: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => Math.round(v / 1048576) + ' MB ' + k) };
      }`,
    });
    out.push({ buffers: result.value });
  }
  return JSON.stringify(out);
}
