// Static HTML contact sheet for a QA tour folder (manifest.json) or a sweep
// folder (manifest.jsonl), grouped by category / tag.
//   node app/qa/sheet.mjs qa-shots/latest        -> qa-shots/latest/index.html
//   node app/qa/sheet.mjs qa-shots/sweep/<label> -> .../index.html
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const osmLink = (id) => {
  const n = Number(id);
  const t = n < 0 ? 'relation' : 'way';
  return `<a href="https://www.openstreetmap.org/${t}/${Math.abs(n)}">${Math.abs(n)}</a>`;
};
const counters = (run) => {
  const c = run?.sample?.counters;
  if (!c) return run?.err ? `<div class="err">${esc(run.err)}</div>` : '';
  const bad = Object.entries(c).filter(([, v]) => v.count > 0).map(([k, v]) => `${k} ${v.count}`);
  return `<div class="ctr">cars ${run.sample.cars ?? 0} · transit ${run.sample.transit ?? 0}${bad.length ? ' · <b>' + esc(bad.join(' · ')) + '</b>' : ''}${run.pending ? ` · <b>tiles pending ${run.pending}</b>` : ''}</div>`;
};

let title, groups = new Map(), meta = '';
if (fs.existsSync(path.join(dir, 'manifest.json'))) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  title = `QA tour: ${m.label}`;
  meta = `source ${esc(m.source)} · build ${esc(m.build)} · ${esc(m.generated)} · ${m.items.length} issues`;
  for (const it of m.items) {
    const card = `<figure>${it.shot ? `<a href="${esc(it.file)}"><img loading="lazy" src="${esc(it.file)}"></a>` : '<div class="miss">no shot</div>'}
<figcaption><b>#${it.rank}</b> ${esc(it.sub ?? '')} · sev ${esc(it.sev)}<br>${esc(it.desc)}<br>
<span class="c">E ${Math.round(it.e)} N ${Math.round(it.n)}${it.z != null ? ` z ${Number(it.z).toFixed(1)}` : ''}</span>
${it.osm?.length ? `<br>osm ${it.osm.map(osmLink).join(', ')}` : ''}${counters(it.run)}</figcaption></figure>`;
    if (!groups.has(it.cat)) groups.set(it.cat, []);
    groups.get(it.cat).push(card);
  }
} else if (fs.existsSync(path.join(dir, 'manifest.jsonl'))) {
  const rows = new Map();
  for (const l of fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); rows.set(r.id, r); }
  const list = [...rows.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : a.id < b.id ? -1 : 1));
  title = `QA sweep: ${path.basename(dir)}`;
  const ms = list.map((r) => r.ms).filter(Boolean);
  meta = `${list.length} viewpoints · median ${ms.length ? ms.sort((a, b) => a - b)[ms.length >> 1] : 0} ms per shot`;
  for (const r of list) {
    const p = r.pose ?? {};
    const card = `<figure>${fs.existsSync(path.join(dir, r.file)) ? `<a href="${esc(r.file)}"><img loading="lazy" src="${esc(r.file)}"></a>` : '<div class="miss">no shot</div>'}
<figcaption><b>${esc(r.id)}</b> ${esc(r.note ?? '')}<br><span class="c">E ${Math.round(p.e)} N ${Math.round(p.n)} · hdg ${Math.round(p.heading ?? 0)}° pitch ${Math.round(p.pitch ?? 0)}° dist ${Math.round(p.dist ?? 0)}</span>${counters(r)}</figcaption></figure>`;
    if (!groups.has(r.tag)) groups.set(r.tag, []);
    groups.get(r.tag).push(card);
  }
} else {
  console.error(`no manifest.json / manifest.jsonl in ${dir}`);
  process.exit(1);
}

const keys = [...groups.keys()].sort();
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:13px/1.35 system-ui,sans-serif;margin:16px;background:#f4f4f2;color:#222}
h1{font-size:18px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #ccc}
nav a{margin-right:10px} .meta{color:#666;margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden}
img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover}
figcaption{padding:6px 8px} .c{color:#666;font-family:ui-monospace,monospace;font-size:12px}
.ctr{margin-top:4px;color:#555;font-size:12px} .ctr b{color:#b3261e} .err{color:#b3261e}
.miss{aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:#eee;color:#999}
@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ddd}figure{background:#262625;border-color:#333}.c,.meta,.ctr{color:#999}h2{border-color:#444}}
</style></head><body><h1>${esc(title)}</h1><div class="meta">${meta}</div>
<nav>${keys.map((k) => `<a href="#${esc(k)}">${esc(k)} (${groups.get(k).length})</a>`).join('')}</nav>
${keys.map((k) => `<h2 id="${esc(k)}">${esc(k)} (${groups.get(k).length})</h2><div class="grid">${groups.get(k).join('\n')}</div>`).join('\n')}
</body></html>`;
fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log(path.join(dir, 'index.html'));
