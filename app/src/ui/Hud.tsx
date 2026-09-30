// HUD overlay. React only for UI — the render loop never waits on React.
import { useEffect, useRef, useState } from 'react';
import { useApp, type AnalyticsKey, type BaseLayerKey } from '../state/store';
import { SPEEDS, clock, dayTypeOf, type DayType } from '../state/clock';
import { getEngine } from '../engine/instance';
import { Panels } from './panels/Panels';
import { SearchBox } from './panels/Search';
import { useInteract } from '../interact/state';
import { Icon } from './icons';

// ---------------------------------------------------------------------------- helpers

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SPEED_LABEL = (s: number) => (s >= 3600 ? `${s / 3600} h/s` : s >= 60 ? `${s / 60} m/s` : `${s}×`);
const DAY_LABEL: Record<DayType, string> = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday' };

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
      <div className="transport">
        <button className="btn play" onClick={() => useApp.getState().togglePlay()} title={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Icon.pause /> : <Icon.play />}
        </button>
        <div className="seg speeds" role="group" aria-label="Simulation speed">
          {SPEEDS.slice(1).map((s, i) => (
            <button key={s} className={speedIndex === i + 1 ? 'on' : ''} onClick={() => useApp.getState().setSpeedIndex(i + 1)} title="Simulation speed ( [ and ] )">
              {SPEED_LABEL(s)}
            </button>
          ))}
        </div>
      </div>

      <div className="clock">
        <div className="clock-time" aria-label="Simulation time">
          {pad(p.hour)}:{pad(p.minute)}<small>:{pad(p.second)}</small>
        </div>
        <div className="clock-date">
          <span>{DAY_NAMES[p.weekday]} {p.day} {MONTHS[p.month - 1]}</span>
          <button className={`daytype ${override ? 'forced' : ''}`} onClick={cycle} title="Service-day timetable (click to override)">
            {DAY_LABEL[day]}{override ? ' · set' : ''}
          </button>
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
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <span key={h} className={h % 6 ? 'minor' : ''}>{pad(h % 24)}</span>)}
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
  { k: 'lrt', label: 'LRT', color: 'var(--l5)', sub: 'Lines 5 · 6 · ION' },
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
  // remembered across loads / mode changes; collapsed by default on all but wide windows
  const [open, setOpenRaw] = useState(() => {
    try {
      const v = localStorage.getItem('layersPanelOpen');
      if (v === '1' || v === '0') return v === '1';
    } catch { /* storage blocked */ }
    return window.innerWidth >= 1600;
  });
  const setOpen = (o: boolean) => {
    setOpenRaw(o);
    try { localStorage.setItem('layersPanelOpen', o ? '1' : '0'); } catch { /* storage blocked */ }
  };
  const st = useApp.getState();
  return (
    <aside className={`layers panel ${open ? '' : 'collapsed'}`}>
      <button className="panel-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon.layers /><span>Layers</span><span className="chev">{open ? <Icon.chevronUp /> : <Icon.chevronDown />}</span>
      </button>
      {open && (
        <div className="panel-body">
          <label className={`mode-switch ${mode ? 'on' : ''}`}>
            <input type="checkbox" checked={mode} onChange={() => st.setAnalyticsMode(!mode)} />
            <span className="mode-track"><span className="mode-knob" /></span>
            <span className="mode-text"><b>Analytics mode</b><small>Dim the base map</small></span>
            <kbd>V</kbd>
          </label>

          <h4>Analytics</h4>
          <ul className="lines">
            {ANALYTICS.map(({ k, label, color, sub }) => (
              <li key={k}>
                <button className={`line ${analytics[k] ? 'on' : ''}`} onClick={() => st.toggleAnalytics(k)} style={{ ['--c' as string]: color }}>
                  <span className="line-swatch" />
                  <span className="line-label">{label}{sub && <small>{sub}</small>}</span>
                  <span className="switch" aria-hidden><i /></span>
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
  const [open, setOpen] = useState(() => window.innerWidth >= 1280);
  const fpsClass = s.fps >= 55 ? 'good' : s.fps >= 30 ? 'ok' : 'bad';
  return (
    <div className={`stats panel ${open ? '' : 'collapsed'}`} onClick={() => setOpen(!open)} title={open ? 'Hide details' : 'Show details'}>
      <div className="stat-main"><b className={fpsClass}>{s.fps.toFixed(0)}</b><span>fps</span><em>{s.frameMs.toFixed(1)} ms</em></div>
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
        <svg viewBox="0 0 40 40" aria-hidden><path d="M20 6 L25 20 L15 20 Z" className="up" /><path d="M20 34 L25 20 L15 20 Z" className="down" /></svg>
        <span className="n">N</span>
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

// ---------------------------------------------------------------------------- shortcuts

const KEYS: [string[], string][] = [
  [['Click'], 'Select a vehicle or station'],
  [['Drag'], 'Pan'],
  [['Right-drag'], 'Rotate / tilt'],
  [['Scroll'], 'Zoom'],
  [['W', 'A', 'S', 'D'], 'Move'],
  [['Q', 'E'], 'Turn'],
  [['Space'], 'Play / pause'],
  [['[', ']'], 'Slower / faster'],
  [['V'], 'Analytics mode'],
  [['H'], 'Hide the interface'],
  [['Home'], 'Back to downtown'],
];

function Shortcuts() {
  const [open, setOpen] = useState(false);
  return (
    <div className="shortcuts">
      <button className={`iconbtn panel ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Keyboard & mouse" aria-label="Keyboard and mouse shortcuts" aria-expanded={open}>
        <Icon.keyboard />
      </button>
      {open && (
        <div className="keys-pop panel" onClick={() => setOpen(false)}>
          <h4>Controls</h4>
          <dl>
            {KEYS.map(([k, what]) => (
              <div key={what}><dt>{k.map((x) => <kbd key={x}>{x}</kbd>)}</dt><dd>{what}</dd></div>
            ))}
          </dl>
        </div>
      )}
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
        <Shortcuts />
        <Compass />
      </div>
      <Panels />
      {selected && selected.kind !== 'vehicle' && selected.kind !== 'stop' && selected.kind !== 'aircraft' && (
        <div className="selection panel">
          <small>{selected.kind}</small>
          <b>{selected.label ?? selected.id}</b>
          <button className="ip-x" onClick={() => useApp.getState().select(null)} aria-label="Clear selection"><Icon.close /></button>
        </div>
      )}
    </div>
  );
}
