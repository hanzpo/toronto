// Selection panel for an aircraft (mounted from ui/panels/Panels.tsx when
// selected.kind === 'aircraft').
import { useState } from 'react';
import { getEngine } from '../engine/instance';
import { useApp } from '../state/store';
import { useTick, hhmm } from '../ui/panels/common';
import type { AirLayer } from '../layers/AirLayer';
import { liveryOf } from './liveries';
import { PHASE_LABEL, PH } from './track';

function getAir(): AirLayer | null {
  return (getEngine()?.layers.find((l) => l.id === 'air') as AirLayer | undefined) ?? null;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export function AircraftPanel({ id }: { id: string }) {
  useTick(4);
  const [following, setFollowing] = useState(false);
  const air = getAir();
  const pl = air?.system.find(id) ?? null;
  const info = pl && air ? air.system.info(pl) : null;
  if (!air || !pl || !info) {
    return (
      <section className="ipanel panel">
        <header className="ip-head">
          <div className="ip-title"><small>Aircraft</small><b>Out of range</b></div>
          <button className="ip-x" onClick={() => { air?.follow(null); useApp.getState().select(null); }} aria-label="Close">×</button>
        </header>
      </section>
    );
  }
  const p = pl.pose;
  const liv = liveryOf(info.airline);
  const altFt = Math.round(((p.h + 75) / 0.3048) / 10) * 10;
  const agl = p.h - (getEngine()?.heightAt(p.e, p.n) ?? 0);
  const kt = Math.round(p.v * 1.94384);
  const vs = pl.kind === 'arr' ? 'from' : 'to';
  const otherLabel = info.other ? `${info.other.city || info.other.name} (${info.other.iata || info.otherCode})` : info.otherCode;
  const here = info.airportName;
  const route = pl.kind === 'arr' ? `${otherLabel} → ${here}` : `${here} → ${otherLabel}`;
  const phase = pl.kind === 'park' ? 'At gate' : PHASE_LABEL[p.phase] ?? '';
  const airborne = p.phase >= PH.CLIMB && p.phase <= PH.LANDING;
  const close = () => { air.follow(null); useApp.getState().select(null); };
  return (
    <section className="ipanel vpanel panel">
      <header className="ip-head">
        <span className="rbadge big" style={{ background: hex(liv.tail), color: '#fff' }}>{info.flight.split(' ')[0]}</span>
        <div className="ip-title">
          <small>{info.airlineName} · {info.typeName}</small>
          <b>{info.flight}{pl.kind === 'park' ? '' : ` ${vs} ${info.other?.iata || info.otherCode}`}</b>
        </div>
        <button className="ip-x" onClick={close} aria-label="Close">×</button>
      </header>
      <div className="ip-metrics">
        <div><em>{airborne ? altFt.toLocaleString() : '—'}</em><small>{airborne ? `ft · ${Math.round(agl / 0.3048).toLocaleString()} AGL` : 'ft'}</small></div>
        <div className="ip-status"><em>{phase}</em><small>{kt} kt ground speed</small></div>
      </div>
      <ol className="ip-stops">
        <li><span className="dot" style={{ borderColor: hex(liv.tail) }} /><span className="nm">{route}</span><span className="tm" /><span className="cd" /></li>
        <li><span className="dot" style={{ borderColor: '#888' }} /><span className="nm">{pl.kind === 'park' ? 'Next departure' : pl.kind === 'arr' ? 'Touchdown' : 'Takeoff'} · runway {info.runway}</span><span className="tm">{hhmm(info.sched)}</span><span className="cd" /></li>
        <li><span className="dot" style={{ borderColor: '#888' }} /><span className="nm">{info.airport} · stand {info.stand || '—'}</span><span className="tm">{info.callsign}</span><span className="cd" /></li>
        {info.next && <li><span className="dot" style={{ borderColor: '#555' }} /><span className="nm">Arrived as {info.next.flight} from {info.next.other?.iata || info.next.otherCode}</span><span className="tm">{hhmm(info.next.sched)}</span><span className="cd" /></li>}
      </ol>
      <div className="ip-actions">
        <button className={`act ${following ? 'on' : ''}`} onClick={() => { air.follow(following ? null : id); setFollowing(!following); }} title="Keep the camera on this aircraft">Follow</button>
        <button className="act" onClick={() => getEngine()?.controls.flyTo({ e: p.e, n: p.n, h: p.h, dist: airborne ? 900 : 350, pitch: 0.45 }, 1.6)}>Fly to</button>
      </div>
      <small className="muted">Schedule: real routes, modelled times (docs/AIR.md)</small>
    </section>
  );
}
