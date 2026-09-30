/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Draw-call census (app/perf/run.sh <url> draws "cam=E,N,dist,hdg,pitch"): wraps
// renderer.renderObject for one frame and counts draws / triangles per
// top-level group and mesh name, separately for the main and shadow passes.
async page => {
  await page.waitForFunction(() => window.__engine && window.__app && window.__transit, null, { timeout: 90000 });
  const cam = (new URL(page.url()).searchParams.get('cam') || '-975,-867,30,90,7').split(',').map(Number);
  await page.evaluate((c) => { const e = window.__engine; e.controls.jumpTo({ e: c[0], n: c[1], h: e.heightAt(c[0], c[1]) + 1.5, dist: c[2], heading: c[3] * Math.PI / 180, pitch: c[4] * Math.PI / 180 }); }, cam);
  await page.waitForTimeout(14000);
  return page.evaluate(async () => {
    const e = window.__engine, r = e.renderer;
    const orig = r.renderObject;
    const rows = {};
    const top = (o) => { let p = o; while (p.parent && p.parent.parent) p = p.parent; return p.name || p.type; };
    r.renderObject = function (object, scene, camera, geometry, material, group, ...rest) {
      const pass = camera.isOrthographicCamera ? 'shadow' : 'main';
      const lvl = /^\d\//.test(object.parent?.name ?? '') ? `:L${object.parent.name[0]}` : '';
      const k = `${pass} ${top(object)}/${object.name || material.name || object.type}${lvl}`;
      const row = rows[k] || (rows[k] = { d: 0, t: 0 });
      row.d++;
      const idx = geometry.index ? geometry.index.count : geometry.attributes.position.count;
      row.t += idx / 3 * (object.isInstancedMesh ? object.count : 1);
      return orig.call(this, object, scene, camera, geometry, material, group, ...rest);
    };
    await new Promise((res) => requestAnimationFrame(res));
    r.renderObject = orig;
    const tot = { main: 0, shadow: 0 };
    for (const [k, v] of Object.entries(rows)) tot[k.split(' ')[0]] += v.d;
    const list = Object.entries(rows).sort((a, b) => b[1].d - a[1].d).map(([k, v]) => `${k} d=${v.d} t=${(v.t / 1e6).toFixed(2)}M`);
    return JSON.stringify({ tot, rendererDraws: e.lastDrawCalls, list }, null, 1);
  });
}
