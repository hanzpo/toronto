/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Startup benchmark (app/perf/run.sh <url> startup): time to engine init, first
// tile, first settled view (no pending tiles), bytes transferred by type, and
// long tasks during the first seconds. Run on a fresh session for "cold";
// the script reloads once to measure a "warm" (HTTP/Cache Storage) revisit.
async page => {
  const measure = async () => {
    await page.evaluate(() => {
      window.__lt = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch { /* */ }
    });
    await page.waitForFunction(() => window.__engine && window.__app, null, { timeout: 90000 });
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const p = await page.evaluate(() => window.__app.getState().stats.tilesPending);
      if (p === 0) break;
      await page.waitForTimeout(200);
    }
    return page.evaluate(() => {
      const m = (n) => { const e = performance.getEntriesByName(n)[0]; return e ? Math.round(e.startTime) : null; };
      const res = performance.getEntriesByType('resource');
      const by = {};
      for (const r of res) {
        const k = /\.js(\?|$)/.test(r.name) ? 'js' : /\/tiles\//.test(r.name) ? 'tiles' : /\.json|\.bin/.test(r.name) ? 'data' : /\.wasm/.test(r.name) ? 'wasm' : 'other';
        by[k] = by[k] || { n: 0, kB: 0 };
        by[k].n++; by[k].kB += Math.round((r.transferSize || 0) / 1024);
      }
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
        engineInit: m('engine-init'), firstTile: m('first-tile'), firstFrame: m('first-frame'), layersReady: m('layers-ready'),
        settled: Math.round(performance.now()),
        longTasks: (window.__lt || []).filter(([t]) => t < 8000).length,
        longTaskMs: (window.__lt || []).filter(([t]) => t < 8000).reduce((a, [, d]) => a + d, 0),
        worstLongTasks: (window.__lt || []).sort((a, b) => b[1] - a[1]).slice(0, 5),
        layers: performance.getEntriesByType('measure').filter((m) => m.name.startsWith('layer:')).map((m) => `${m.name.slice(6)}@${Math.round(m.startTime)}+${Math.round(m.duration)}`).join(' '),
        bytes: by,
      };
    });
  };
  const cold = await measure();
  await page.reload();
  const warm = await measure();
  return JSON.stringify({ cold, warm });
}
