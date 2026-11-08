export type BandKind =
  | 'sidewalk' | 'frontage' | 'furniture' | 'boulevard' | 'bike' | 'parking' | 'lane' | 'shoulder'
  | 'median' | 'row' | 'row_edge' | 'track' | 'ballast' | 'path' | 'platform' | 'barrier' | 'verge';

export type Mat =
  | 'asphalt' | 'asphalt_dark' | 'concrete' | 'pavers' | 'grass' | 'curb' | 'row_slab' | 'ballast' | 'platform'
  | 'gravel' | 'barrier' | 'bike' | 'paint_white' | 'paint_yellow' | 'paint_red' | 'tactile' | 'rail' | 'tie'
  | 'deck' | 'pier' | 'wall' | 'tunnel' | 'crossing_panel' | 'terrain' | 'dirt' | 'steel' | 'tie_wood';

export type VClass = 'car' | 'bus' | 'truck' | 'tram' | 'rail' | 'subway' | 'bike' | 'ped';
export type TrackKind = 'embedded' | 'ballast' | 'slab' | 'grass';
export type Family = 'road' | 'rail' | 'tram' | 'subway' | 'path' | 'platform';

export interface LaneDef {
  dir: 1 | -1;
  cls: VClass[];
  off?: number;
  speed?: number;
  track?: TrackKind;
}

export type PropKind =
  | 'lamp' | 'lamp_res' | 'tree' | 'tree_small' | 'hydrant' | 'bench' | 'bin' | 'fence' | 'pole_wood' | 'ocs_pole'
  | 'signal_pole' | 'stop_sign' | 'crossbuck' | 'gate' | 'shelter' | 'bus_stop' | 'tram_stop' | 'switch_machine'
  | 'canopy' | 'platform_lamp' | 'yield_sign' | 'ped_signal' | 'bollard' | 'buffer_stop' | 'rail_signal' | 'jersey'
  | 'pier' | 'portal';

export interface PropSlot { kind: PropKind; spacing: number; phase?: number; at?: number; continuous?: boolean }

export interface BandDef {
  kind: BandKind;
  w: number;
  h?: number;
  h1?: number;
  mat: Mat;
  lanes?: LaneDef[];
  slots?: PropSlot[];
}

export interface Asset {
  id: string;
  family: Family;
  rank: number;
  bands: BandDef[];
  speed: number;
  centre: 'double_yellow' | 'yellow_dashed' | 'yellow' | 'white_dashed' | 'none';
  laneLines: 'white_dashed' | 'none';
  edgeLines: boolean;
  radius: number;
  crosswalk: 'zebra' | 'lines' | 'none';
  rv: number;
  rh: number;
  skirt: number;
  maxEmbank: number;
  maxCut: number;
  walls: boolean;
  fenced: boolean;
  clearance: number;
  deckDepth: number;
  gauge: number;
}

const L = (dir: 1 | -1, cls: VClass[] = ['car', 'bus', 'truck', 'bike'], extra: Partial<LaneDef> = {}): LaneDef => ({ dir, cls, ...extra });
const lane = (w: number, ...lanes: LaneDef[]): BandDef => ({ kind: 'lane', w, h: 0, mat: 'asphalt', lanes });
const sidewalk = (w: number, slots: PropSlot[] = []): BandDef => ({ kind: 'sidewalk', w, h: 0.15, mat: 'concrete', lanes: [{ dir: 1, cls: ['ped'] }], slots });
const boulevard = (w: number, slots: PropSlot[] = []): BandDef => ({ kind: 'boulevard', w, h: 0.15, mat: 'grass', slots });
const furniture = (w: number, slots: PropSlot[] = []): BandDef => ({ kind: 'furniture', w, h: 0.15, mat: 'pavers', slots });
const parking = (w: number): BandDef => ({ kind: 'parking', w, h: 0, mat: 'asphalt' });

const base = {
  speed: 50, centre: 'none', laneLines: 'white_dashed', edgeLines: false, radius: 8, crosswalk: 'lines', rv: 600, rh: 30,
  skirt: 0.6, maxEmbank: 6, maxCut: 7, walls: false, fenced: false, clearance: 5, deckDepth: 1.4, gauge: 0,
} as const;

