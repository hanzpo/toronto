// Mount point for the interaction UI (selection panels + mode HUDs).
import './panels.css';
import { useApp } from '../../state/store';
import { useInteract } from '../../interact/state';
import { StationPanel, VehiclePanel } from './InfoPanels';
import { ModeHud } from './ModeHud';
import { lazy, Suspense } from 'react';
// flight panel code (air/track, liveries) loads on first use
const AircraftPanel = lazy(() => import('../../air/AircraftPanel').then((m) => ({ default: m.AircraftPanel })));

export function Panels() {
  const selected = useApp((s) => s.selected);
  const mode = useInteract((s) => s.mode);
  const showInfo = mode === 'free' || mode === 'follow';
  return (
    <>
      {showInfo && selected?.kind === 'vehicle' && <VehiclePanel key={selected.id} trip={+selected.id} />}
      {showInfo && selected?.kind === 'stop' && <StationPanel key={selected.id} stop={+selected.id} />}
      {showInfo && selected?.kind === 'aircraft' && <Suspense fallback={null}><AircraftPanel key={selected.id} id={selected.id} /></Suspense>}
      <ModeHud />
    </>
  );
}
