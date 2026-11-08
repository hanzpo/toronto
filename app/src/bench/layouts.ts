import { NetBuilder, type NetDesc, type TerrainDesc } from '../net/core/desc';
import { turnout } from '../net/core/path';

export interface Layout {
  id: string;
  title: string;
  desc: () => NetDesc;
  cam: [number, number, number, number, number];
  pop?: [number, number, number, number, number];
}

function terrain(f: (x: number, y: number) => number, half = 300, cell = 1, cx = 0, cy = 0): TerrainDesc {
  const n = Math.round((half * 2) / cell) + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = f(cx - half + i * cell, cy - half + j * cell);
  return { x0: cx - half, y0: cy - half, cell, nx: n, ny: n, h };
}

const flat = (half = 250, cell = 1) => terrain(() => 0, half, cell);

function cross4(a1: string, a2: string, ctrl?: 'signal' | 'stop' | 'allstop', len = 110, angle = 0) {
  const b = new NetBuilder();
  const c = b.node(0, 0, 0, { id: 'c', control: ctrl ?? 'auto' });
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const e = b.node(len, 0), w = b.node(-len, 0);
  const n = b.node(len * -sa, len * ca), s = b.node(-len * -sa, -len * ca);
  b.seg(a1, w, c, { id: 'W' }); b.seg(a1, c, e, { id: 'E' });
  b.seg(a2, s, c, { id: 'S' }); b.seg(a2, c, n, { id: 'N' });
  return b;
}