const TRAM_GAUGE = 1.495;
const STD_GAUGE = 1.435;

const trees = (spacing = 9): PropSlot[] => [{ kind: 'tree', spacing, phase: 4, at: 0 }];
const lamps = (spacing = 32, phase = 0): PropSlot[] => [{ kind: 'lamp', spacing, phase, at: 0 }];

export const ASSETS: Record<string, Asset> = {};
const def = (a: Partial<Asset> & Pick<Asset, 'id' | 'family' | 'rank' | 'bands'>) => {
  ASSETS[a.id] = { ...base, ...a } as Asset;
  return ASSETS[a.id];
};

def({
  id: 'local2', family: 'road', rank: 5, speed: 40, radius: 7, crosswalk: 'none',
  bands: [
    sidewalk(1.8), boulevard(2.6, [...trees(10), { kind: 'lamp_res', spacing: 38, phase: 12, at: 0.3 }]),
    lane(4.0, L(-1)), lane(4.0, L(1)),
    boulevard(2.6, [...trees(10), { kind: 'hydrant', spacing: 90, phase: 30, at: 0.2 }]), sidewalk(1.8),
  ],
});

def({
  id: 'collector2p', family: 'road', rank: 4, speed: 40, radius: 9, centre: 'yellow', crosswalk: 'lines',
  bands: [
    sidewalk(2.1), furniture(1.4, [...trees(11), ...lamps(30, 15)]), parking(2.4),
    lane(3.3, L(-1)), lane(3.3, L(1)),
    parking(2.4), furniture(1.4, [...trees(11), ...lamps(30, 0), { kind: 'hydrant', spacing: 80, phase: 40, at: 0 }]), sidewalk(2.1),
  ],
});

def({
  id: 'arterial4', family: 'road', rank: 3, speed: 50, radius: 11, centre: 'double_yellow', crosswalk: 'zebra',
  bands: [
    sidewalk(2.6, [{ kind: 'bin', spacing: 70, phase: 20, at: 0.35 }]), furniture(1.5, [...trees(12), ...lamps(30, 15)]),
    lane(3.4, L(-1)), lane(3.3, L(-1)), lane(3.3, L(1)), lane(3.4, L(1)),
    furniture(1.5, [...trees(12), ...lamps(30, 0)]), sidewalk(2.6, [{ kind: 'bench', spacing: 90, phase: 50, at: 0.35 }]),
  ],
});

def({
  id: 'arterial4_tram', family: 'road', rank: 3, speed: 40, radius: 12, centre: 'double_yellow', crosswalk: 'zebra',
  bands: [
    sidewalk(3.0), furniture(1.2, [...lamps(30, 15), { kind: 'ocs_pole', spacing: 30, phase: 15, at: 0.3 }]),
    lane(3.5, L(-1)), lane(3.3, L(-1, ['car', 'bus', 'truck', 'tram'], { track: 'embedded' })),
    lane(3.3, L(1, ['car', 'bus', 'truck', 'tram'], { track: 'embedded' })), lane(3.5, L(1)),
    furniture(1.2, [...lamps(30, 0), { kind: 'ocs_pole', spacing: 30, phase: 0, at: 0.3 }]), sidewalk(3.0),
  ],
});

def({
  id: 'arterial_row', family: 'road', rank: 3, speed: 50, radius: 12, centre: 'none', crosswalk: 'zebra',
  bands: [
    sidewalk(3.4, [{ kind: 'bin', spacing: 60, phase: 10, at: 0.35 }]), furniture(1.6, [...trees(12), ...lamps(30, 15)]),
    lane(3.4, L(-1)), lane(3.3, L(-1)),
    { kind: 'row_edge', w: 1.0, h: 0.15, mat: 'row_slab' },
    { kind: 'row', w: 7.0, h: 0.1, mat: 'row_slab', lanes: [
      { dir: -1, cls: ['tram'], off: -1.75, track: 'slab' }, { dir: 1, cls: ['tram'], off: 1.75, track: 'slab' },
    ], slots: [{ kind: 'ocs_pole', spacing: 32, phase: 6, at: 0 }] },
    { kind: 'row_edge', w: 1.0, h: 0.15, mat: 'row_slab' },
    lane(3.3, L(1)), lane(3.4, L(1)),
    furniture(1.6, [...trees(12), ...lamps(30, 0)]), sidewalk(3.4),
  ],
});

