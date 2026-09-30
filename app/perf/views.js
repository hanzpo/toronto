/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Fixed-view budget census (app/perf/run.sh <url> views "t=2026-09-30T13:00:00&out=/abs/dir&tag=before"):
// for each view, jump, wait for tiles to settle, then
//  - census over ~6 frames (per-frame averages): draws / triangles per top-level group and mesh, split by
//    main and shadow pass (counted from renderer.info.update, so exact), plus
//    the submit ms spent inside renderObject per pass;
//  - 3 s averages: renderer draws / triangles, main-thread ms per layer (engine.perf.acc);
//  - renderer.info.memory and TileManager bytes;
//  - a screenshot `<out>/<view>-<tag>.png`.
// Camera collision is switched off so the views stay at street level (a lift
// over nearby buildings would otherwise turn them into roof views); `collide=1` keeps it.
// `cull=0` in the query runs the same views without this pass's culling (A/B).
// The Vite HMR websocket is stubbed so other agents' edits don't reload the page.
async page => {
  const url = new URL(page.url());
  const dir = url.searchParams.get('out') || '/tmp';
  const tag = url.searchParams.get('tag') || 'run';
  const only = url.searchParams.get('views');
  const secs = Number(url.searchParams.get('secs') || 3);
  const collide = url.searchParams.get('collide') === '1';
  await page.routeWebSocket(/.*/, () => { /* swallow HMR */ });
  await page.reload();
  await page.waitForFunction(() => window.__engine && window.__app && window.__transit, null, { timeout: 120000 });
  const views = [
    ['king-spadina', [-1180, -620, 60, 40, 12]],
    ['gardiner-spadina', [-842, -1248, 124.6, 343, 10]],
    ['harbour', [-600, -1500, 800, 0, 35]],
    ['dvp', [2600, 1800, 250, 20, 25]],
    ['glencairn', [-4610, 6133, 150, 0, 30]],
    ['pearson', [-18400, 2600, 350, 200, 30]],
    // King St W at eye level looking east (the King & Spadina view above ends up against a facade without camera collision)
    ['king-street', [-975, -867, 30, 90, 7]],
    // landmark cluster up close (Union, the towers, CN Tower)
    ['union', [-150, -1050, 220, 20, 25]],
  ].filter(([n]) => !only || only.split(',').includes(n));
  const out = [];
  for (const [name, c] of views) {
    await page.evaluate(([c, collide]) => { const e = window.__engine; window.__interact?.leave?.(true); e.controls.collide = collide; e.controls.jumpTo({ e: c[0], n: c[1], h: e.heightAt(c[0], c[1]) + 1.5, dist: c[2], heading: c[3] * Math.PI / 180, pitch: c[4] * Math.PI / 180 }); }, [c, collide]);
    const t0 = Date.now();
    await page.waitForTimeout(3000);
    while (Date.now() - t0 < 30000 && await page.evaluate(() => window.__app.getState().stats.tilesPending) > 0) await page.waitForTimeout(500);
    await page.waitForTimeout(2500);
    const census = await page.evaluate(async () => {
      const e = window.__engine, r = e.renderer, info = r.info;
      const origRO = r.renderObject, origUp = info.update;
      const rows = {}, top = {}, submit = { main: 0, shadow: 0 };
      let key = null, pass = 'main';
      const f0 = e.perf.frames;
      const topOf = (o) => { let p = o; while (p.parent && p.parent.parent) p = p.parent; return p.name || p.type; };
      r.renderObject = function (object, scene, camera, geometry, material, ...rest) {
        pass = camera.isOrthographicCamera ? 'shadow' : 'main';
        const lvl = /^\d\//.test(object.parent?.name ?? '') ? `:L${object.parent.name[0]}` : '';
        const tp = topOf(object);
        key = [pass, tp, `${tp}/${object.name || material.name || object.type}${lvl}`];
        const t = performance.now();
        const res = origRO.call(this, object, scene, camera, geometry, material, ...rest);
        submit[pass] += performance.now() - t;
        return res;
      };
      info.update = function (object, count, instanceCount) {
        const d0 = this.render.drawCalls, t0 = this.render.triangles;
        origUp.call(this, object, count, instanceCount);
        if (key) {
          const dd = this.render.drawCalls - d0, dt = this.render.triangles - t0;
          const a = rows[key[0] + ' ' + key[2]] || (rows[key[0] + ' ' + key[2]] = { d: 0, t: 0 });
          a.d += dd; a.t += dt;
          const b = top[key[0] + ' ' + key[1]] || (top[key[0] + ' ' + key[1]] = { d: 0, t: 0 });
          b.d += dd; b.t += dt;
        }
      };
      for (let i = 0; i < 6; i++) await new Promise((res) => requestAnimationFrame(res));
      r.renderObject = origRO; info.update = origUp;
      const nf = Math.max(1, e.perf.frames - f0);
      for (const o of [rows, top]) for (const v of Object.values(o)) { v.d /= nf; v.t /= nf; }
      submit.main /= nf; submit.shadow /= nf;
      const tot = { main: { d: 0, t: 0 }, shadow: { d: 0, t: 0 } };
      for (const [k, v] of Object.entries(top)) { const p = tot[k.split(' ')[0]]; p.d += v.d; p.t += v.t; }
      const fmt = (o, n) => Object.entries(o).sort((a, b) => b[1].t - a[1].t).slice(0, n).map(([k, v]) => `${k} d=${+v.d.toFixed(1)} t=${(v.t / 1e6).toFixed(3)}M`);
      return {
        frames: nf, main: `${tot.main.d.toFixed(1)} draws ${(tot.main.t / 1e6).toFixed(2)}M`, shadow: `${tot.shadow.d.toFixed(1)} draws ${(tot.shadow.t / 1e6).toFixed(2)}M`,
        submitMs: { main: +submit.main.toFixed(2), shadow: +submit.shadow.toFixed(2) },
        groups: fmt(top, 40), meshes: fmt(rows, 45),
        byDraws: Object.entries(rows).sort((a, b) => b[1].d - a[1].d).slice(0, 25).map(([k, v]) => `${k} d=${+v.d.toFixed(1)} t=${(v.t / 1e6).toFixed(3)}M`),
      };
    });
    const avg = await page.evaluate(async (secs) => {
      const e = window.__engine, p = e.perf;
      p.reset();
      const t0 = performance.now(); let fr = 0;
      await new Promise((res) => { const f = () => { fr++; if (performance.now() - t0 < secs * 1000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      const n = Math.max(1, p.frames);
      const parts = Object.entries(p.acc).map(([k, v]) => [k, v / n]).filter(([, v]) => v >= 0.03).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ');
      const st = window.__app.getState().stats, mem = e.renderer.info.memory;
      return { occluded: e.tiles.occluded, horizonUsed: e.tiles.horizon.used, fps: +(fr / ((performance.now() - t0) / 1000)).toFixed(1), cpuAvg: +(p.cpuMs / n).toFixed(2), cpuMax: +p.cpuMax.toFixed(1), draws: Math.round(p.draws / n), drawsMax: p.drawsMax, trisM: +(p.tris / n / 1e6).toFixed(2), trisMaxM: +(p.trisMax / 1e6).toFixed(2), parts, mem: { geo: mem.geometries, tex: mem.textures, tileMB: Math.round(st.gpuMB) }, tiles: `${st.tilesVisible}/${st.tilesLoaded}`, pending: st.tilesPending, quality: st.quality };
    }, secs);
    await page.screenshot({ path: `${dir}/${name}-${tag}.png` });
    out.push({ name, ...avg, census });
  }
  return JSON.stringify(out);
}
