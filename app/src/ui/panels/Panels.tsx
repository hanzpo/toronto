// Mount point for the interaction UI (selection panels + mode HUDs).
import './panels.css';
import { useApp } from '../../state/store';
import { useInteract } from '../../interact/state';
import { StationPanel, VehiclePanel } from './InfoPanels';
import { ModeHud } from './ModeHud';
import { AircraftPanel } from '../../air/AircraftPanel';

export function Panels() {
  const selected = useApp((s) => s.selected);
  const mode = useInteract((s) => s.mode);
  const showInfo = mode === 'free' || mode === 'follow';
  return (
    <>
      {showInfo && selected?.kind === 'vehicle' && <VehiclePanel key={selected.id} trip={+selected.id} />}
      {showInfo && selected?.kind === 'stop' && <StationPanel key={selected.id} stop={+selected.id} />}
      {showInfo && selected?.kind === 'aircraft' && <AircraftPanel key={selected.id} id={selected.id} />}
      <ModeHud />
    </>
  );
}