def({
  id: 'arterial6_median', family: 'road', rank: 2, speed: 60, radius: 13, centre: 'none', crosswalk: 'zebra',
  bands: [
    sidewalk(2.0), boulevard(3.0, [...trees(14), ...lamps(36, 18)]),
    lane(3.5, L(-1)), lane(3.4, L(-1)), lane(3.4, L(-1)),
    { kind: 'median', w: 3.0, h: 0.15, mat: 'grass', slots: [{ kind: 'lamp', spacing: 40, phase: 0, at: 0 }] },
    lane(3.4, L(1)), lane(3.4, L(1)), lane(3.5, L(1)),
    boulevard(3.0, [...trees(14), ...lamps(36, 0)]), sidewalk(2.0),
  ],
});

def({
  id: 'freeway6', family: 'road', rank: 0, speed: 100, radius: 0, centre: 'none', crosswalk: 'none', edgeLines: true,
  rv: 4000, rh: 600, maxEmbank: 9, maxCut: 9, clearance: 5.3, deckDepth: 2.0, skirt: 1.2,
  bands: [
    { kind: 'verge', w: 2.0, h: -0.05, h1: -0.6, mat: 'grass' },
    { kind: 'shoulder', w: 3.0, h: 0, mat: 'asphalt_dark' },
    lane(3.75, L(-1, ['car', 'bus', 'truck'], { speed: 100 })), lane(3.75, L(-1, ['car', 'bus', 'truck'], { speed: 100 })),
    lane(3.75, L(-1, ['car', 'bus', 'truck'], { speed: 100 })),
    { kind: 'shoulder', w: 1.2, h: 0, mat: 'asphalt_dark' },
    { kind: 'barrier', w: 0.8, h: 0, mat: 'asphalt_dark', slots: [{ kind: 'jersey', spacing: 1, continuous: true, at: 0 }] },
    { kind: 'shoulder', w: 1.2, h: 0, mat: 'asphalt_dark' },
    lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })), lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })),
    lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })),
    { kind: 'shoulder', w: 3.0, h: 0, mat: 'asphalt_dark' },
    { kind: 'verge', w: 2.0, h: -0.05, h1: -0.6, mat: 'grass' },
  ],
});

def({
  id: 'freeway3_oneway', family: 'road', rank: 0, speed: 100, radius: 0, centre: 'none', crosswalk: 'none', edgeLines: true,
  rv: 4000, rh: 600, maxEmbank: 9, maxCut: 9, clearance: 5.3, deckDepth: 2.0, skirt: 1.2,
  bands: [
    { kind: 'verge', w: 1.0, h: -0.05, h1: -0.4, mat: 'grass' },
    { kind: 'shoulder', w: 1.2, h: 0, mat: 'asphalt_dark' },
    lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })), lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })),
    lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })),
    { kind: 'shoulder', w: 3.0, h: 0, mat: 'asphalt_dark' },
    { kind: 'verge', w: 2.0, h: -0.05, h1: -0.6, mat: 'grass' },
  ],
});

def({
  id: 'freeway4_oneway', family: 'road', rank: 0, speed: 100, radius: 0, centre: 'none', crosswalk: 'none', edgeLines: true,
  rv: 4000, rh: 600, maxEmbank: 9, maxCut: 9, clearance: 5.3, deckDepth: 2.0, skirt: 1.2,
  bands: [
    { kind: 'verge', w: 1.0, h: -0.05, h1: -0.4, mat: 'grass' },
    { kind: 'shoulder', w: 1.2, h: 0, mat: 'asphalt_dark' },
    lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })), lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })),
    lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })), lane(3.75, L(1, ['car', 'bus', 'truck'], { speed: 100 })),
    { kind: 'shoulder', w: 3.0, h: 0, mat: 'asphalt_dark' },
    { kind: 'verge', w: 2.0, h: -0.05, h1: -0.6, mat: 'grass' },
  ],
});

