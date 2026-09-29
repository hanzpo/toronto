// Selection panels: vehicle (trip) and station (departures board).
import { useMemo } from 'react';
import { useApp } from '../../state/store';
import { useInteract } from '../../interact/state';
import { STATE_DWELL, RAIL_MODES } from '../../transit';
import { getEngine } from '../../engine/instance';
import { MODE_LABEL, baseName, countdown, getInteract, getTransit, hhmm, kmh, serviceSec, shortStop, useTick, cleanHeadsign } from './common';

export function RouteBadge({ short, color, text, big }: { short: string; color: string; text: string; big?: boolean }) {
  return <span className={`rbadge ${big ? 'big' : ''}`} style={{ background: color, color: text }}>{short}</span>;
}

export function VehiclePanel({ trip }: { trip: number }) {
  useTick(4);
  const sys = getTransit()?.system;
  const info = useMemo(() => sys?.tripInfo(trip) ?? null, [sys, trip]);
  const mode = useInteract((s) => s.mode);
  const opTrip = useInteract((s) => s.op?.trip);
  if (!sys || !info) return null;
  const ia = getInteract();
  const t = serviceSec();
  const operated = opTrip === trip && ia?.op;
  const vs = sys.vehicleAt(trip, t);
  const dist = operated ? ia!.op!.s : vs?.dist ?? 0;
  const speed = operated ? ia!.op!.v : vs?.speed ?? 0;
  const len = info.stops[info.stops.length - 1]?.dist || 1;
  const real = info.stops.filter((s) => !s.virtual);
  const upcoming = real.filter((s) => s.dist >= dist - 5).slice(0, 7);
  const r = info.routeMeta;
  const dev = operated ? ia!.op!.deviation(t) : 0;
  const dwell = !operated && vs?.state === STATE_DWELL;
  const status = !vs && !operated ? 'Not in service' : operated
    ? Math.abs(dev) < 30 ? 'On time (you)' : dev > 0 ? `${Math.round(dev / 60)} min late (you)` : `${Math.round(-dev / 60)} min early (you)`
    : dwell ? `At ${shortStop(sys.stopName(vs!.nextStop))}` : 'On schedule';
  const rail = (RAIL_MODES as readonly string[]).includes(info.mode) || info.mode === 'bus';
  const attached = mode !== 'free';
  return (
    <section className="ipanel vpanel panel">
      <header className="ip-head">
        <RouteBadge short={r.short} color={r.color} text={r.textColor} big />
        <div className="ip-title">
          <small>{MODE_LABEL[info.mode]} · {r.long}{info.name ? ` · #${info.name}` : ''}</small>
          <b>→ {cleanHeadsign(info.headsign)}</b>
        </div>
        <button className="ip-x" onClick={() => { useApp.getState().select(null); useInteract.getState().set({ highlightRoute: null }); }} aria-label="Close">×</button>
      </header>
      <div className="ip-metrics">
        <div><em>{kmh(speed)}</em><small>km/h</small></div>
        <div className={`ip-status ${operated ? 'you' : ''}`}><em>{status}</em><small>{hhmm(info.start)} – {hhmm(info.end)}</small></div>
      </div>
      <div className="ip-progress" aria-hidden>
        <div className="ip-track" style={{ ['--c' as string]: r.color }}>
          <i className="ip-fill" style={{ width: `${(dist / len) * 100}%` }} />
          {real.map((s) => <span key={s.stop + ':' + s.dist} className={`ip-tick ${s.dist < dist ? 'past' : ''}`} style={{ left: `${(s.dist / len) * 100}%` }} />)}
          <b className="ip-veh" style={{ left: `${(dist / len) * 100}%` }} />
        </div>
        <div className="ip-ends"><span>{shortStop(real[0]?.name ?? '')}</span><span>{shortStop(real[real.length - 1]?.name ?? '')}</span></div>
      </div>
      <ol className="ip-stops">
        {upcoming.map((s, i) => (
          <li key={s.stop + ':' + s.dist} className={i === 0 ? 'next' : ''}>
            <span className="dot" style={{ borderColor: r.color }} />
            <span className="nm">{shortStop(s.name)}</span>
            <span className="tm">{hhmm(s.arr)}</span>
            <span className="cd">{countdown(s.arr - t)}</span>
          </li>
        ))}
        {!upcoming.length && <li className="muted">Trip complete</li>}
      </ol>
      <div className="ip-actions">
        <button className={`act ${mode === 'follow' ? 'on' : ''}`} onClick={() => ia?.follow(trip)} title="Chase camera">Follow</button>
        <button className={`act ${mode === 'cab' ? 'on' : ''}`} onClick={() => ia?.cab(trip)} title="Driver's eye view">Cab view</button>
        <button className={`act ${mode === 'ride' ? 'on' : ''}`} onClick={() => ia?.ride(trip)} title="Passenger view">Ride</button>
        {rail && <button className={`act primary ${operated ? 'on' : ''}`} onClick={() => (operated ? ia?.exit() : ia?.operate(trip))} title="Detach from the schedule and drive it (T)">{operated ? 'Release' : 'Take control'}</button>}
        {attached && <button className="act ghost" onClick={() => ia?.exit()}>Exit · Esc</button>}
      </div>
    </section>
  );
}

