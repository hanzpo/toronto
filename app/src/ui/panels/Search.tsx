// Search: rail stations, routes (short/long name) and places/municipalities.
import { useMemo, useState } from 'react';
import { getEngine } from '../../engine/instance';
import { useInteract } from '../../interact/state';
import { useApp } from '../../state/store';
import { RouteBadge } from './InfoPanels';
import { Icon } from '../icons';
import { MODE_LABEL, getInteract, getTransit } from './common';

const PLACES: { name: string; e: number; n: number; dist: number }[] = [
  { name: 'Union Station', e: 210, n: -880, dist: 1400 },
  { name: 'CN Tower', e: -700, n: -1300, dist: 1200 },
  { name: 'City Hall', e: 0, n: 0, dist: 900 },
  { name: 'Yonge–Dundas Square', e: 240, n: 320, dist: 900 },
  { name: 'Rogers Centre', e: -880, n: -1450, dist: 1200 },
  { name: 'Scotiabank Arena', e: 180, n: -1150, dist: 900 },
  { name: 'Kensington Market', e: -1150, n: 250, dist: 900 },
  { name: 'Distillery District', e: 1850, n: -620, dist: 900 },
  { name: 'Toronto Island', e: -300, n: -3200, dist: 3500 },
  { name: 'Don Valley Parkway', e: 2600, n: 3500, dist: 4000 },
  { name: 'Gardiner Expressway', e: -1500, n: -1500, dist: 3000 },
  { name: 'High Park', e: -6550, n: 150, dist: 2500 },
  { name: 'Yorkdale', e: -5400, n: 9900, dist: 2000 },
  { name: 'Scarborough Town Centre', e: 13400, n: 12900, dist: 2500 },
  { name: 'Pearson Airport', e: -19870, n: 2640, dist: 7000 },
  { name: 'Billy Bishop Airport', e: -1300, n: -2200, dist: 1800 },
  { name: 'Hamilton', e: -39130, n: -44140, dist: 12000 },
  { name: 'Niagara Falls', e: 24040, n: -62680, dist: 9000 },
  { name: 'Kitchener', e: -89340, n: -22460, dist: 12000 },
  { name: 'Barrie', e: -24400, n: 81770, dist: 12000 },
  { name: 'Oshawa', e: 41600, n: 27100, dist: 10000 },
  { name: 'Whole region', e: -17750, n: 11400, dist: 230000 },
];

type Hit =
  | { kind: 'place'; name: string; e: number; n: number; dist: number; score: number }
  | { kind: 'station'; name: string; e: number; n: number; sub: string; score: number }
  | { kind: 'route'; name: string; route: number; score: number };

function score(q: string, s: string): number {
  const a = s.toLowerCase();
  if (a === q) return 100;
  if (a.startsWith(q)) return 80;
  const i = a.indexOf(q);
  if (i < 0) return 0;
  return a[i - 1] === ' ' || a[i - 1] === '(' ? 60 : 40;
}

export function SearchBox() {
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(0);
  const sys = getTransit()?.system;
  const munis = getEngine()?.tiles.manifest.municipalities;
  const hits = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return [] as Hit[];
    const out: Hit[] = [];
    for (const p of PLACES) { const s = score(qq, p.name); if (s) out.push({ kind: 'place', ...p, score: s }); }
    for (const m of munis ?? []) {
      if (PLACES.some((p) => p.name === m.name)) continue;
      const s = score(qq, m.name);
      if (s) out.push({ kind: 'place', name: m.name, e: m.label[0], n: m.label[1], dist: 9000, score: s - 5 });
    }
    for (const st of sys?.index?.stations ?? []) {
      const s = score(qq, st.name);
      if (s) out.push({ kind: 'station', name: st.name, e: st.pos[0], n: st.pos[1], sub: st.modes.map((m) => MODE_LABEL[m]).join(' · '), score: s + 8 });
    }
    sys?.routes.forEach((r, i) => {
      const lineName = /^\d$/.test(r.short) && r.mode === 'subway' || r.mode === 'lrt' ? `Line ${r.short}` : '';
      const s = Math.max(score(qq, r.short) + (r.mode === 'bus' ? 0 : 6), score(qq, r.long), lineName ? score(qq, lineName) + 5 : 0, score(qq, `${r.short} ${r.long}`));
      if (s > 6) out.push({ kind: 'route', name: `${r.short} ${r.long}`, route: i, score: s + (r.mode === 'bus' ? 0 : 4) });
    });
    return out.sort((a, b) => b.score - a.score).slice(0, 10);
  }, [q, sys, munis]);

  const go = (h: Hit) => {
    const eng = getEngine();
    const ia = getInteract();
    if (!eng) return;
    if (h.kind === 'place') {
      eng.controls.flyTo({ e: h.e, n: h.n, dist: h.dist, pitch: h.dist > 50000 ? 1.2 : 0.7 }, 2.6);
    } else if (h.kind === 'station') {
      eng.controls.flyTo({ e: h.e, n: h.n, dist: 600, pitch: 0.75 }, 2.4);
      const stop = ia?.nearestStop(h.e, h.n, 400, true) ?? -1;
      if (stop >= 0) ia?.selectStop(stop);
    } else {
      useInteract.getState().set({ highlightRoute: h.route });
      const b = ia?.routeBounds(h.route);
      if (b) eng.controls.flyTo({ e: b.e, n: b.n, dist: Math.max(1500, b.size * 1.3), pitch: 0.95 }, 2.4);
      const r = getTransit()?.system.routes[h.route];
      useApp.getState().select(null);
      if (r) ia?.toast(`${r.short} ${r.long} highlighted · click a vehicle to follow it`);
    }
    setQ(''); setSel(0);
    (document.activeElement as HTMLElement)?.blur();
  };

  return (
    <div className="search panel">
      <Icon.search />
      <input
        placeholder="Search stations, routes, places…" value={q}
        onChange={(e) => { setQ(e.target.value); setSel(0); }} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[sel]) go(hits[sel]);
          else if (e.key === 'ArrowDown') { setSel((s) => Math.min(hits.length - 1, s + 1)); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { setSel((s) => Math.max(0, s - 1)); e.preventDefault(); }
          else if (e.key === 'Escape') (e.target as HTMLElement).blur();
        }}
      />
      {focus && hits.length > 0 && (
        <ul className="search-results">
          {hits.map((h, i) => {
            const r = h.kind === 'route' ? sys?.routes[h.route] : null;
            return (
              <li key={`${h.kind}:${h.name}:${i}`}>
                <button className={`sr ${i === sel ? 'sel' : ''}`} onMouseDown={() => go(h)} onMouseEnter={() => setSel(i)}>
                  {r ? <RouteBadge short={r.short} color={r.color} text={r.textColor} /> : <span className={`sr-ico ${h.kind}`}>{h.kind === 'station' ? <Icon.station /> : <Icon.place />}</span>}
                  <span className="sr-name">{r ? r.long : h.name}</span>
                  <small>{h.kind === 'route' ? `${MODE_LABEL[r!.mode]} route` : h.kind === 'station' ? h.sub : 'place'}</small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
