// Interaction UI state (camera mode, operate telemetry, prompts). Written by
// the InteractLayer at ~10 Hz, read by React panels. Never read per frame by
// React hooks with fine-grained selectors only.
import { create } from 'zustand';

export type CamMode = 'free' | 'follow' | 'cab' | 'ride' | 'operate' | 'walk' | 'drive';

export interface OperateTelemetry {
  trip: number;
  route: string;
  routeColor: string;
  routeText: string;
  headsign: string;
  mode: string;
  speed: number; // m/s
  limit: number; // m/s
  nextLimit: { v: number; at: number } | null;
  notch: number; // -5 EB, -4..-1 brake, 0 N, 1..4 power
  maxNotch: number;
  accel: number;
  nextStop: string;
  nextStopDist: number; // m (signed: negative = overrun)
  stopTol: number;
  canOpen: boolean;
  doors: 'closed' | 'opening' | 'open' | 'closing';
  boarding: { on: number; off: number; target: number; done: boolean } | null;
  deviation: number | null; // s, + late
  departIn: number | null; // s until scheduled departure while dwelling
  aspect: 'green' | 'yellow' | 'red' | 'none';
  trainAhead: number | null; // m
  reverse: boolean;
  message: string;
  progress: number; // 0..1
  finished: boolean;
  inTunnel: boolean;
  view: 'cab' | 'chase';
}

export interface RideInfo {
  trip: number;
  route: string;
  routeColor: string;
  routeText: string;
  headsign: string;
  nextStop: string;
  dwelling: boolean;
  speed: number;
}

export interface WalkInfo {
  running: boolean;
  prompt: string | null;
  prompt2: string | null;
  nearStop: string | null;
  nearDeps: { route: string; color: string; text: string; headsign: string; min: number }[];
}

export interface InteractState {
  mode: CamMode;
  view: 'cab' | 'chase' | 'ride';
  /** trip followed / ridden / operated */
  trip: number | null;
  op: OperateTelemetry | null;
  ride: RideInfo | null;
  walk: WalkInfo | null;
  /** waiting for a ground click to place the walker */
  placing: boolean;
  highlightRoute: number | null;
  toast: string | null;
  set(p: Partial<InteractState>): void;
}

export const useInteract = create<InteractState>((set) => ({
  mode: 'free',
  view: 'chase',
  trip: null,
  op: null,
  ride: null,
  walk: null,
  placing: false,
  highlightRoute: null,
  toast: null,
  set: (p) => set(p),
}));
