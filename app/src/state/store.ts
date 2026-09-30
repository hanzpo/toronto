// UI / sim state. The render loop reads it via `useApp.getState()` — never via
// React hooks — so no re-renders happen per frame.
import { create } from 'zustand';
import { SPEEDS, clock, dayTypeOf, type DayType } from './clock';

export type BaseLayerKey = 'terrain' | 'buildings' | 'houses' | 'roads' | 'rail' | 'labels';
export type AnalyticsKey =
  | 'subway' | 'streetcar' | 'lrt' | 'go' | 'upx' | 'via' | 'bus' | 'vehicles' | 'congestion' | 'air';

export interface SelectedEntity {
  kind: string; // e.g. 'vehicle' | 'building' | 'landmark'
  id: string;
  label?: string;
}

export interface EngineStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  tilesLoaded: number;
  tilesVisible: number;
  tilesPending: number;
  gpuMB: number;
  backend: string;
  altitude: number;
  cameraE: number;
  cameraN: number;
  heading: number; // radians, 0 = north, CW positive
  metersPerPixel: number;
}

export interface AppState {
  speedIndex: number; // index into SPEEDS
  playing: boolean;
  dayTypeOverride: DayType | null;
  layers: Record<BaseLayerKey, boolean>;
  analytics: Record<AnalyticsKey, boolean>;
  analyticsMode: boolean;
  shadows: boolean;
  selected: SelectedEntity | null;
  stats: EngineStats;
  // actions
  togglePlay(): void;
  setSpeedIndex(i: number): void;
  faster(): void;
  slower(): void;
  setDayTypeOverride(d: DayType | null): void;
  toggleLayer(k: BaseLayerKey): void;
  toggleAnalytics(k: AnalyticsKey): void;
  setAnalyticsMode(v: boolean): void;
  setShadows(v: boolean): void;
  select(e: SelectedEntity | null): void;
  setStats(s: EngineStats): void;
}

export const useApp = create<AppState>((set, get) => ({
  speedIndex: 1,
  playing: true,
  dayTypeOverride: null,
  layers: { terrain: true, buildings: true, houses: true, roads: true, rail: true, labels: true },
  analytics: {
    subway: true, streetcar: false, lrt: true, go: true, upx: true, via: false,
    bus: false, vehicles: true, congestion: false, air: true,
  },
  analyticsMode: false,
  shadows: true,
  selected: null,
  stats: {
    fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, tilesLoaded: 0, tilesVisible: 0,
    tilesPending: 0, gpuMB: 0, backend: '', altitude: 0, cameraE: 0, cameraN: 0, heading: 0,
    metersPerPixel: 1,
  },
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setSpeedIndex: (i) => set({ speedIndex: Math.max(0, Math.min(SPEEDS.length - 1, i)), playing: i > 0 ? true : get().playing }),
  faster: () => set((s) => ({ speedIndex: Math.min(SPEEDS.length - 1, s.speedIndex + 1) })),
  slower: () => set((s) => ({ speedIndex: Math.max(1, s.speedIndex - 1) })),
  setDayTypeOverride: (d) => set({ dayTypeOverride: d }),
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  toggleAnalytics: (k) => set((s) => ({ analytics: { ...s.analytics, [k]: !s.analytics[k] } })),
  setAnalyticsMode: (v) => set({ analyticsMode: v }),
  setShadows: (v) => set({ shadows: v }),
  select: (e) => set({ selected: e }),
  setStats: (stats) => set({ stats }),
}));

/** Effective sim speed multiplier (0 when paused). */
export function simSpeed(): number {
  const s = useApp.getState();
  return s.playing ? SPEEDS[s.speedIndex] : 0;
}

/** Day type for the current sim date (override wins). */
export function currentDayType(): DayType {
  const o = useApp.getState().dayTypeOverride;
  if (o) return o;
  return dayTypeOf(clock.serviceDay().weekday);
}
