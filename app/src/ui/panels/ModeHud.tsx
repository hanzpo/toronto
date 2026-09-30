// HUDs for the takeover modes: operate (driver's desk), ride, walk, plus the
// mode bar, toast and the passenger window frame.
import { useInteract, type OperateTelemetry } from '../../interact/state';
import { RouteBadge } from './InfoPanels';
import { Icon } from '../icons';
import { getEngine } from '../../engine/instance';
import { MODE_LABEL, getInteract, kmh, useTick, shortStop, cleanHeadsign } from './common';

function Speedo({ v, limit, max }: { v: number; limit: number; max: number }) {
  const R = 64, cx = 80, cy = 80;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const ang = (x: number) => a0 + (a1 - a0) * Math.min(1, Math.max(0, x / max));
  const pt = (a: number, r: number) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  const arc = (from: number, to: number, r: number) => {
    const [x0, y0] = pt(from, r), [x1, y1] = pt(to, r);
    return `M${x0} ${y0} A${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const ticks = [];
  const step = max > 120 ? 20 : 10;
  for (let s = 0; s <= max; s += step) {
    const a = ang(s);
    const [x0, y0] = pt(a, R - 2), [x1, y1] = pt(a, R - 9);
    const [lx, ly] = pt(a, R - 20);
    ticks.push(<g key={s}><line x1={x0} y1={y0} x2={x1} y2={y1} /><text x={lx} y={ly + 3}>{s}</text></g>);
  }
  const over = v > limit + 1;
  const [nx, ny] = pt(ang(v), R - 6);
  const [lx0, ly0] = pt(ang(limit), R + 2), [lx1, ly1] = pt(ang(limit), R - 12);
  return (
    <svg className="speedo" viewBox="0 0 160 150">
      <path d={arc(a0, a1, R)} className="sp-bg" />
      <path d={arc(a0, Math.max(a0 + 0.001, ang(v)), R)} className={`sp-val ${over ? 'over' : ''}`} />
      <path d={arc(ang(limit), a1, R + 5)} className="sp-lim" />
      <g className="sp-ticks">{ticks}</g>
      <line x1={lx0} y1={ly0} x2={lx1} y2={ly1} className="sp-limtick" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} className="sp-needle" />
      <circle cx={cx} cy={cy} r={4} className="sp-hub" />
      <text x={cx} y={cy + 30} className={`sp-num ${over ? 'over' : ''}`}>{kmh(v)}</text>
      <text x={cx} y={cy + 44} className="sp-unit">km/h</text>
    </svg>
  );
}

function Notch({ op }: { op: OperateTelemetry }) {
  const rows: { n: number; label: string }[] = [];
  for (let i = op.maxNotch; i >= 1; i--) rows.push({ n: i, label: `P${i}` });
  rows.push({ n: 0, label: 'N' });
  for (let i = 1; i <= op.maxNotch; i++) rows.push({ n: -i, label: `B${i}` });
  rows.push({ n: -5, label: 'EB' });
  return (
    <div className="notch" aria-label="Controller notch">
      {rows.map((r) => (
        <div key={r.n} className={`nr ${r.n > 0 ? 'p' : r.n < 0 ? (r.n === -5 ? 'eb' : 'b') : 'n'} ${op.notch === r.n ? 'on' : ''}`}>{r.label}</div>
      ))}
    </div>
  );
}

function StopBar({ op }: { op: OperateTelemetry }) {
  const d = op.nextStopDist;
  if (Math.abs(d) > 250) return null;
  const range = 40;
  const x = Math.max(-range, Math.min(range, -d));
  const ok = Math.abs(d) <= op.stopTol;
  return (
    <div className={`stopbar ${ok ? 'ok' : d < 0 ? 'over' : ''}`}>
      <div className="sb-track">
        <i className="sb-zone" style={{ left: `${50 - (op.stopTol / range) * 50}%`, width: `${(op.stopTol / range) * 100}%` }} />
        <i className="sb-mark" />
        <b className="sb-pos" style={{ left: `${50 + (x / range) * 50}%` }} />
      </div>
      <span>{ok ? (op.speed < 0.1 ? 'ON MARK' : 'IN ZONE') : d > 0 ? `${d.toFixed(1)} m to mark` : `OVERRUN ${(-d).toFixed(1)} m`}</span>
    </div>
  );
}

function OperateHud({ op }: { op: OperateTelemetry }) {
  const ia = getInteract();
  const dist = op.nextStopDist;
  const distLabel = Math.abs(dist) >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${Math.round(dist)} m`;
  const devLabel = op.departIn !== null
    ? op.departIn > 0 ? `Depart in ${Math.floor(op.departIn / 60)}:${String(Math.floor(op.departIn % 60)).padStart(2, '0')}` : `Depart now (+${Math.round(-op.departIn)} s)`
    : op.deviation === null ? '' : Math.abs(op.deviation) < 20 ? 'On time' : op.deviation > 0 ? `+${fmtDev(op.deviation)} late` : `−${fmtDev(-op.deviation)} early`;
  const devCls = op.departIn !== null ? (op.departIn > 0 ? 'ok' : 'warn') : op.deviation === null ? '' : Math.abs(op.deviation) < 60 ? 'ok' : op.deviation > 0 ? 'bad' : 'warn';
  const max = op.mode === 'commuter_rail' || op.mode === 'intercity_rail' || op.mode === 'airport_rail' ? 160 : op.mode === 'streetcar' || op.mode === 'bus' ? 70 : 100;
  return (
    <div className="ophud">
      <div className="op-top panel">
        <RouteBadge short={op.route} color={op.routeColor} text={op.routeText} big />
        <div className="op-title"><small>{MODE_LABEL[op.mode]} · driving</small><b><span className="to">to</span> {cleanHeadsign(op.headsign)}</b></div>
        <div className={`op-sig ${op.aspect}`} title="Block signal">
          <i className="r" /><i className="y" /><i className="g" />
        </div>
        <div className="op-ahead"><small>Train ahead</small><b>{op.trainAhead === null ? 'clear' : op.trainAhead > 1000 ? `${(op.trainAhead / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(op.trainAhead))} m`}</b></div>
        <div className={`op-dev ${devCls}`}><small>Schedule</small><b>{devLabel}</b></div>
        <div className="seg op-views">
          {(['cab', 'chase', 'ride'] as const).map((v, i) => (
            <button key={v} className={useInteract.getState().view === v ? 'on' : ''} onClick={() => ia?.setView(v)} title={`View ${i + 1}`}>{v === 'ride' ? 'Cabin' : v === 'cab' ? 'Cab' : 'Chase'}</button>
          ))}
        </div>
        <button className="op-exit" onClick={() => ia?.exit()}><Icon.exit />Release<kbd>Esc</kbd></button>
      </div>

      <div className="op-desk">
        <div className="panel op-dial">
          <Speedo v={op.speed} limit={op.limit} max={max} />
          <div className="op-limit">
            <span className="lim-sign"><b>{kmh(op.limit)}</b></span>
            {op.nextLimit && <span className="lim-next">{kmh(op.nextLimit.v)} in {Math.round(op.nextLimit.at)} m</span>}
          </div>
        </div>

        <div className="panel op-center">
          <div className="op-next">
            <small>{op.finished ? 'Terminus' : 'Next station'}</small>
            <b>{shortStop(op.nextStop)}</b>
            <em>{op.finished ? '—' : distLabel}</em>
          </div>
          <StopBar op={op} />
          <div className={`doors ${op.doors}`}>
            <span className="door-ico"><i /><i /></span>
            <span>{op.doors === 'closed' ? (op.canOpen ? 'Doors closed · press O to open' : 'Doors closed') : op.doors === 'open' ? 'Doors open · press C to close' : op.doors === 'opening' ? 'Doors opening…' : 'Doors closing — chime'}</span>
          </div>
          {op.boarding && (
            <div className="boarding">
              <span>{op.boarding.off} off</span><span>{op.boarding.on}/{op.boarding.target} on</span>
              <em>{op.boarding.done ? 'Boarding complete' : 'Boarding…'}</em>
            </div>
          )}
          <div className="op-prog"><i style={{ width: `${op.progress * 100}%`, background: op.routeColor }} /></div>
          {op.message && <div className="op-msg">{op.message}</div>}
        </div>

        <div className="panel op-ctl">
          <Notch op={op} />
          <div className="op-acc"><small>accel</small><b>{op.accel >= 0 ? '+' : ''}{op.accel.toFixed(2)}</b><small>m/s²</small></div>
          {op.reverse && <div className="rev">REV</div>}
        </div>
      </div>
      <div className="op-keys">
        <Keys k={['W', 'S']} t="Notch" /><Keys k={['X']} t="Emergency" /><Keys k={['O', 'C']} t="Doors" /><Keys k={['R']} t="Reverser" /><Keys k={['B']} t="Horn" /><Keys k={['1', '2', '3']} t="Views" /><Keys k={['Drag']} t="Look" />
      </div>
    </div>
  );
}

/** one key-hint group: keycaps + what they do */
function Keys({ k, t }: { k: string[]; t: string }) {
  return <span className="kg">{k.map((x) => <kbd key={x}>{x}</kbd>)}<span>{t}</span></span>;
}

function fmtDev(s: number) {
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)} s`;
}

function RideHud() {
  const ride = useInteract((s) => s.ride);
  const mode = useInteract((s) => s.mode);
  const view = useInteract((s) => s.view);
  const walk = useInteract((s) => s.walk);
  const ia = getInteract();
  if (!ride) return null;
  return (
    <div className="ridehud panel">
      <RouteBadge short={ride.route} color={ride.routeColor} text={ride.routeText} big />
      <div className="op-title">
        <small>{mode === 'ride' ? 'Riding' : mode === 'cab' ? 'Cab view' : 'Following'} · {kmh(ride.speed)} km/h</small>
        <b><span className="to">to</span> {cleanHeadsign(ride.headsign)}</b>
      </div>
      <div className="ride-next"><small>{ride.dwelling ? 'Now at' : 'Next'}</small><b>{shortStop(ride.nextStop)}</b></div>
      <div className="seg op-views">
        {(['cab', 'chase', 'ride'] as const).map((v, i) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => ia?.setView(v)} title={`View ${i + 1}`}>{v === 'ride' ? 'Window' : v === 'cab' ? 'Cab' : 'Chase'}</button>
        ))}
      </div>
      <button className="op-take" onClick={() => ia?.operate(ride.trip)} title="Take control (T)"><Icon.wheel />Drive</button>
      <button className="op-exit" onClick={() => ia?.exit()}><Icon.exit />Exit<kbd>Esc</kbd></button>
      {walk?.prompt && <div className="prompt inline"><kbd>E</kbd> {walk.prompt.replace(/^Press E to /, '')}</div>}
    </div>
  );
}

function WalkHud() {
  const walk = useInteract((s) => s.walk);
  const mode = useInteract((s) => s.mode);
  const ia = getInteract();
  if (mode !== 'walk' || !walk) return null;
  return (
    <>
      <div className="walkhud">
        {walk.prompt && <div className="prompt"><kbd>E</kbd>{walk.prompt.replace(/^Press E to /, '')}</div>}
        {walk.prompt2 && <div className="prompt dim"><kbd>F</kbd>{walk.prompt2.replace(/^Press F to /, '')}</div>}
        <div className="op-keys"><Keys k={['W', 'A', 'S', 'D']} t="Walk" /><Keys k={['Shift']} t="Run" /><Keys k={['Drag']} t="Look" /><Keys k={['Scroll']} t="Zoom" /></div>
      </div>
      {walk.nearStop && (
        <div className="nearstop panel">
          <small>Nearby stop</small>
          <b>{shortStop(walk.nearStop)}</b>
          <ul>
            {walk.nearDeps.map((d, i) => (
              <li key={i}><RouteBadge short={d.route} color={d.color} text={d.text} /><span>{cleanHeadsign(d.headsign)}</span><em>{d.min < 0.5 ? 'Due' : `${Math.round(d.min)} min`}</em></li>
            ))}
          </ul>
        </div>
      )}
      <button className="walk-exit panel" onClick={() => ia?.exit()}><Icon.exit />Exit walk<kbd>Esc</kbd></button>
    </>
  );
}

function DriveHud() {
  useTick(8);
  const ia = getInteract();
  const tr = getEngine()?.layers.find((l) => l.id === 'traffic') as unknown as { getPlayer?(): { speed: number; roadName: string | null; onRoad: boolean } | null } | undefined;
  const p = tr?.getPlayer?.();
  return (
    <>
      <div className="ridehud panel">
        <div className="drive-speed"><b>{p ? kmh(Math.abs(p.speed)) : 0}</b><small>km/h</small></div>
        <div className="op-title"><small>Driving{p && !p.onRoad ? ' · off road' : ''}</small><b>{p?.roadName ?? '—'}</b></div>
        <button className="op-exit" onClick={() => ia?.exit()}><Icon.exit />Exit car<kbd>Esc</kbd></button>
      </div>
      <div className="walkhud"><div className="op-keys"><Keys k={['W', 'S']} t="Throttle / brake" /><Keys k={['A', 'D']} t="Steer" /><Keys k={['Space']} t="Handbrake" /><Keys k={['Scroll']} t="Zoom" /></div></div>
    </>
  );
}

function ModeBar() {
  const mode = useInteract((s) => s.mode);
  const placing = useInteract((s) => s.placing);
  const ia = getInteract();
  if (mode !== 'free') return null;
  return (
    <div className="modebar panel">
      <button className={`act ${placing ? 'on' : ''}`} onClick={() => (placing ? useInteract.getState().set({ placing: false }) : ia?.startPlacing())} title="Drop a pedestrian on the map">
        <Icon.walk />
        {placing ? 'Click the map…' : 'Walk'}
      </button>
    </div>
  );
}

function Toast() {
  const toast = useInteract((s) => s.toast);
  if (!toast) return null;
  return <div className="itoast panel">{toast}</div>;
}

export function ModeHud() {
  const op = useInteract((s) => s.op);
  const mode = useInteract((s) => s.mode);
  const view = useInteract((s) => s.view);
  const windowFrame = view === 'ride' && (mode === 'ride' || mode === 'operate');
  return (
    <>
      {windowFrame && <div className="cabin-frame" aria-hidden><i className="pillar l" /><i className="pillar r" /><i className="sill" /><i className="top" /></div>}
      {view === 'cab' && (mode === 'cab' || mode === 'operate') && <div className="cab-vignette" aria-hidden />}
      {op && mode === 'operate' && <OperateHud op={op} />}
      {mode !== 'operate' && <RideHud />}
      <WalkHud />
      {mode === 'drive' && <DriveHud />}
      <ModeBar />
      <Toast />
    </>
  );
}