export const LAYOUTS: Layout[] = [
  {
    id: 'arterial-x', title: 'Arterial × arterial, signals',
    desc: () => cross4('arterial4', 'arterial4', 'signal').desc(flat()),
    cam: [0, -10, 60, 30, 38],
    pop: [16, 2, 0, 0, 40],
  },
  {
    id: 'king-spadina', title: 'Streetcar mixed × streetcar ROW, special work',
    desc: () => {
      const b = new NetBuilder();
      const c = b.node(0, 0, 0, { id: 'c', control: 'signal', tram: [['W', 'E'], ['E', 'W'], ['S', 'N'], ['N', 'S'], ['N', 'E'], ['W', 'N'], ['S', 'W'], ['E', 'S']] });
      const e = b.node(140, 0), w = b.node(-140, 0), n = b.node(0, 140), s = b.node(0, -140);
      b.seg('arterial4_tram', w, c, { id: 'W' }); b.seg('arterial4_tram', c, e, { id: 'E' });
      b.seg('arterial_row', s, c, { id: 'S' }); b.seg('arterial_row', c, n, { id: 'N' });
      return b.desc(flat());
    },
    cam: [0, 0, 75, 20, 50],
    pop: [14, 0, 5, 0, 40],
  },
  {
    id: 'local-t', title: 'Local street T onto collector, stop sign',
    desc: () => {
      const b = new NetBuilder();
      const c = b.node(0, 0, 0, { id: 'c' });
      b.seg('collector2p', b.node(-120, 0), c, { id: 'W' });
      b.seg('collector2p', c, b.node(120, 0), { id: 'E' });
      b.seg('local2', b.node(0, -110), c, { id: 'S' });
      return b.desc(flat());
    },
    cam: [0, -5, 50, 30, 40],
    pop: [8, 0, 0, 0, 12],
  },
  {
    id: 'allway', title: 'Local × local, all-way stop',
    desc: () => cross4('local2', 'local2', 'allstop').desc(flat()),
    cam: [0, 0, 45, 35, 40],
    pop: [10, 0, 0, 0, 16],
  },
  {
    id: 'skew', title: 'Skewed junction, divided arterial × collector',
    desc: () => {
      const b = new NetBuilder();
      const c = b.node(0, 0, 0, { id: 'c' });
      b.seg('arterial6_median', b.node(-150, 0), c, { id: 'W' });
      b.seg('arterial6_median', c, b.node(150, 0), { id: 'E' });
      b.seg('collector2p', b.node(-70, -120), c, { id: 'S' });
      b.seg('collector2p', c, b.node(90, 130), { id: 'N' });
      return b.desc(flat());
    },
    cam: [0, 0, 80, 10, 50],
    pop: [16, 2, 0, 0, 24],
  },
  {
    id: 'level-crossing', title: 'Road × double-track main line, gates',
    desc: () => {
      const b = new NetBuilder();
      const z = 0;
      const c = b.node(0, 0, z, { id: 'c' });
      b.seg('collector2p', b.node(-130, 0), c, { id: 'W' });
      b.seg('collector2p', c, b.node(130, 0), { id: 'E' });
      const ang = (70 * Math.PI) / 180;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const nx = -dy, ny = dx;
      for (const off of [-2.25, 2.25]) {
        const a0 = b.node(-dx * 220 + nx * off, -dy * 220 + ny * off, z), a1 = b.node(dx * 220 + nx * off, dy * 220 + ny * off, z);
        b.seg('rail', a0, c, { id: `R${off}a`, offB: off });
        b.seg('rail', c, a1, { id: `R${off}b`, offA: off });
      }
      return b.desc(flat());
    },
    cam: [0, 0, 55, 30, 30],
    pop: [10, 0, 0, 2, 10],
  },
  {
    id: 'tram-crossing', title: 'Road × streetcar on its own ROW',
    desc: () => {
      const b = new NetBuilder();
      const c = b.node(0, 0, 0, { id: 'c' });
      b.seg('local2', b.node(-110, 0), c, { id: 'W' });
      b.seg('local2', c, b.node(110, 0), { id: 'E' });
      for (const [off, dir] of [[-1.75, 'fwd'], [1.75, 'back']] as const) {
        const a0 = b.node(off, -150), a1 = b.node(off, 150);
        b.seg('tram_row', a0, c, { id: `T${off}a`, offB: -off, dir });
        b.seg('tram_row', c, a1, { id: `T${off}b`, offA: -off, dir });
      }
      return b.desc(flat());
    },
    cam: [0, 0, 40, 40, 35],
    pop: [8, 0, 4, 0, 10],
  },
  {
    id: 'rail-yard', title: 'Crossover, siding, diamond and buffer stop',
    desc: () => {
      const b = new NetBuilder();
      const y1 = -2.25, y2 = 2.25;
      const R = 300, Lt = 32;
      const A1 = b.node(-260, y1), A2 = b.node(-260, y2);
      const s1 = b.node(-60, y1, 0, { id: 'sw1' });
      const t1 = turnout({ x: -60, y: y1 }, { x: 1, y: 0 }, 1, R, Lt);
      const e1 = t1[t1.length - 1];
      const dy1 = y2 - e1.y;
      const ang = Lt / R;
      const runx = dy1 / Math.tan(ang);
      const s2x = e1.x + runx + (e1.x - (-60) - 0) * 1;
      const s2 = b.node(s2x, y2, 0, { id: 'sw2' });
      b.seg('rail', A1, s1, { id: 'm1a' });
      b.seg('rail', A2, s2, { id: 'm2a' });
      b.seg('rail', s1, s2, { id: 'xo', curve: 'hermite', ta: { x: 1, y: 0 }, tb: { x: 1, y: 0 } });
      const s3 = b.node(60, y1, 0, { id: 'sw3' });
      b.seg('rail', s1, s3, { id: 'm1b' });
      const B1 = b.node(260, y1), B2 = b.node(260, y2);
      b.seg('rail', s2, B2, { id: 'm2b' });
      const sid = turnout({ x: 60, y: y1 }, { x: 1, y: 0 }, -1, 250, 30, 0);
      const se = sid[sid.length - 1];
      const end = b.node(220, se.y - 2.5);
      b.seg('rail', s3, b.node(se.x + 15, se.y - 1.6, 0, { id: 'sid1' }), { id: 'sidA', curve: 'hermite', ta: { x: 1, y: 0 }, tb: { x: 1, y: -0.12 } });
      b.seg('rail_yard', 'sid1', end, { id: 'sidB', curve: 'hermite', ta: { x: 1, y: -0.12 }, tb: { x: 1, y: 0 } });
      const d = b.node(140, y1, 0, { id: 'dia' });
      b.seg('rail', s3, d, { id: 'm1c' });
      b.seg('rail', d, B1, { id: 'm1d' });
      b.seg('rail', b.node(140 - 60, -60), d, { id: 'xa' });
      b.seg('rail', d, b.node(140 + 60, 60), { id: 'xb' });
      void s2x;
      return b.desc(flat(300));
    },
    cam: [-20, 0, 70, 10, 40],
    pop: [0, 0, 0, 3, 0],
  },
  {
    id: 'freeway-merge', title: 'Freeway on-ramp merge',
    desc: () => {
      const b = new NetBuilder();
      const m = b.node(0, 0, 0, { id: 'm' });
      b.seg('freeway3_oneway', b.node(-260, 0), m, { id: 'main' });
      b.seg('freeway4_oneway', m, b.node(260, -1.875), { id: 'out', offA: -1.875 });
      b.seg('ramp1', b.node(-260, -60), m, { id: 'ramp', pts: [{ x: -150, y: -18 }], r: 400 });
      return b.desc(flat(300, 2));
    },
    cam: [-20, -10, 80, 20, 35],
    pop: [30, 2, 0, 0, 0],
  },
  {
    id: 'overpass', title: 'Arterial bridge over a freeway, rail embankment over a road',
    desc: () => {
      const b = new NetBuilder();
      b.seg('freeway6', b.node(-280, 0, 0), b.node(280, 0, 0), { id: 'fw' });
      b.seg('arterial4', b.node(0, -260, 0), b.node(0, 260, 0), { id: 'art', z: [{ s: 0.35, z: 0 }, { s: 0.5, z: 7.4 }, { s: 0.65, z: 0 }] });
      b.seg('local2', b.node(120, -260, 0), b.node(120, -90, 0), { id: 'l' });
      return b.desc(flat(300, 1));
    },
    cam: [0, 0, 120, 30, 30],
    pop: [30, 2, 0, 0, 10],
  },
  {
    id: 'cut-tunnel', title: 'Rail cut, portal and tunnel under a hill',
    desc: () => {
      const b = new NetBuilder();
      const hill = (x: number, y: number) => 22 * Math.exp(-((x - 60) ** 2) / (2 * 90 ** 2) - (y ** 2) / (2 * 140 ** 2));
      b.seg('rail', b.node(-280, 0, 0), b.node(280, 0, 0), { id: 'r', z: [{ s: 0.25, z: 0 }, { s: 0.6, z: -4 }] });
      b.seg('rail', b.node(-280, 4.5, 0), b.node(280, 4.5, 0), { id: 'r2', z: [{ s: 0.25, z: 0 }, { s: 0.6, z: -4 }] });
      return b.desc(terrain(hill, 300, 2));
    },
    cam: [-60, 0, 120, 30, 30],
    pop: [0, 0, 0, 2, 0],
  },
  {
    id: 'paths', title: 'Footpaths, path junction and mid-block crosswalk',
    desc: () => {
      const b = new NetBuilder();
      const m = b.node(0, 0, 0, { id: 'x' });
      b.seg('collector2p', b.node(-120, 0), m, { id: 'W' });
      b.seg('collector2p', m, b.node(120, 0), { id: 'E' });
      const j = b.node(10, 40, 0, { id: 'pj' });
      b.seg('footway', b.node(0, -60), m, { id: 'pS' });
      b.seg('footway', m, j, { id: 'pN' });
      b.seg('footway', j, b.node(-40, 80), { id: 'pNW' });
      b.seg('footway', j, b.node(70, 70), { id: 'pNE' });
      return b.desc(flat());
    },
    cam: [0, 10, 50, 20, 45],
    pop: [10, 0, 0, 0, 40],
  },
  {
    id: 'station', title: 'GO station, side platforms',
    desc: () => {
      const b = new NetBuilder();
      b.seg('rail', b.node(-250, -2.25, 0), b.node(250, -2.25, 0), { id: 't1' });
      b.seg('rail', b.node(-250, 2.25, 0), b.node(250, 2.25, 0), { id: 't2' });
      b.seg('platform_go', b.node(-90, -7.4, 0.25), b.node(90, -7.4, 0.25), { id: 'p1' });
      b.seg('platform_go', b.node(-90, 7.4, 0.25), b.node(90, 7.4, 0.25), { id: 'p2' });
      return b.desc(flat());
    },
    cam: [0, 0, 60, 20, 30],
    pop: [0, 0, 0, 2, 30],
  },
];
