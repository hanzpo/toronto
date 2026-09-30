/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Playwright benchmark (run with app/perf/run.sh — see app/perf/README in run.sh).
// A `run-code` function: the scenarios come from the page URL (?bench=a,b,c).
// Each scenario records rAF frame times, engine main-thread ms per layer,
// draw calls, triangles and tile fetch latency.
async page => {
  const want = (new URL(page.url()).searchParams.get('bench') || 'street,streetcar,dvp,region,zoom,pan').split(',');
  await page.waitForFunction(() => window.__engine && window.__app && window.__transit, null, { timeout: 90000 });
  const settle = async (maxMs = 15000) => {
    const t0 = Date.now();
    await page.waitForTimeout(1500);
    while (Date.now() - t0 < maxMs) {
      const p = await page.evaluate(() => window.__app.getState().stats.tilesPending);
      if (p === 0) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1000);
  };
  const begin = () => page.evaluate(() => {
    const e = window.__engine;
    e.perf.reset();
    e.tiles.fetchLog.length = 0;
    window.__frames = [];
    window.__benchOn = true;
    let last = performance.now();
    const f = () => { const n = performance.now(); window.__frames.push(n - last); last = n; if (window.__benchOn) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  const end = (name) => page.evaluate((name) => {
    window.__benchOn = false;
    const e = window.__engine, p = e.perf;
    const f = window.__frames.slice(2), s = [...f].sort((a, b) => a - b);
    const q = (a, x) => a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * x))] * 10) / 10 : null;
    const sum = f.reduce((a, b) => a + b, 0);
    const n = Math.max(1, p.frames);
    const parts = Object.entries(p.acc).map(([k, v]) => [k, v / n]).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ');
    const fl = [...e.tiles.fetchLog].sort((a, b) => a - b);
    const st = window.__app.getState().stats;
    return {
      name, frames: f.length, fps: Math.round((f.length / (sum / 1000)) * 10) / 10,
      p50: q(s, 0.5), p95: q(s, 0.95), p99: q(s, 0.99), worst: q(s, 1), over50: f.filter((x) => x > 50).length,
      cpuAvg: Math.round((p.cpuMs / n) * 100) / 100, cpuMax: Math.round(p.cpuMax),
      draws: Math.round(p.draws / n), drawsMax: p.drawsMax,
      trisM: Math.round((p.tris / n) / 1e4) / 100, trisMaxM: Math.round(p.trisMax / 1e4) / 100,
      parts,
      tileFetch: fl.length ? { n: fl.length, p50: q(fl, 0.5), p95: q(fl, 0.95) } : null,
      tiles: st.tilesLoaded, gpuMB: Math.round(st.gpuMB), backend: st.backend,
      long: p.long.slice().sort((a, b) => b.ms - a.ms).slice(0, 4).map((l) => `${Math.round(l.ms)}ms ${l.parts}`),
    };
  }, name);
  const jump = (v) => page.evaluate((v) => {
    const e = window.__engine;
    window.__interact?.leave?.(true);
    e.controls.jumpTo({ ...v, h: e.heightAt(v.e, v.n) + 1.5 });
  }, v);
  const out = [];
  const run = async (name, fn) => {
    try { out.push(await fn()); } catch (err) { out.push({ name, error: String(err).slice(0, 300) }); }
  };

  for (const w of want) {
    if (w === 'street') await run(w, async () => {
      // King & Spadina at eye level, then a slow walk east along King while looking around
      await jump({ e: -975, n: -867, dist: 30, heading: Math.PI / 2, pitch: 0.12 });
      await settle();
      await begin();
      for (let i = 0; i < 100; i++) {
        await page.evaluate((i) => { const g = window.__engine.controls.goal; g.e += 1.2; g.heading = Math.PI / 2 + Math.sin(i / 16) * 1.2; }, i);
        await page.waitForTimeout(80);
      }
      return end('street');
    });
    if (w === 'streetcar') await run(w, async () => {
      await jump({ e: -975, n: -867, dist: 400, heading: 0, pitch: 0.6 });
      await page.waitForTimeout(2500);
      const trip = await page.evaluate(() => {
        const s = window.__transit.system, v = s.vehicles, r = s.routeIndex('ttc:504');
        let best = null, bd = 1e12;
        for (let i = 0; i < v.count; i++) {
          if (v.route[i] !== r) continue;
          const d = Math.hypot(v.x[i] + 975, v.y[i] + 867);
          if (d < bd) { bd = d; best = v.trip[i]; }
        }
        if (best !== null) window.__interact.follow(best);
        return best;
      });
      if (trip === null) throw new Error('no 504 in service');
      await settle(10000);
      await begin();
      await page.waitForTimeout(12000);
      const r = await end('streetcar');
      await page.evaluate(() => window.__interact.leave?.(true));
      return r;
    });
    if (w === 'dvp') await run(w, async () => {
      await jump({ e: 1800, n: 2600, dist: 60, heading: 0, pitch: 0.3 });
      await settle(10000);
      const ok = await page.evaluate(() => window.__interact.takeOverCar(1800, 2600));
      await page.waitForTimeout(1500);
      await begin();
      if (ok) {
        await page.keyboard.down('w');
        await page.waitForTimeout(14000);
        await page.keyboard.up('w');
      } else {
        // no car: fly the camera north along the valley at driving speed
        for (let i = 0; i < 140; i++) {
          await page.evaluate(() => { const g = window.__engine.controls.goal; g.n += 2.5; g.e += 0.6; });
          await page.waitForTimeout(100);
        }
      }
      const r = await end(ok ? 'dvp-drive' : 'dvp-fly');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__interact.leave?.(true));
      return r;
    });
    if (w === 'region') await run(w, async () => {
      await jump({ e: -2000, n: 3000, dist: 70000, heading: -0.3, pitch: 0.9 });
      await settle();
      await begin();
      await page.waitForTimeout(5000);
      return end('region');
    });
    if (w === 'city') await run(w, async () => {
      await jump({ e: -350, n: -700, dist: 3200, heading: -0.35, pitch: 0.62 });
      await settle();
      await begin();
      await page.waitForTimeout(5000);
      return end('city');
    });
    if (w === 'zoom') await run(w, async () => {
      await jump({ e: -350, n: -700, dist: 3200, heading: -0.35, pitch: 0.62 });
      await settle();
      await begin();
      await page.mouse.move(700, 450);
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(40); }
        await page.waitForTimeout(800);
        for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(40); }
        await page.waitForTimeout(800);
      }
      return end('zoom');
    });
    if (w === 'pan') await run(w, async () => {
      await jump({ e: -350, n: -700, dist: 600, heading: -0.35, pitch: 0.45 });
      await settle();
      await begin();
      for (let k = 0; k < 2; k++) {
        await page.mouse.move(700, 450); await page.mouse.down();
        for (let i = 0; i < 60; i++) { await page.mouse.move(700 - i * 10, 450 - i * 4); await page.waitForTimeout(16); }
        await page.mouse.up();
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(1500);
      return end('pan');
    });
  }
  return JSON.stringify(out);
}