export function StationPanel({ stop }: { stop: number }) {
  useTick(1);
  const ia = getInteract();
  const sys = getTransit()?.system;
  const group = useMemo(() => ia?.stationGroup(stop) ?? [stop], [ia, stop]);
  if (!sys || !ia) return null;
  const t = serviceSec();
  const name = baseName(sys.stopName(stop));
  const arr = group.flatMap((s) => sys.arrivalsAt(s, t - 30, 30).map((a) => ({ ...a, stop: s })));
  // group by route + headsign
  const rows = new Map<string, { route: number; headsign: string; deps: number[]; trips: number[] }>();
  for (const a of arr.sort((x, y) => x.dep - y.dep)) {
    const key = `${a.route}|${a.headsign}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { route: a.route, headsign: a.headsign, deps: [], trips: [] }));
    if (r.deps.length < 3 && a.dep >= t - 20) { r.deps.push(a.dep); r.trips.push(a.trip); }
  }
  const list = [...rows.values()].filter((r) => r.deps.length).sort((a, b) => a.deps[0] - b.deps[0]).slice(0, 10);
  const p = sys.stopPosition(stop);
  const walk = () => {
    const e = getEngine();
    if (!e) return;
    ia.walkAt(p[0] + 4, p[1] + 4);
  };
  return (
    <section className="ipanel spanel panel">
      <header className="ip-head">
        <span className="stn-icon" aria-hidden><svg viewBox="0 0 16 16"><rect x="3" y="2" width="10" height="10" rx="2.5" /><path d="M5 14 L6.5 12 M11 14 L9.5 12" /><rect x="5" y="4.5" width="6" height="3" rx="0.8" className="w" /></svg></span>
        <div className="ip-title">
          <small>Station · {group.length} platform{group.length > 1 ? 's' : ''}</small>
          <b>{name}</b>
        </div>
        <button className="ip-x" onClick={() => useApp.getState().select(null)} aria-label="Close">×</button>
      </header>
      <div className="board">
        <div className="board-head"><span>Route</span><span>Destination</span><span>Departs</span></div>
        {list.map((r) => {
          const m = sys.routes[r.route];
          return (
            <button key={`${r.route}|${r.headsign}`} className="board-row" onClick={() => { ia.selectVehicle(r.trips[0]); useInteract.getState().set({ highlightRoute: r.route }); }} title="Select the next vehicle">
              <RouteBadge short={m.short} color={m.color} text={m.textColor} />
              <span className="dest">{cleanHeadsign(r.headsign)}</span>
              <span className="deps">
                {r.deps.map((d, i) => <em key={i} className={i === 0 ? 'first' : ''}>{countdown(d - t)}</em>)}
              </span>
            </button>
          );
        })}
        {!list.length && <div className="muted pad">No departures in the next hours</div>}
      </div>
      <div className="ip-actions">
        <button className="act primary" onClick={walk}>Walk here</button>
        <button className="act" onClick={() => getEngine()?.controls.flyTo({ e: p[0], n: p[1], dist: 450, pitch: 0.7 }, 1.6)}>Fly to</button>
      </div>
    </section>
  );
}