def({
  id: 'ramp1', family: 'road', rank: 1, speed: 60, radius: 0, centre: 'none', crosswalk: 'none', edgeLines: true,
  rv: 1500, rh: 60, maxEmbank: 9, clearance: 5.3, deckDepth: 1.6, skirt: 1.0,
  bands: [
    { kind: 'verge', w: 1.0, h: -0.05, h1: -0.4, mat: 'grass' },
    { kind: 'shoulder', w: 1.0, h: 0, mat: 'asphalt_dark' },
    lane(4.0, L(1, ['car', 'bus', 'truck'], { speed: 60 })),
    { kind: 'shoulder', w: 2.5, h: 0, mat: 'asphalt_dark' },
    { kind: 'verge', w: 1.0, h: -0.05, h1: -0.4, mat: 'grass' },
  ],
});

def({
  id: 'laneway', family: 'road', rank: 6, speed: 20, radius: 4, crosswalk: 'none', laneLines: 'none',
  bands: [{ kind: 'lane', w: 2.6, h: 0, mat: 'asphalt', lanes: [L(-1, ['car', 'truck', 'bike'], { speed: 20 })] },
    { kind: 'lane', w: 2.6, h: 0, mat: 'asphalt', lanes: [L(1, ['car', 'truck', 'bike'], { speed: 20 })] }],
});

const railBands = (track: TrackKind = 'ballast', cls: VClass = 'rail'): BandDef[] => [
  { kind: 'ballast', w: 1.4, h: -0.95, h1: -0.4, mat: 'ballast' },
  { kind: 'track', w: 3.0, h: -0.4, mat: 'ballast', lanes: [{ dir: 1, cls: [cls], track }] },
  { kind: 'ballast', w: 1.4, h: -0.4, h1: -0.95, mat: 'ballast' },
];

def({
  id: 'rail', family: 'rail', rank: 1, speed: 120, radius: 0, crosswalk: 'none', laneLines: 'none',
  rv: 8000, rh: 300, maxEmbank: 8, maxCut: 8, clearance: 7, deckDepth: 2.2, skirt: 1.5, fenced: false, gauge: STD_GAUGE,
  bands: railBands(),
});

def({
  id: 'rail_yard', family: 'rail', rank: 1, speed: 25, radius: 0, crosswalk: 'none', laneLines: 'none',
  rv: 4000, rh: 150, skirt: 1.2, gauge: STD_GAUGE,
  bands: railBands(),
});

def({
  id: 'subway', family: 'subway', rank: 0, speed: 80, radius: 0, crosswalk: 'none', laneLines: 'none',
  rv: 3000, rh: 200, clearance: 5, deckDepth: 1.8, skirt: 1.2, fenced: true, gauge: TRAM_GAUGE,
  bands: railBands('ballast', 'subway'),
});

def({
  id: 'tram_row', family: 'tram', rank: 4, speed: 50, radius: 0, crosswalk: 'none', laneLines: 'none',
  rv: 800, rh: 15, skirt: 0.5, gauge: TRAM_GAUGE,
  bands: [
    { kind: 'row_edge', w: 0.6, h: 0.0, mat: 'curb' },
    { kind: 'row', w: 3.2, h: 0.0, mat: 'grass', lanes: [{ dir: 1, cls: ['tram'], track: 'grass' }] },
    { kind: 'row_edge', w: 0.6, h: 0.0, mat: 'curb' },
  ],
});

def({
  id: 'tram_street', family: 'tram', rank: 4, speed: 40, radius: 0, crosswalk: 'none', laneLines: 'none',
  rv: 800, rh: 15, skirt: 0.3, gauge: TRAM_GAUGE,
  bands: [{ kind: 'row', w: 3.2, h: 0.0, mat: 'asphalt', lanes: [{ dir: 1, cls: ['tram'], track: 'embedded' }] }],
});

