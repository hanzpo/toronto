/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Visual QA tour batch (driven by app/qa/run.sh tour). The job comes from
// localStorage "qa_job": {dir, issuesFile?, time?, items:[{id, file}]}. For each
// issue: window.__qa.goto(id) (camera framed by the issue's `view`), wait for
// tiles pending = 0 (20 s cap) + 1.5 s, sample the runtime counters, screenshot
// to <dir>/<file>. Returns a JSON array of per-item results.
async page => {
  await page.waitForFunction(() => window.__qa && window.__engine && window.__app, null, { timeout: 120000 });
  const job = JSON.parse(await page.evaluate(() => localStorage.getItem('qa_job')));
  await page.evaluate((t) => {
    const st = document.createElement('style'); st.textContent = '.hud{display:none!important}'; document.head.appendChild(st);
    if (t != null && window.__clock?.setTimeOfDay) window.__clock.setTimeOfDay(t);
  }, job.time ?? null);
  const out = [];
  for (const it of job.items) {
    const t0 = Date.now();
    let err = null, ready = null, sample = null;
    try {
      await page.evaluate(async ({ id, file }) => { await window.__qa.goto(id, file ? `${window.__engine.dataRoot}/qa/${file}` : undefined); }, { id: it.id, file: job.issuesFile });
      ready = await page.evaluate(() => window.__qa.ready(20000));
      await page.waitForTimeout(1500);
      sample = await page.evaluate(() => {
        const s = window.__qa.sample();
        const c = {};
        for (const [k, v] of Object.entries(s)) if (v && typeof v === 'object' && 'count' in v) c[k] = { count: v.count, ex: v.examples.slice(0, 3) };
        return { cars: s.cars, transit: s.transit, counters: c, extra: s.extra };
      });
      await page.screenshot({ path: `${job.dir}/${it.file}` });
    } catch (e) { err = String(e?.message ?? e).slice(0, 300); }
    out.push({ id: it.id, file: it.file, ms: Date.now() - t0, pending: ready?.pending ?? null, sample, err });
  }
  return JSON.stringify(out);
}
