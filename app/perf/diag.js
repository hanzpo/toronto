/* eslint-disable no-unused-expressions -- a playwright run-code function expression */
// Scene breakdown at a view (app/perf/run.sh <url> diag "cam=E,N,dist,hdg,pitch"):
// draw calls and triangles per top-level group / mesh name for everything that
// is visible and inside the camera frustum (approximates what three draws,
// excluding the shadow pass).
async page => {
  await page.waitForFunction(() => window.__engine && window.__app && window.__transit, null, { timeout: 90000 });
  const cam = (new URL(page.url()).searchParams.get('cam') || '-975,-867,30,90,7').split(',').map(Number);
  await page.evaluate((c) => { const e = window.__engine; e.controls.jumpTo({ e: c[0], n: c[1], h: e.heightAt(c[0], c[1]) + 1.5, dist: c[2], heading: c[3] * Math.PI / 180, pitch: c[4] * Math.PI / 180 }); }, cam);
  await page.waitForTimeout(12000);
  return page.evaluate(() => {
    const e = window.__engine;
    const cam = e.camera;
    cam.updateMatrixWorld();
    const pv = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const fr = new e.tiles.frustum.constructor();
    fr.setFromProjectionMatrix(pv, cam.coordinateSystem, cam.reversedDepth);
    const out = {};
    let draws = 0, tris = 0, casters = 0, casterTris = 0;
    const top = (o) => { let p = o; while (p && p.parent && p.parent !== e.scene) { p = p.parent; } return p ? (p.name || p.type) : '?'; };
    e.scene.traverseVisible((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints) return;
      const g = o.geometry; if (!g) return;
      const cnt = o.isInstancedMesh ? o.count : (o.isBatchedMesh ? 1 : 1);
      if (cnt === 0) return;
      if (o.frustumCulled !== false && !o.isInstancedMesh) {
        if (!g.boundingSphere) g.computeBoundingSphere();
        const s = g.boundingSphere.clone().applyMatrix4(o.matrixWorld);
        if (!fr.intersectsSphere(s)) return;
      }
      const idx = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
      const dr = g.drawRange.count === Infinity ? idx : Math.min(idx, g.drawRange.count);
      const t = (dr / 3) * (o.isInstancedMesh ? cnt : (g.isInstancedBufferGeometry ? g.instanceCount : 1));
      const k = top(o) + '/' + (o.name || o.material?.name || o.type);
      const r = out[k] || (out[k] = { d: 0, tM: 0 });
      r.d++; r.tM += t / 1e6; draws++; tris += t;
      if (o.castShadow) { casters++; casterTris += t; }
    });
    const rows = Object.entries(out).sort((a, b) => b[1].tM - a[1].tM).slice(0, 30).map(([k, v]) => `${k} d=${v.d} tris=${v.tM.toFixed(2)}M`);
    return JSON.stringify({ draws, trisM: +(tris / 1e6).toFixed(2), casters, casterTrisM: +(casterTris / 1e6).toFixed(2), rendererDraws: e.lastDrawCalls, rendererTrisM: +(e.lastTriangles / 1e6).toFixed(2), rows }, null, 1);
  });
}
