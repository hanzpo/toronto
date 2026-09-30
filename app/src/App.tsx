import { useEffect, useRef, useState } from 'react';
import { Engine } from './engine/Engine';
import { config, resolveDataRoot } from './engine/config';
import { setEngine } from './engine/instance';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { applyUrlTime } from './debug/inspect';
import { clock } from './state/clock';
import { useApp } from './state/store';

/** yield to the event loop (keeps layer set-up out of one long task) */
const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Layers are code-split: every module download starts at once (in parallel
 * with renderer + manifest start-up), then the layers are initialised in
 * order. Heavy, non-essential ones (landmark models, airports, flights) wait
 * for the first tiles so the first frame isn't held up by their long tasks.
 */
function loadLayerModules() {
  return {
    labels: import('./render/LabelsLayer'),
    landmarks: import('./layers/LandmarksLayer'),
    street: import('./layers/StreetLayer'),
    props: import('./layers/PropsLayer'),
    urban: import('./layers/UrbanLayer'),
    crossings: import('./layers/CrossingsLayer'),
    transit: import('./layers/TransitLayer'),
    interact: import('./interact/InteractLayer'),
    stations: import('./layers/StationsLayer'),
    traffic: import('./layers/TrafficLayer'),
    airport: import('./layers/AirportLayer'),
    air: import('./layers/AirLayer'),
    debug: config.debug ? import('./render/overlay/DebugOverlayLayer') : null,
  };
}

/** resolves once the first tiles are on screen (or after `ms`) */
function firstTiles(engine: Engine, ms = 4000) {
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const poll = () => (engine.tiles.readyCount > 0 && engine.tiles.stats().pending === 0) || performance.now() - t0 > ms ? resolve() : setTimeout(poll, 50);
    poll();
  });
}

export default function App() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let engine: Engine | null = null;
    let cancelled = false;
    (async () => {
      try {
        const mods = loadLayerModules();
        applyUrlTime();
        const root = await resolveDataRoot();
        if (cancelled || !host.current) return;
        engine = new Engine(host.current, root);
        await engine.init();
        if (cancelled) { engine.dispose(); return; }
        await engine.addLayer(new (await mods.labels).LabelsLayer());
        await yieldTask();
        await engine.addLayer(new (await mods.street).StreetLayer());
        await engine.addLayer(new (await mods.props).PropsLayer());
        await engine.addLayer(new (await mods.urban).UrbanLayer());
        await engine.addLayer(new (await mods.crossings).CrossingsLayer());
        const transit = new (await mods.transit).TransitLayer(engine.dataRoot);
        await engine.addLayer(transit);
        Object.assign(window as object, { __transit: transit });
        await yieldTask();
        await engine.addLayer(new (await mods.interact).InteractLayer());
        { const stations = new (await mods.stations).StationsLayer(transit.system); await engine.addLayer(stations); Object.assign(window as object, { __stations: stations }); }
        await yieldTask();
        { const traffic = new (await mods.traffic).TrafficLayer(transit); await engine.addLayer(traffic); Object.assign(window as object, { __traffic: traffic }); }
        await firstTiles(engine);
        if (cancelled) return;
        await engine.addLayer(new (await mods.landmarks).LandmarksLayer());
        await yieldTask();
        await engine.addLayer(new (await mods.airport).AirportLayer());
        await yieldTask();
        { const air = new (await mods.air).AirLayer(engine.dataRoot); await engine.addLayer(air); Object.assign(window as object, { __air: air }); }
        { const water = new (await import('./layers/WaterLifeLayer')).WaterLifeLayer(engine.dataRoot); await engine.addLayer(water); Object.assign(window as object, { __water: water }); }
        if (mods.debug) await engine.addLayer(new (await mods.debug).DebugOverlayLayer());
        setEngine(engine);
        Object.assign(window as object, { __engine: engine, __clock: clock, __app: useApp });
        void import('./qa/runtime').then((m) => m.installQa(engine!));
        performance.mark('layers-ready');
        void engine.prewarm();
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
      {ready && <DebugOverlay />}
      {error && <div className="fatal">Renderer failed to start: {error}</div>}
    </div>
  );
}
