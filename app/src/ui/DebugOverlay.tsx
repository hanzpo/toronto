// Toggleable debug overlay (` key, or ?dbg=1): live camera/time/location
// info, Alt/Option-click inspection of whatever is under the cursor (raw tile
// data: OSM ids, classes, widths…), and a "Copy report" button that puts a
// reproducible bug report (with a URL restoring view + sim time) on the clipboard.
import { useEffect, useRef, useState } from 'react';
import { getEngine } from '../engine/instance';
import { inspectAt, liveInfo, reportText, type LiveInfo } from '../debug/inspect';

export function DebugOverlay() {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('dbg') === '1');
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [picked, setPicked] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState('');
  const marker = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (ev.key === '`' || ev.key === '~') { setOpen((o) => !o); ev.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const tick = () => { const e = getEngine(); if (e) setInfo(liveInfo(e)); };
    tick();
    const id = setInterval(tick, 250);
    const onClick = async (ev: MouseEvent) => {
      if (!ev.altKey) return;
      const e = getEngine();
      if (!e || ev.target !== e.renderer.domElement) return;
      ev.preventDefault();
      ev.stopPropagation();
      marker.current = { x: ev.clientX, y: ev.clientY };
      setStatus('inspecting…');
      setPicked(await inspectAt(e, ev.clientX, ev.clientY));
      setStatus('');
    };
    window.addEventListener('click', onClick, true);
    return () => { clearInterval(id); window.removeEventListener('click', onClick, true); };
  }, [open]);

  if (!open || !info) return null;
  const copy = async () => {
    const text = reportText(info, picked);
    try { await navigator.clipboard.writeText(text); setStatus('report copied'); }
    catch { setStatus('copy failed — select the text below'); console.log(text); }
    setTimeout(() => setStatus(''), 2500);
  };
  const c = info.cam;
  return (
    <div className="debug-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="dbg-head">
        <b>DEBUG</b> <span className="dbg-dim">` to hide · Alt/⌥-click to inspect</span>
        <button onClick={copy}>Copy report</button>
      </div>
      <table>
        <tbody>
          <tr><td>time</td><td>{info.simIso} · {info.dayType} · speed {info.speed}{info.playing ? '' : ' ⏸'}</td></tr>
          <tr><td>camera</td><td>E {c.e.toFixed(1)} N {c.n.toFixed(1)} · elev {c.elev.toFixed(1)} · alt {c.alt.toFixed(1)} m</td></tr>
          <tr><td>lat/lon</td><td>{c.lat.toFixed(6)}, {c.lon.toFixed(6)}</td></tr>
          <tr><td>view</td><td>focus {info.focus.e.toFixed(0)},{info.focus.n.toFixed(0)} · dist {c.dist.toFixed(1)} · hdg {c.headingDeg.toFixed(0)}° · pitch {c.pitchDeg.toFixed(0)}°</td></tr>
          <tr><td>tile</td><td>{info.tile} · data build {String(info.build)} · app {__APP_VERSION__}</td></tr>
          <tr><td>perf</td><td>{info.stats.fps.toFixed(0)} fps · {info.stats.draws} draws · {(info.stats.tris / 1e6).toFixed(2)} M tris · {info.stats.cpuMs.toFixed(1)} ms</td></tr>
          {info.qa && <tr><td>qa</td><td>{Object.entries(info.qa).map(([k, v]) => `${k} ${v}`).join(' · ')}</td></tr>}
        </tbody>
      </table>
      {status && <div className="dbg-status">{status}</div>}
      {picked && <pre className="dbg-pick">{JSON.stringify(picked, null, 1)}</pre>}
    </div>
  );
}
