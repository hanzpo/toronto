/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Rotation stress (app/perf/run.sh <url> spin "t=…"): at a few views, turn the camera
// 360° in ~3 s (pool membership churn: houses, street furniture, far trees) and
// report main-thread ms per frame (avg / max, per layer) and frames over 25 ms.
async page => {
  await page.routeWebSocket(/.*/, () => { /* swallow HMR */ });
  await page.reload();
  await page.waitForFunction(() => window.__engine && window.__app && window.__transit, null, { timeout: 120000 });
  const views = [['glencairn', [-4610, 6133, 150, 0, 30]], ['king-street', [-975, -867, 30, 90, 7]], ['dvp', [2600, 1800, 250, 20, 25]]];
  const out = [];
  for (const [name, c] of views) {
    await page.evaluate((c) => { const e = window.__engine; e.controls.collide = false; e.controls.jumpTo({ e: c[0], n: c[1], h: e.heightAt(c[0], c[1]) + 1.5, dist: c[2], heading: c[3] * Math.PI / 180, pitch: c[4] * Math.PI / 180 }); }, c);
    await page.waitForTimeout(3000);
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && await page.evaluate(() => window.__app.getState().stats.tilesPending) > 0) await page.waitForTimeout(500);
    // one warm-up turn (first visits load tiles / compile), then the measured turn
    for (const measure of [false, true]) {
      const r = await page.evaluate(async () => {
        const e = window.__engine, p = e.perf, g = e.controls.goal ?? e.controls.cur;
        p.reset();
        let over = 0, last = performance.now();
        const h0 = g.heading;
        await new Promise((res) => {
          const t0 = performance.now();
          const f = () => {
            const n = performance.now(), k = Math.min(1, (n - t0) / 3000);
            if (n - last > 25) over++;
            last = n;
            g.heading = h0 + k * Math.PI * 2;
            if (e.controls.cur) e.controls.cur.heading = g.heading;
            if (k < 1) requestAnimationFrame(f); else res();
          };
          requestAnimationFrame(f);
        });
        const nf = Math.max(1, p.frames);
        return { cpuAvg: +(p.cpuMs / nf).toFixed(2), cpuMax: +p.cpuMax.toFixed(1), over25: over, parts: Object.entries(p.acc).map(([k, v]) => [k, v / nf]).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' '), long: p.long.map((l) => `${Math.round(l.ms)}ms ${l.parts}`).slice(0, 3) };
      });
      if (measure) out.push({ name, ...r });
    }
  }
  return JSON.stringify(out);
}
