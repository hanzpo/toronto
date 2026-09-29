import { useEffect, useRef, useState } from 'react';
import { Engine } from './engine/Engine';
import { config, resolveDataRoot } from './engine/config';
import { DebugOverlayLayer } from './render/overlay/DebugOverlayLayer';
import { LabelsLayer } from './render/LabelsLayer';
import { setEngine } from './engine/instance';
import { Hud } from './ui/Hud';
import { clock } from './state/clock';
import { useApp } from './state/store';

export default function App() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let engine: Engine | null = null;
    let cancelled = false;
    (async () => {
      try {
        const root = await resolveDataRoot();
        if (cancelled || !host.current) return;
        engine = new Engine(host.current, root);
        await engine.init();
        if (cancelled) { engine.dispose(); return; }
        await engine.addLayer(new LabelsLayer());
        if (config.debug) await engine.addLayer(new DebugOverlayLayer());
        setEngine(engine);
        Object.assign(window as object, { __engine: engine, __clock: clock, __app: useApp });
        setReady(true);
      } catch (e) {
        console.error(e);
        setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
      setEngine(null);
      engine?.dispose();
    };
  }, []);

  return (
    <div className="app">
      <div ref={host} className="viewport" />
      {ready && <Hud />}
      {error && <div className="fatal">Renderer failed to start: {error}</div>}
    </div>
  );
}