def({
  id: 'footway', family: 'path', rank: 7, speed: 5, radius: 1.5, crosswalk: 'none', laneLines: 'none', skirt: 0.25, rh: 3,
  bands: [{ kind: 'path', w: 2.4, h: 0, mat: 'concrete', lanes: [{ dir: 1, cls: ['ped', 'bike'] }] }],
});

def({
  id: 'trail', family: 'path', rank: 7, speed: 15, radius: 3, crosswalk: 'none', laneLines: 'none', skirt: 0.25, rh: 6,
  bands: [{ kind: 'path', w: 3.0, h: 0, mat: 'asphalt', lanes: [{ dir: 1, cls: ['ped', 'bike'] }],
    slots: [{ kind: 'lamp', spacing: 35, phase: 10, at: 0.7 }] }],
});

const tactile = (): BandDef => ({ kind: 'platform', w: 0.6, h: 0, mat: 'tactile' });
const platformAsset = (id: string, w: number, edges: 'both' | 'left' | 'right', slots: PropSlot[]) => def({
  id, family: 'platform', rank: 7, speed: 5, radius: 0, crosswalk: 'none', laneLines: 'none', skirt: 1.2,
  bands: [
    ...(edges !== 'right' ? [tactile()] : []),
    { kind: 'platform', w: w - (edges === 'both' ? 1.2 : 0.6), h: 0, mat: 'platform', lanes: [{ dir: 1, cls: ['ped'] }], slots },
    ...(edges !== 'left' ? [tactile()] : []),
  ],
});
const goSlots: PropSlot[] = [{ kind: 'canopy', spacing: 12, phase: 6, at: 0 }, { kind: 'bench', spacing: 24, phase: 12, at: 0.25 }];
const subSlots: PropSlot[] = [{ kind: 'platform_lamp', spacing: 10, phase: 5, at: 0 }, { kind: 'bench', spacing: 30, phase: 15, at: 0.3 }];
platformAsset('platform_go', 7, 'both', goSlots);
platformAsset('platform_go_l', 7, 'left', goSlots);
platformAsset('platform_go_r', 7, 'right', goSlots);
platformAsset('platform_subway', 10, 'both', subSlots);
platformAsset('platform_tram', 3, 'both', [{ kind: 'shelter', spacing: 30, phase: 10, at: 0.1 }]);

export function asset(id: string): Asset {
  const a = ASSETS[id];
  if (!a) throw new Error(`unknown asset ${id}`);
  return a;
}

export const WALK_KINDS = new Set<BandKind>(['sidewalk', 'frontage', 'furniture', 'boulevard', 'verge']);
export const CARRIAGE_KINDS = new Set<BandKind>(['lane', 'parking', 'bike', 'shoulder', 'median', 'row', 'row_edge', 'barrier']);

export function assetWidth(a: Asset) {
  return a.bands.reduce((s, b) => s + b.w, 0);
}

export interface BandLayout { band: BandDef; i: number; l: number; r: number; hl: number; hr: number }

export function layout(a: Asset): BandLayout[] {
  const W = assetWidth(a);
  let x = W / 2;
  return a.bands.map((band, i) => {
    const l = x, r = x - band.w;
    x = r;
    const h = band.h ?? 0;
    return { band, i, l, r, hl: h, hr: band.h1 ?? h };
  });
}

export function carriageway(a: Asset): { l: number; r: number } | null {
  const lay = layout(a);
  const c = lay.filter((b) => CARRIAGE_KINDS.has(b.band.kind));
  if (!c.length) return null;
  return { l: c[0].l, r: c[c.length - 1].r };
}

export function oneway(a: Asset): boolean {
  const dirs = new Set<number>();
  for (const b of a.bands) for (const ln of b.lanes ?? []) if (ln.cls.some((c) => c === 'car' || c === 'rail' || c === 'subway' || c === 'tram')) dirs.add(ln.dir);
  return dirs.size === 1;
}
