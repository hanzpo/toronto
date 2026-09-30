// HUD overlay. React only for UI — the render loop never waits on React.
import { useEffect, useRef, useState } from 'react';
import { useApp, type AnalyticsKey, type BaseLayerKey } from '../state/store';
import { SPEEDS, clock, dayTypeOf, type DayType } from '../state/clock';
import { getEngine } from '../engine/instance';
import { Panels } from './panels/Panels';
import { SearchBox } from './panels/Search';
import { useInteract } from '../interact/state';

// ---------------------------------------------------------------------------- helpers

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SPEED_LABEL = (s: number) => (s >= 3600 ? `${s / 3600}h/s` : s >= 60 ? `${s / 60}m/s` : `${s}×`);

function useSimClock(hz = 8) {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
  return clock.parts();
}

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const s = useApp.getState();
      if (e.code === 'Space') { e.preventDefault(); s.togglePlay(); }
      else if (e.key === ']') s.faster();
      else if (e.key === '[') s.slower();
      else if (e.key === 'v' || e.key === 'V') s.setAnalyticsMode(!s.analyticsMode);
      else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hud-hidden');
      else if (e.key === 'Home') getEngine()?.controls.flyTo({ e: -350, n: -700, dist: 3200, heading: -0.35, pitch: 0.62 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---------------------------------------------------------------------------- top bar

function TopBar() {
  const p = useSimClock();
  const playing = useApp((s) => s.playing);
  const speedIndex = useApp((s) => s.speedIndex);
  const override = useApp((s) => s.dayTypeOverride);
  const setOverride = useApp((s) => s.setDayTypeOverride);
  const autoDay = dayTypeOf(clock.serviceDay().weekday);
  const day: DayType = override ?? autoDay;
  const [drag, setDrag] = useState<number | null>(null);
  const sec = drag ?? p.secOfDay;
  const cycle = () => {
    const order: (DayType | null)[] = [null, 'weekday', 'saturday', 'sunday'];
    setOverride(order[(order.indexOf(override) + 1) % order.length]);
  };

  return (
    <header className="topbar panel">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <i style={{ background: 'var(--l1)' }} /><i style={{ background: 'var(--l2)' }} /><i style={{ background: 'var(--go)' }} />
        </span>
        <span className="brand-name">GTA<b>·</b>TWIN</span>
      </div>

      <div className="clock">
        <div className="clock-time">
          {pad(p.hour)}<span className="blink">:</span>{pad(p.minute)}<small>:{pad(p.second)}</small>
        </div>
        <div className="clock-date">
          <span>{DAY_NAMES[p.weekday]} {p.day} {MONTHS[p.month - 1]} {p.year}</span>
          <button className={`daytype ${override ? 'forced' : ''}`} onClick={cycle} title="Service day profile — click to override">
            {day}{override ? ' ·ovr' : ''}
          </button>
        </div>
      </div>

      <div className="transport">
        <button className="btn play" onClick={() => useApp.getState().togglePlay()} title="Play / pause (Space)">
          {playing ? (
            <svg viewBox="0 0 16 16"><rect x="3" y="2" width="3.5" height="12" /><rect x="9.5" y="2" width="3.5" height="12" /></svg>
          ) : (
            <svg viewBox="0 0 16 16"><path d="M4 2 L14 8 L4 14 Z" /></svg>
          )}
        </button>
        <div className="speeds" role="group" aria-label="Simulation speed">
          {SPEEDS.slice(1).map((s, i) => (
            <button key={s} className={`speed ${speedIndex === i + 1 ? 'on' : ''}`} onClick={() => useApp.getState().setSpeedIndex(i + 1)} title="[ / ] to change">
              {SPEED_LABEL(s)}
            </button>
          ))}
        </div>
      </div>

      <div className="scrub">
        <input
          type="range" min={0} max={86399} step={60} value={Math.floor(sec)}
          onChange={(e) => { const v = +e.target.value; setDrag(v); clock.setTimeOfDay(v); }}
          onPointerUp={() => setDrag(null)} onBlur={() => setDrag(null)}
          aria-label="Time of day"
        />
        <div className="scrub-ticks" aria-hidden>
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <span key={h}>{pad(h % 24)}</span>)}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------- layers

const BASE: { k: BaseLayerKey; label: string }[] = [
  { k: 'terrain', label: 'Terrain' }, { k: 'buildings', label: 'Buildings' }, { k: 'houses', label: 'Houses' },
  { k: 'roads', label: 'Roads' }, { k: 'rail', label: 'Rail' }, { k: 'labels', label: 'Labels' },
];

const ANALYTICS: { k: AnalyticsKey; label: string; color: string; sub?: string }[] = [
  { k: 'subway', label: 'Subway', color: 'var(--l1)', sub: 'Lines 1 · 2 · 4' },
  { k: 'streetcar', label: 'Streetcar', color: 'var(--ttc)' },
  { k: 'lrt', label: 'LRT', color: 'var(--l5)', sub: 'Lines 5 · 6' },
  { k: 'go', label: 'GO Transit', color: 'var(--go)' },
  { k: 'upx', label: 'UP Express', color: 'var(--upx)' },
  { k: 'via', label: 'VIA Rail', color: 'var(--via)' },
  { k: 'bus', label: 'Buses', color: 'var(--bus)' },
  { k: 'vehicles', label: 'Live vehicles', color: 'var(--live)', sub: 'schedule positions' },
  { k: 'congestion', label: 'Congestion', color: 'var(--warn)', sub: 'major roads · model + live' },
  { k: 'air', label: 'Air traffic', color: '#9fb4ff', sub: 'YYZ · YTZ · YHM · YKF' },
];

function LayersPanel() {
  const layers = useApp((s) => s.layers);
  const analytics = useApp((s) => s.analytics);
  const mode = useApp((s) => s.analyticsMode);
  const shadows = useApp((s) => s.shadows);
  const quality = useApp((s) => s.quality);
  const [open, setOpen] = useState(true);
  const st = useApp.getState();
  return (
    <aside className={`layers panel ${open ? '' : 'collapsed'}`}>
      <button className="panel-head" onClick={() => setOpen(!open)}>
        <span>Layers</span><span className="chev">{open ? '–' : '+'}</span>
      </button>
      {open && (
        <div className="panel-body">
          <label className={`mode-switch ${mode ? 'on' : ''}`}>
            <input type="checkbox" checked={mode} onChange={() => st.setAnalyticsMode(!mode)} />
            <span className="mode-track"><span className="mode-knob" /></span>
            <span className="mode-text"><b>Analytics mode</b><small>dim base map · V</small></span>
          </label>

          <h4>Analytics</h4>
          <ul className="lines">
            {ANALYTICS.map(({ k, label, color, sub }) => (
              <li key={k}>
                <button className={`line ${analytics[k] ? 'on' : ''}`} onClick={() => st.toggleAnalytics(k)} style={{ ['--c' as string]: color }}>
                  <span className="line-swatch" />
                  <span className="line-label">{label}{sub && <small>{sub}</small>}</span>
                  <span className="line-state">{analytics[k] ? 'ON' : 'OFF'}</span>
                </button>
              </li>
            ))}
          </ul>

          <h4>Base map</h4>
          <div className="chips">
            {BASE.map(({ k, label }) => (
              <button key={k} className={`chip ${layers[k] ? 'on' : ''}`} onClick={() => st.toggleLayer(k)}>{label}</button>
            ))}
            <button className={`chip ${shadows ? 'on' : ''}`} onClick={() => st.setShadows(!shadows)}>Shadows</button>
          </div>

          <h4>Quality</h4>
          <div className="chips" title="Auto adapts detail and resolution to hold 60 fps">
            {(['auto', 'high', 'medium', 'low'] as const).map((q) => (
              <button key={q} className={`chip ${quality === q ? 'on' : ''}`} onClick={() => st.setQuality(q)}>{q[0].toUpperCase() + q.slice(1)}</button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------- stats

function Stats() {
  const s = useApp((x) => x.stats);
  const [open, setOpen] = useState(true);
  const fpsClass = s.fps >= 55 ? 'good' : s.fps >= 30 ? 'ok' : 'bad';
  return (
    <div className={`stats panel ${open ? '' : 'collapsed'}`} onClick={() => setOpen(!open)} title="click to collapse">
      <div className="stat-main"><b className={fpsClass}>{s.fps.toFixed(0)}</b><span>fps</span><em>{s.frameMs.toFixed(1)} ms cpu</em></div>
      {open && (
        <dl>
          <dt>draw</dt><dd>{s.drawCalls}</dd>
          <dt>tris</dt><dd>{(s.triangles / 1e6).toFixed(2)} M</dd>
          <dt>tiles</dt><dd>{s.tilesVisible} / {s.tilesLoaded}{s.tilesPending ? <i> +{s.tilesPending}</i> : null}</dd>
          <dt>gpu</dt><dd>≈{s.gpuMB.toFixed(0)} MB</dd>
          <dt>alt</dt><dd>{s.altitude < 1000 ? `${s.altitude.toFixed(0)} m` : `${(s.altitude / 1000).toFixed(1)} km`}</dd>
          <dt>pos</dt><dd>{(s.cameraE / 1000).toFixed(2)}E {(s.cameraN / 1000).toFixed(2)}N</dd>
          <dt>gfx</dt><dd className="backend">{s.backend}</dd>
          <dt>detail</dt><dd>{s.quality}</dd>
        </dl>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- compass + scale

function Compass() {
  const needle = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const e = getEngine();
      if (e && needle.current) needle.current.style.transform = `rotate(${-e.controls.cur.heading}rad)`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const north = () => {
    const e = getEngine();
    if (e) e.controls.flyTo({ e: e.controls.cur.e, n: e.controls.cur.n, heading: 0 }, 0.8);
  };
  return (
    <button className="compass panel" onClick={north} title="Reset to north">
      <div ref={needle} className="compass-rose">
        <span className="n">N</span>
        <svg viewBox="0 0 40 40"><path d="M20 5 L25 20 L20 18 L15 20 Z" className="up" /><path d="M20 35 L25 20 L20 22 L15 20 Z" className="down" /></svg>
      </div>
    </button>
  );
}

function ScaleBar() {
  const mpp = useApp((s) => s.stats.metersPerPixel);
  const target = mpp * 110;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].map((m) => m * pow).filter((v) => v <= target).pop() ?? pow;
  const px = nice / mpp;
  const label = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
  return (
    <div className="scalebar">
      <div className="scalebar-bar" style={{ width: `${px}px` }}><i /><i /></div>
      <span>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------- root

export function Hud() {
  useKeyboardShortcuts();
  const mode = useApp((s) => s.analyticsMode);
  const selected = useApp((s) => s.selected);
  const takeover = useInteract((s) => s.mode !== 'free');
  return (
    <div className={`hud ${mode ? 'analytics' : ''} ${takeover ? 'takeover' : ''}`}>
      <TopBar />
      <SearchBox />
      <LayersPanel />
      <Stats />
      <div className="navcluster">
        <ScaleBar />
        <Compass />
      </div>
      <Panels />
      {selected && selected.kind !== 'vehicle' && selected.kind !== 'stop' && selected.kind !== 'aircraft' && (
        <div className="selection panel">
          <small>{selected.kind}</small>
          <b>{selected.label ?? selected.id}</b>
          <button onClick={() => useApp.getState().select(null)}>×</button>
        </div>
      )}
      <div className="hint">click a vehicle or station · drag pan · right-drag rotate · wheel zoom · WASD/QE · space pause · [ ] speed · V analytics · H hide</div>
    </div>
  );
}
