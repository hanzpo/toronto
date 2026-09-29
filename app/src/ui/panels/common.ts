import { useEffect, useState } from 'react';
import { getEngine } from '../../engine/instance';
import type { InteractLayer } from '../../interact/InteractLayer';
import type { TransitLayer } from '../../layers/TransitLayer';
import { clock } from '../../state/clock';

export function getInteract(): InteractLayer | null {
  return (getEngine()?.layers.find((l) => l.id === 'interact') as InteractLayer | undefined) ?? null;
}

export function getTransit(): TransitLayer | null {
  return (getEngine()?.layers.find((l) => l.id === 'transit') as TransitLayer | undefined) ?? null;
}

/** re-render at `hz` */
export function useTick(hz = 4) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
}

export function serviceSec(): number {
  return clock.serviceDay().sec;
}

export const hhmm = (sec: number) => {
  const s = ((Math.round(sec) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

export const countdown = (sec: number) => {
  if (sec < 30) return 'Due';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60}`;
};

export const kmh = (v: number) => Math.round(v * 3.6);

export const MODE_LABEL: Record<string, string> = {
  subway: 'Subway', lrt: 'LRT', streetcar: 'Streetcar', commuter_rail: 'GO Train', airport_rail: 'UP Express', intercity_rail: 'VIA Rail', bus: 'Bus',
};

export function shortStop(name: string) {
  return baseName(name).replace(/ Station$/i, ' Stn');
}

/** "Union Station - Northbound Platform Towards Finch" -> "Union Station" */
export function baseName(name: string) {
  return name.split(' - ')[0].trim();
}

/** "East - 504A King towards Distillery" -> "Distillery" */
export function cleanHeadsign(h: string) {
  const m = / towards (.+)$/i.exec(h);
  if (m) return shortStop(m[1]);
  const parts = h.split(' - ');
  return (parts.length > 1 && parts[0].length <= 4 ? parts.slice(1).join(' - ') : parts[0]).replace(/ Station$/i, ' Stn');
}
