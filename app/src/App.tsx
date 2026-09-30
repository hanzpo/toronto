import { useEffect, useRef, useState } from 'react';
import { Engine } from './engine/Engine';
import { config, resolveDataRoot } from './engine/config';
import { DebugOverlayLayer } from './render/overlay/DebugOverlayLayer';
import { LabelsLayer } from './render/LabelsLayer';
import { LandmarksLayer } from './layers/LandmarksLayer';
import { TransitLayer } from './layers/TransitLayer';
import { InteractLayer } from './interact/InteractLayer';
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
        await engine.addLayer(new LandmarksLayer());
        await engine.addLayer(new (await import('./layers/StreetLayer')).StreetLayer());
        const transit = new TransitLayer(engine.dataRoot);
        await engine.addLayer(transit);
        Object.assign(window as object, { __transit: transit });
        await engine.addLayer(new InteractLayer());
        { const stations = new (await import('./layers/StationsLayer')).StationsLayer(transit.system); await engine.addLayer(stations); Object.assign(window as object, { __stations: stations }); }
        { const traffic = new (await import('./layers/TrafficLayer')).TrafficLayer(transit); await engine.addLayer(traffic); Object.assign(window as object, { __traffic: traffic }); }
        { const air = new (await import('./layers/AirLayer')).AirLayer(engine.dataRoot); await engine.addLayer(air); Object.assign(window as object, { __air: air }); }
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
