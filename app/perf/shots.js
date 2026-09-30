/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Visual regression views (app/perf/run.sh <url> shots "out=/abs/dir"): King &
// Spadina street level, the DVP, Union Station, a 504 streetcar chase, a low
// oblique over midtown and the region. Saves PNGs named after each view.
async page => {
  await page.waitForFunction(() => window.__engine && window.__app && window.__transit, null, { timeout: 90000 });
  const dir = new URL(page.url()).searchParams.get('out') || '/tmp';
  const views = [
    ['king-spadina', { e: -975, n: -867, dist: 30, heading: 90, pitch: 7 }],
    ['king-spadina-west', { e: -975, n: -867, dist: 30, heading: 270, pitch: 10 }],
    ['dvp', { e: 1800, n: 2600, dist: 60, heading: 10, pitch: 12 }],
    ['union', { e: -150, n: -1050, dist: 220, heading: 20, pitch: 25 }],
    ['midtown-oblique', { e: -500, n: 4000, dist: 1600, heading: 180, pitch: 20 }],
    ['city', { e: -350, n: -700, dist: 3200, heading: -20, pitch: 36 }],
    ['region', { e: -2000, n: 3000, dist: 70000, heading: -17, pitch: 52 }],
  ];
  const out = [];
  for (const [name, v] of views) {
    await page.evaluate((v) => { const e = window.__engine; window.__interact?.leave?.(true); e.controls.jumpTo({ e: v.e, n: v.n, h: e.heightAt(v.e, v.n) + 1.5, dist: v.dist, heading: v.heading * Math.PI / 180, pitch: v.pitch * Math.PI / 180 }); }, v);
    const t0 = Date.now();
    await page.waitForTimeout(2500);
    while (Date.now() - t0 < 20000 && await page.evaluate(() => window.__app.getState().stats.tilesPending) > 0) await page.waitForTimeout(400);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/${name}.png` });
    out.push(name);
  }
  // streetcar chase
  const trip = await page.evaluate(() => {
    const s = window.__transit.system, v = s.vehicles, r = s.routeIndex('ttc:504');
    let best = null, bd = 1e12;
    for (let i = 0; i < v.count; i++) if (v.route[i] === r) { const d = Math.hypot(v.x[i] + 975, v.y[i] + 867); if (d < bd) { bd = d; best = v.trip[i]; } }
    if (best !== null) window.__interact.follow(best);
    return best;
  });
  if (trip !== null) {
    await page.waitForTimeout(8000);
    await page.screenshot({ path: `${dir}/streetcar-504.png` });
    out.push('streetcar-504');
    await page.evaluate(() => window.__interact.leave?.(true));
  }
  return out.join(' ');
}
