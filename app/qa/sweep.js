/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Viewpoint sweep batch (driven by app/qa/run.sh sweep). The job comes from
// localStorage "qa_job": {dir, time?, items:[{id, tag, file, pose:{e,n,h,dist,heading°,pitch°}}]}.
// For each pose: window.__qa.gotoPose, wait for tiles pending = 0 (20 s cap)
// + settle, sample the runtime counters, screenshot to <dir>/<file>.
// Returns a JSON array of per-item results (one manifest.jsonl line each).
async page => {
  await page.waitForFunction(() => window.__qa && window.__engine && window.__app, null, { timeout: 120000 });
  const job = JSON.parse(await page.evaluate(() => localStorage.getItem('qa_job')));
  await page.evaluate((t) => {
    const st = document.createElement('style'); st.textContent = '.hud{display:none!important}'; document.head.appendChild(st);
    if (t != null && window.__clock?.setTimeOfDay) window.__clock.setTimeOfDay(t);
  }, job.time ?? null);
  const settle = job.settleMs ?? 1200;
  const out = [];
  for (const it of job.items) {
    const t0 = Date.now();
    let err = null, ready = null, sample = null;
    try {
      await page.evaluate((p) => window.__qa.gotoPose(p), it.pose);
      ready = await page.evaluate(() => window.__qa.ready(20000));
      await page.waitForTimeout(settle);
      sample = await page.evaluate(() => {
        const s = window.__qa.sample();
        const c = {};
        for (const [k, v] of Object.entries(s)) if (v && typeof v === 'object' && 'count' in v) c[k] = { count: v.count, ex: v.examples.slice(0, 3) };
        return { cars: s.cars, transit: s.transit, counters: c, extra: s.extra };
      });
      await page.screenshot({ path: `${job.dir}/${it.file}` });
    } catch (e) { err = String(e?.message ?? e).slice(0, 300); }
    out.push({ id: it.id, tag: it.tag, pose: it.pose, note: it.note, file: it.file, ms: Date.now() - t0, pending: ready?.pending ?? null, sample, err });
  }
  return JSON.stringify(out);
}
