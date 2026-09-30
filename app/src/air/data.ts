// JSON contracts for data/air/* (docs/AIR.md).

export interface RunwayJson {
  des: string;
  /** threshold [E, N, elev] */
  thr: [number, number, number];
  /** opposite end [E, N, elev] */
  end: [number, number, number];
  /** true heading, degrees clockwise from north */
  hdg: number;
  len: number;
  /** graph node where departures line up */
  entry: number | null;
  /** [node, metres from threshold, angle of the exit taxiway vs landing direction (deg, signed)] */
  exits: [number, number, number][];
}

export interface StandJson {
  ref: string;
  /** nose stop position [E, N] */
  pos: [number, number];
  /** unit nose-in direction [dE, dN] */
  hdg: [number, number];
  /** graph node at the start of the lead-in line */
  node: number;
  span: number;
  zone: string;
}

export interface RunwayConfig { name: string; weight: number; streams: Record<string, string> }

export interface AirportJson {
  icao: string;
  iata: string;
  name: string;
  pos: [number, number, number];
  configs: RunwayConfig[];
  curfew: [number, number] | null;
  nodes: [number, number, number][];
  /** [a, b, kind] kind: 0 taxiway, 1 taxilane, 2 runway, 3 stand lead-in */
  edges: [number, number, number][];
  runways: RunwayJson[];
  stands: StandJson[];
}

export interface Place { iata: string; city: string; name: string; lat: number; lon: number }

export interface AirportsFile {
  version: number;
  airports: AirportJson[];
  airlines: Record<string, { name: string; iata: string }>;
  places: Record<string, Place>;
}

export interface RotationsJson {
  al: number[]; ty: number[]; st: number[];
  acs: string[]; afrom: string[]; ta: number[]; sa: string[];
  dcs: string[]; dto: string[]; td: number[]; sd: string[];
}

export interface ScheduleFile {
  version: number;
  profile: string;
  synthetic_times: boolean;
  day_start: number;
  airports: Record<string, { types: string[]; airlines: string[]; rot: RotationsJson }>;
}
