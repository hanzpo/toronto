// Parametric low-poly airliner models (to scale), for instanced rendering.
//
// Frame (metres): +x forward, +y up, +z right (starboard). Origin = the main
// landing-gear contact point on the ground, so the plane pitches about its
// main gear on rotation / flare and sits on the ground at y = 0.
//
// Attributes: position, normal (smooth fuselage/nacelles, flat surfaces),
// color (linear, baked for fixed parts), part (float id, see PART) — the
// renderer replaces part colours with per-instance livery colours and hides
// the gear (part GEAR) when retracted.
import * as THREE from 'three/webgpu';

export const PART = { FIXED: 0, FUSE: 1, TAIL: 2, BELLY: 3, ACCENT: 4, ENGINE: 5, GEAR: 6 } as const;

export interface AircraftSpec {
  code: string;
  name: string;
  length: number;
  span: number;
  height: number;
  fusD: number;
  /** fuselage bottom above ground (gear down) */
  gearH: number;
  wing: { rootChord: number; tipRatio: number; sweep: number; dihedral: number; x: number; high?: boolean; winglet: 'none' | 'blended' | 'sharklet' | 'split' | 'raked' | 'curved' };
  engines: { kind: 'fan' | 'prop'; count: 2; mount: 'wing' | 'aft'; d: number; len: number; y?: number; spanFrac: number };
  tail: { t?: boolean };
  /** approach reference speed m/s, takeoff rotate speed m/s */
  vref: number;
  vr: number;
  cls: 'turboprop' | 'regional' | 'narrow' | 'wide';
  windowPitch?: number;
  freighter?: boolean;
}

const narrow = (code: string, name: string, length: number, o: Partial<AircraftSpec> & { d?: number; winglet?: AircraftSpec['wing']['winglet'] } = {}): AircraftSpec => ({
  code, name, length, span: 35.8, height: 11.8, fusD: 3.95, gearH: 1.25,
  wing: { rootChord: 7.0, tipRatio: 0.26, sweep: 27, dihedral: 5.5, x: 0.36, winglet: o.winglet ?? 'sharklet' },
  engines: { kind: 'fan', count: 2, mount: 'wing', d: o.d ?? 2.0, len: 4.4, spanFrac: 0.34 },
  tail: {}, vref: 70, vr: 75, cls: 'narrow', ...o,
});

export const AIRCRAFT: Record<string, AircraftSpec> = {
  DH8D: {
    code: 'DH8D', name: 'De Havilland Dash 8-400', length: 32.8, span: 28.4, height: 8.3, fusD: 2.69, gearH: 1.0,
    wing: { rootChord: 3.2, tipRatio: 0.5, sweep: 3, dihedral: 2.5, x: 0.39, high: true, winglet: 'none' },
    engines: { kind: 'prop', count: 2, mount: 'wing', d: 1.25, len: 5.6, spanFrac: 0.29 },
    tail: { t: true }, vref: 60, vr: 58, cls: 'turboprop', windowPitch: 0.8,
  },
  CRJ9: {
    code: 'CRJ9', name: 'Bombardier CRJ900', length: 36.2, span: 24.9, height: 7.5, fusD: 2.69, gearH: 0.65,
    wing: { rootChord: 4.6, tipRatio: 0.3, sweep: 27, dihedral: 3, x: 0.44, winglet: 'blended' },
    engines: { kind: 'fan', count: 2, mount: 'aft', d: 1.35, len: 3.6, spanFrac: 0 },
    tail: { t: true }, vref: 70, vr: 72, cls: 'regional', windowPitch: 0.52,
  },
  E75L: {
    code: 'E75L', name: 'Embraer 175', length: 31.7, span: 26.0, height: 9.9, fusD: 3.01, gearH: 0.95,
    wing: { rootChord: 5.0, tipRatio: 0.3, sweep: 25, dihedral: 5, x: 0.36, winglet: 'blended' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 1.45, len: 3.4, spanFrac: 0.3 },
    tail: {}, vref: 66, vr: 68, cls: 'regional', windowPitch: 0.5,
  },
  E295: {
    code: 'E295', name: 'Embraer 195-E2', length: 41.5, span: 35.1, height: 10.9, fusD: 3.01, gearH: 1.15,
    wing: { rootChord: 5.8, tipRatio: 0.24, sweep: 26, dihedral: 5, x: 0.37, winglet: 'none' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 2.0, len: 3.9, spanFrac: 0.3 },
    tail: {}, vref: 68, vr: 72, cls: 'narrow', windowPitch: 0.5,
  },
  BCS3: {
    code: 'BCS3', name: 'Airbus A220-300', length: 38.7, span: 35.1, height: 11.5, fusD: 3.5, gearH: 1.1,
    wing: { rootChord: 6.2, tipRatio: 0.24, sweep: 25, dihedral: 5, x: 0.37, winglet: 'raked' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 2.05, len: 4.0, spanFrac: 0.31 },
    tail: {}, vref: 67, vr: 72, cls: 'narrow',
  },
  A319: narrow('A319', 'Airbus A319', 33.8, { winglet: 'none' }),
  A320: narrow('A320', 'Airbus A320', 37.6, { winglet: 'sharklet' }),
  A20N: narrow('A20N', 'Airbus A320neo', 37.6, { d: 2.3, winglet: 'sharklet' }),
  A321: narrow('A321', 'Airbus A321', 44.5, { winglet: 'sharklet', vref: 72, vr: 78 }),
  A21N: narrow('A21N', 'Airbus A321neo', 44.5, { d: 2.3, winglet: 'sharklet', vref: 72, vr: 78 }),
  B737: narrow('B737', 'Boeing 737-700', 33.6, { fusD: 3.76, gearH: 0.95, height: 12.5, d: 1.85, winglet: 'blended' }),
  B738: narrow('B738', 'Boeing 737-800', 39.5, { fusD: 3.76, gearH: 0.95, height: 12.5, d: 1.85, winglet: 'blended', vref: 72, vr: 78 }),
  B38M: narrow('B38M', 'Boeing 737 MAX 8', 39.5, { fusD: 3.76, gearH: 1.0, height: 12.3, d: 2.05, span: 35.9, winglet: 'split', vref: 72, vr: 78 }),
  B39M: narrow('B39M', 'Boeing 737 MAX 9', 42.2, { fusD: 3.76, gearH: 1.0, height: 12.3, d: 2.05, span: 35.9, winglet: 'split', vref: 73, vr: 79 }),
  B752: narrow('B752', 'Boeing 757-200F', 47.3, { fusD: 3.76, gearH: 1.6, height: 13.6, span: 38.1, d: 2.3, winglet: 'blended', vref: 70, vr: 76, freighter: true }),
  B763: {
    code: 'B763', name: 'Boeing 767-300F', length: 54.9, span: 47.6, height: 15.9, fusD: 5.03, gearH: 1.55,
    wing: { rootChord: 9.5, tipRatio: 0.24, sweep: 31, dihedral: 6, x: 0.37, winglet: 'none' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 2.7, len: 5.0, spanFrac: 0.32 },
    tail: {}, vref: 75, vr: 80, cls: 'wide', freighter: true,
  },
  B788: {
    code: 'B788', name: 'Boeing 787-8', length: 56.7, span: 60.1, height: 17.0, fusD: 5.77, gearH: 1.7,
    wing: { rootChord: 10.5, tipRatio: 0.18, sweep: 32, dihedral: 7, x: 0.37, winglet: 'raked' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 3.1, len: 5.6, spanFrac: 0.31 },
    tail: {}, vref: 72, vr: 80, cls: 'wide', windowPitch: 0.53,
  },
  B789: {
    code: 'B789', name: 'Boeing 787-9', length: 62.8, span: 60.1, height: 17.0, fusD: 5.77, gearH: 1.7,
    wing: { rootChord: 10.5, tipRatio: 0.18, sweep: 32, dihedral: 7, x: 0.38, winglet: 'raked' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 3.1, len: 5.6, spanFrac: 0.31 },
    tail: {}, vref: 74, vr: 82, cls: 'wide', windowPitch: 0.53,
  },
  A333: {
    code: 'A333', name: 'Airbus A330-300', length: 63.7, span: 60.3, height: 16.8, fusD: 5.64, gearH: 1.7,
    wing: { rootChord: 10.5, tipRatio: 0.2, sweep: 30, dihedral: 5.5, x: 0.38, winglet: 'blended' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 2.9, len: 5.5, spanFrac: 0.32 },
    tail: {}, vref: 72, vr: 80, cls: 'wide',
  },
  A339: {
    code: 'A339', name: 'Airbus A330-900', length: 63.7, span: 64.0, height: 16.8, fusD: 5.64, gearH: 1.7,
    wing: { rootChord: 10.5, tipRatio: 0.2, sweep: 30, dihedral: 5.5, x: 0.38, winglet: 'sharklet' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 3.2, len: 5.8, spanFrac: 0.32 },
    tail: {}, vref: 72, vr: 80, cls: 'wide',
  },
  A359: {
    code: 'A359', name: 'Airbus A350-900', length: 66.8, span: 64.8, height: 17.1, fusD: 5.96, gearH: 1.8,
    wing: { rootChord: 11.0, tipRatio: 0.17, sweep: 31.9, dihedral: 6, x: 0.38, winglet: 'curved' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 3.25, len: 6.0, spanFrac: 0.3 },
    tail: {}, vref: 72, vr: 80, cls: 'wide', windowPitch: 0.53,
  },
  B77W: {
    code: 'B77W', name: 'Boeing 777-300ER', length: 73.9, span: 64.8, height: 18.5, fusD: 6.2, gearH: 1.9,
    wing: { rootChord: 12.5, tipRatio: 0.18, sweep: 31.6, dihedral: 6, x: 0.39, winglet: 'raked' },
    engines: { kind: 'fan', count: 2, mount: 'wing', d: 3.6, len: 7.0, spanFrac: 0.3 },
    tail: {}, vref: 76, vr: 85, cls: 'wide', windowPitch: 0.53,
  },
};

// ------------------------------------------------------------------ builder

type C3 = [number, number, number];
const lin = (hex: number): C3 => {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};
const COL = {
  wing: lin(0xc3c8ce), wingDark: lin(0x9aa1a8), glass: lin(0x1a2129), dark: lin(0x2b2f35),
  gear: lin(0x3a3d42), tyre: lin(0x151618), metal: lin(0xb4b9bf), prop: lin(0x26282c), white: lin(0xf2f3f4),
};

class AB {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  part: number[] = [];
  idx: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: C3, p: number) {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.col.push(c[0], c[1], c[2]); this.part.push(p);
    return this.pos.length / 3 - 1;
  }
  /** flat polygon (convex fan), `side` = rough outward hint */
  poly(pts: THREE.Vector3[], c: C3, p: number, hint?: THREE.Vector3) {
    const n = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y);
    }
    if (n.lengthSq() < 1e-12) return;
    n.normalize();
    let flip = false;
    if (hint && n.dot(hint) < 0) { n.negate(); flip = true; }
    const base = pts.map((q) => this.v(q.x, q.y, q.z, n.x, n.y, n.z, c, p));
    for (let i = 1; i < pts.length - 1; i++) {
      if (flip) this.idx.push(base[0], base[i + 1], base[i]);
      else this.idx.push(base[0], base[i], base[i + 1]);
    }
  }
  /** double-sided flat polygon (thin decals / blades) */
  poly2(pts: THREE.Vector3[], c: C3, p: number, hint: THREE.Vector3) {
    this.poly(pts, c, p, hint);
    this.poly(pts, c, p, hint.clone().negate());
  }
  /**
   * Loft of rings around the x axis. rings: [x, cy, rz (half width), ry (half height)].
   * Angles a0..a1 (radians, 0 = +y top, increasing towards +z) with `seg` steps.
   */
  loft(rings: [number, number, number, number][], a0: number, a1: number, seg: number, c: C3, p: number, cz = 0) {
    const cols = seg + 1;
    const base = this.pos.length / 3;
    for (let r = 0; r < rings.length; r++) {
      const [x, cy, rz, ry] = rings[r];
      // slope of radius for the normal's x component
      const prev = rings[Math.max(0, r - 1)], next = rings[Math.min(rings.length - 1, r + 1)];
      const dx = next[0] - prev[0] || 1e-3;
      const dr = ((next[2] + next[3]) - (prev[2] + prev[3])) / 2;
      for (let i = 0; i < cols; i++) {
        const a = a0 + ((a1 - a0) * i) / seg;
        const sy = Math.cos(a), sz = Math.sin(a);
        const ny0 = sy / Math.max(ry, 1e-3), nz0 = sz / Math.max(rz, 1e-3);
        const nl = Math.hypot(ny0, nz0) || 1;
        const nx = -dr / dx;
        const L = Math.hypot(nx, 1);
        this.v(x, cy + sy * ry, cz + sz * rz, nx / L, ny0 / nl / L, nz0 / nl / L, c, p);
      }
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let i = 0; i < seg; i++) {
        const a = base + r * cols + i, b = a + 1, d = a + cols, e = d + 1;
        // outward winding: ring r+1 is further +x
        this.idx.push(a, b, d, b, e, d);
      }
    }
  }
  /** thin lifting surface: root/tip LE + chord, thickness, top/bottom faces + edges (flat). */
  surface(rootLE: THREE.Vector3, rootChord: number, tipLE: THREE.Vector3, tipChord: number, thick: number, c: C3, p: number, vertical = false) {
    const up = vertical ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const rt = rootLE.clone().add(new THREE.Vector3(-rootChord, 0, 0));
    const tt = tipLE.clone().add(new THREE.Vector3(-tipChord, 0, 0));
    // mid-chord ridge (max thickness at 35% chord)
    const rm = rootLE.clone().add(new THREE.Vector3(-rootChord * 0.35, 0, 0));
    const tm = tipLE.clone().add(new THREE.Vector3(-tipChord * 0.35, 0, 0));
    const tr = thick * rootChord / 2, tp = thick * tipChord / 2;
    const rmU = rm.clone().addScaledVector(up, tr), rmD = rm.clone().addScaledVector(up, -tr);
    const tmU = tm.clone().addScaledVector(up, tp), tmD = tm.clone().addScaledVector(up, -tp);
    this.poly([rootLE, tipLE, tmU, rmU], c, p, up);
    this.poly([rmU, tmU, tt, rt], c, p, up);
    this.poly([rootLE, tipLE, tmD, rmD], c, p, up.clone().negate());
    this.poly([rmD, tmD, tt, rt], c, p, up.clone().negate());
    const out = tipLE.clone().sub(rootLE).normalize();
    this.poly([tipLE, tmU, tt, tmD], c, p, out);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('part', new THREE.BufferAttribute(new Float32Array(this.part), 1));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Key points (model frame) used by the renderer for lights. */
export interface AircraftPoints {
  wingTipL: THREE.Vector3; wingTipR: THREE.Vector3; tail: THREE.Vector3; beaconTop: THREE.Vector3; beaconBottom: THREE.Vector3;
  landing: THREE.Vector3; nose: THREE.Vector3;
  /** x of nose / tail relative to origin */
  noseX: number; tailX: number;
}

export interface AircraftModel { spec: AircraftSpec; geometry: THREE.BufferGeometry; points: AircraftPoints }

const cache = new Map<string, AircraftModel>();

export function aircraftModel(code: string): AircraftModel {
  const k = AIRCRAFT[code] ? code : 'A320';
  let m = cache.get(k);
  if (!m) { m = buildAircraft(AIRCRAFT[k]); cache.set(k, m); }
  return m;
}

function buildAircraft(s: AircraftSpec): AircraftModel {
  const b = new AB();
  const L = s.length, R = s.fusD / 2;
  // x coordinates measured from the nose, converted to origin = main gear at the end
  const wingLE = L * s.wing.x;
  const mainGearX = wingLE + s.wing.rootChord * (s.wing.high ? 0.55 : 0.62);
  const X = (fromNose: number) => mainGearX - fromNose; // model x (forward +)
  const cy = s.gearH + R; // fuselage centre height
  const top = cy + R;

  // ---- fuselage rings (x from nose): nose cap, barrel, tail cone rising to the top line
  const noseLen = R * 2.1, tailLen = R * (s.cls === 'turboprop' ? 3.6 : 3.4);
  const rings: [number, number, number, number][] = [];
  const NR = 8;
  for (let i = 0; i <= NR; i++) {
    const t = i / NR; // 0 tip -> 1 barrel
    const f = Math.sqrt(1 - (1 - t) * (1 - t)); // ellipse
    const r = Math.max(0.06, R * f);
    const drop = (1 - f) * R * 0.28; // nose tip sits a little below the centre line
    rings.push([X(t * noseLen), cy - drop, r, r]);
  }
  rings.push([X(L - tailLen), cy, R, R]);
  const NT = 6;
  for (let i = 1; i <= NT; i++) {
    const t = i / NT;
    const r = R * (1 - 0.86 * Math.pow(t, 1.15));
    const c = top - r - (1 - t) * 0; // top line stays level; bottom line sweeps up
    rings.push([X(L - tailLen + t * tailLen), c + t * R * 0.05, r * (1 - 0.1 * t), r]);
  }
  // loft expects increasing x: our X() decreases with fromNose, so reverse
  const ringsX = rings.slice().reverse();
  const belly0 = Math.PI * 0.64, belly1 = Math.PI * 1.36;
  b.loft(ringsX, -belly0, belly0, 14, COL.white, PART.FUSE);
  b.loft(ringsX, belly0, belly1, 6, COL.white, PART.BELLY);
  // tail cap
  const tr = ringsX[0];
  b.poly(Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2; return V(tr[0] - 0.01, tr[1] + Math.cos(a) * tr[3], Math.sin(a) * tr[2]); }), COL.dark, PART.FIXED, V(-1, 0, 0));

  // ---- cockpit windows (dark wedge on the nose shoulders)
  const cwX0 = X(noseLen * 0.62), cwX1 = X(noseLen * 1.02);
  const radAt = (fromNose: number) => { const t = Math.min(1, fromNose / noseLen); return R * Math.sqrt(1 - (1 - t) * (1 - t)); };
  const r0 = radAt(noseLen * 0.62), r1 = radAt(noseLen * 1.02);
  for (const sgn of [1, -1]) {
    const pts = [
      V(cwX0 + 0.02, cy + r0 * 0.28, sgn * r0 * 0.93), V(cwX1, cy + r1 * 0.26, sgn * r1 * 0.95),
      V(cwX1, cy + r1 * 0.62, sgn * r1 * 0.8), V(cwX0 + 0.05, cy + r0 * 0.7, sgn * r0 * 0.66),
    ];
    for (const q of pts) { q.y += 0.02; q.z += sgn * 0.03; }
    b.poly(pts, COL.glass, PART.FIXED, V(0.4, 0.3, sgn));
  }
  b.poly([V(cwX0 + 0.05, cy + r0 * 0.7 + 0.03, -r0 * 0.6), V(cwX0 + 0.05, cy + r0 * 0.7 + 0.03, r0 * 0.6),
    V(cwX1, cy + r1 * 0.62 + 0.05, r1 * 0.7), V(cwX1, cy + r1 * 0.62 + 0.05, -r1 * 0.7)], COL.glass, PART.FIXED, V(0.5, 1, 0));

  // ---- cabin windows: dashes along both sides (not on freighters)
  if (!s.freighter) {
    const pitch = s.windowPitch ?? 0.5;
    const wy = cy + R * 0.22, wh = Math.min(0.38, R * 0.16), ww = Math.min(0.26, pitch * 0.5);
    const x0 = X(noseLen + 1.6), x1 = X(L - tailLen - 0.8);
    const zr = Math.sqrt(Math.max(0, R * R - (wy - cy) * (wy - cy))) + 0.025;
    for (let x = x1; x < x0; x += pitch) {
      for (const sgn of [1, -1]) {
        b.poly([V(x, wy - wh / 2, sgn * zr), V(x + ww, wy - wh / 2, sgn * zr), V(x + ww, wy + wh / 2, sgn * zr), V(x, wy + wh / 2, sgn * zr)],
          COL.glass, PART.FIXED, V(0, 0, sgn));
      }
    }
  }
  // cheatline / accent stripe low on the fuselage (livery accent)
  {
    const y0 = cy - R * 0.28, y1 = cy - R * 0.2;
    const zr0 = Math.sqrt(R * R - (y0 - cy) ** 2) + 0.02, zr1 = Math.sqrt(R * R - (y1 - cy) ** 2) + 0.02;
    const xa = X(L - tailLen - 0.5), xb = X(noseLen + 0.5);
    for (const sgn of [1, -1]) b.poly([V(xa, y0, sgn * zr0), V(xb, y0, sgn * zr0), V(xb, y1, sgn * zr1), V(xa, y1, sgn * zr1)], COL.white, PART.ACCENT, V(0, 0, sgn));
  }

  // ---- wings
  const half = s.span / 2;
  const sweep = (s.wing.sweep * Math.PI) / 180, dih = (s.wing.dihedral * Math.PI) / 180;
  const rootZ = R * 0.55;
  const wy = s.wing.high ? top - 0.15 : cy - R * 0.62;
  const rootLE = V(X(wingLE), wy, 0);
  const tipSpan = half - rootZ;
  const tipChord = s.wing.rootChord * s.wing.tipRatio;
  let tipX = rootLE.x - Math.tan(sweep) * tipSpan;
  const tipY = wy + Math.tan(dih) * tipSpan;
  const wingThick = s.cls === 'turboprop' ? 0.16 : 0.13;
  let wingtipLE = V(tipX, tipY, half);
  for (const sgn of [1, -1]) {
    const rl = V(rootLE.x, wy, sgn * rootZ);
    const tl = V(tipX, tipY, sgn * half);
    if (s.wing.winglet === 'raked') tl.x -= tipChord * 0.4;
    b.surface(rl, s.wing.rootChord * (s.wing.high ? 1 : 1.12), tl, tipChord, wingThick, COL.wing, PART.FIXED);
    // root fairing (belly), low wings only
    if (!s.wing.high) b.surface(V(rl.x + 0.5, wy - 0.05, sgn * 0.15), s.wing.rootChord * 1.3, rl.clone().setY(wy - 0.05), s.wing.rootChord * 1.15, 0.1, COL.white, PART.BELLY);
    // winglets
    const wl = s.wing.winglet;
    if (wl !== 'none' && wl !== 'raked') {
      const h = wl === 'curved' ? 2.6 : wl === 'split' ? 2.4 : wl === 'sharklet' ? 2.4 : 2.4 * (s.span / 35);
      const c0 = tipChord * 0.9, c1 = tipChord * 0.35;
      const base = V(tl.x - tipChord * 0.05, tl.y, sgn * (half - 0.05));
      const upTip = V(base.x - c0 * 0.9, base.y + h, sgn * (half + (wl === 'curved' ? 0.4 : 0.15)));
      b.surface(base, c0, upTip, c1, 0.08, COL.white, PART.TAIL, true);
      if (wl === 'split') b.surface(V(base.x - 0.3, base.y, sgn * (half - 0.1)), c0 * 0.8, V(base.x - c0 * 0.7, base.y - 0.9, sgn * (half + 0.3)), c1 * 0.8, 0.08, COL.white, PART.TAIL, true);
    }
    if (sgn === 1) wingtipLE = tl.clone();
  }
  tipX = wingtipLE.x;

  // ---- engines
  const e = s.engines;
  const engineNodes: THREE.Vector3[] = [];
  if (e.mount === 'wing') {
    for (const sgn of [1, -1]) {
      const ez = sgn * (rootZ + (half - rootZ) * e.spanFrac);
      const wingLEatZ = rootLE.x - Math.tan(sweep) * (Math.abs(ez) - rootZ);
      const wingYatZ = wy + Math.tan(dih) * (Math.abs(ez) - rootZ);
      let ex: number, ey: number;
      if (e.kind === 'prop') {
        ex = wingLEatZ + e.len * 0.45; ey = wingYatZ - e.d * 0.15;
      } else {
        ex = wingLEatZ + e.len * 0.75; ey = wingYatZ - e.d * 0.62;
        ey = Math.max(ey, e.d / 2 + 0.45);
      }
      engineNodes.push(V(ex, ey, ez));
      nacelle(b, ex, ey, ez, e.d, e.len, e.kind);
      // pylon
      if (e.kind === 'fan') {
        b.surface(V(ex - e.len * 0.15, ey + e.d * 0.45, ez), e.len * 0.8, V(wingLEatZ + 0.2, wingYatZ - 0.05, ez), e.len * 0.9, 0.12, COL.wing, PART.FIXED, true);
      }
      if (e.kind === 'prop') propeller(b, ex + 0.25, ey, ez, 4.1, 6);
    }
  } else {
    // aft-mounted (CRJ)
    const ex = X(L - tailLen - e.len * 0.1);
    for (const sgn of [1, -1]) {
      const ez = sgn * (R + e.d * 0.62);
      nacelle(b, ex, top - R * 0.35, ez, e.d, e.len, 'fan');
      b.surface(V(ex - e.len * 0.25, top - R * 0.35, sgn * R * 0.6), e.len * 0.55, V(ex - e.len * 0.25, top - R * 0.35, ez - sgn * e.d * 0.4), e.len * 0.5, 0.15, COL.wing, PART.FIXED);
      engineNodes.push(V(ex, top - R * 0.35, ez));
    }
  }

  // ---- tail: vertical fin + stabilisers
  const finRoot = s.length * (s.cls === 'turboprop' ? 0.16 : 0.15);
  const finH = Math.max(1.5, s.height - top - (s.tail.t ? 0.3 : 0));
  const finSweep = ((s.cls === 'turboprop' ? 30 : 40) * Math.PI) / 180;
  const finLEroot = V(X(L - finRoot - tailLen * 0.08), top - 0.2, 0);
  const finTipChord = finRoot * (s.tail.t ? 0.72 : 0.36);
  const finTipLE = V(finLEroot.x - Math.tan(finSweep) * finH, top + finH, 0);
  b.surface(finLEroot, finRoot, finTipLE, finTipChord, 0.1, COL.white, PART.TAIL, true);
  // logo patch on both fin sides (livery accent)
  {
    const cx0 = (finLEroot.x - finRoot * 0.5 + finTipLE.x - finTipChord * 0.5) / 2 + finH * 0.05 * Math.tan(finSweep);
    const cy0 = top + finH * 0.5;
    const rr = Math.min(finH, finRoot) * 0.28;
    for (const sgn of [1, -1]) {
      const z = sgn * (finRoot * 0.1 * 0.5 * 0.55 + 0.04);
      const pts = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2; return V(cx0 + Math.cos(a) * rr * 1.05, cy0 + Math.sin(a) * rr, z); });
      b.poly(pts, COL.white, PART.ACCENT, V(0, 0, sgn));
    }
  }
  const hsSpan = s.span * (s.tail.t ? 0.3 : 0.35) / 2;
  const hsRoot = finRoot * (s.tail.t ? 0.62 : 0.72);
  const hsSweep = ((s.tail.t ? 25 : 32) * Math.PI) / 180;
  for (const sgn of [1, -1]) {
    let rl: THREE.Vector3;
    if (s.tail.t) rl = V(finTipLE.x + 0.2, top + finH - 0.05, sgn * 0.2);
    else rl = V(X(L - tailLen * 0.62), cy + R * 0.12, sgn * R * 0.45);
    const tl = V(rl.x - Math.tan(hsSweep) * hsSpan, rl.y + (s.tail.t ? 0 : hsSpan * 0.08), sgn * (hsSpan + Math.abs(rl.z)));
    b.surface(rl, hsRoot, tl, hsRoot * 0.4, 0.09, COL.wing, PART.FIXED);
  }

  // ---- landing gear (part GEAR: collapsed when retracted)
  const tyreR = Math.min(0.62, Math.max(0.35, s.gearH * 0.3));
  const noseX = X(noseLen * 1.3);
  gearLeg(b, noseX, 0, 0, cy - R * 0.8, tyreR * 0.8, 1, 0.3);
  const mainZ = s.wing.high ? R * 1.9 * (e.spanFrac > 0 ? 1 : 1) : Math.max(R * 0.95, s.span * 0.1);
  const bogie = s.cls === 'wide' ? 2 : 1;
  for (const sgn of [1, -1]) {
    const mz = s.wing.high ? engineNodes.find((n) => Math.sign(n.z) === sgn)?.z ?? sgn * mainZ : sgn * mainZ;
    const legTop = s.wing.high ? (engineNodes[0]?.y ?? cy) - 0.3 : wy;
    gearLeg(b, 0, 0, mz, legTop, tyreR, bogie, 0.5);
  }

  const geometry = b.build();
  const points: AircraftPoints = {
    wingTipL: V(tipX - 0.3, (s.wing.high ? top : tipY) + 0.1, -half - 0.1),
    wingTipR: V(tipX - 0.3, (s.wing.high ? top : tipY) + 0.1, half + 0.1),
    tail: V(ringsX[0][0] - 0.1, ringsX[0][1], 0),
    beaconTop: V(X(wingLE + s.wing.rootChord * 0.4), top + 0.15, 0),
    beaconBottom: V(X(wingLE), s.gearH - 0.1, 0),
    landing: V(rootLE.x + 0.4, wy, 0),
    nose: V(X(0), cy, 0),
    noseX: X(0), tailX: ringsX[0][0],
  };
  return { spec: s, geometry, points };
}

function nacelle(b: AB, x: number, y: number, z: number, d: number, len: number, kind: 'fan' | 'prop') {
  const r = d / 2;
  const rings: [number, number, number, number][] = kind === 'fan'
    ? [[x - len, y, r * 0.55, r * 0.55], [x - len * 0.7, y, r * 0.9, r * 0.9], [x - len * 0.2, y, r * 1.0, r * 1.0], [x, y, r * 0.92, r * 0.92]]
    : [[x - len, y + r * 0.2, r * 0.35, r * 0.4], [x - len * 0.55, y + r * 0.1, r * 0.8, r * 1.05], [x - len * 0.2, y, r * 0.8, r * 0.9], [x, y, r * 0.45, r * 0.5]];
  b.loft(rings, 0, Math.PI * 2, 12, COL.white, PART.ENGINE, z);
  // intake face
  const n = 12;
  const face = Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return V(x - 0.02, y + Math.cos(a) * r * 0.85, z + Math.sin(a) * r * 0.85); });
  b.poly(face, kind === 'fan' ? COL.dark : COL.prop, PART.FIXED, V(1, 0, 0));
  if (kind === 'fan') {
    // exhaust cone
    b.loft([[x - len - 0.8, y, 0.05, 0.05], [x - len - 0.01, y, r * 0.45, r * 0.45]], 0, Math.PI * 2, 8, COL.metal, PART.FIXED, z);
  }
}

function propeller(b: AB, x: number, y: number, z: number, dia: number, blades: number) {
  const r = dia / 2;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + 0.3;
    const ca = Math.cos(a), sa = Math.sin(a);
    const w = 0.13;
    const p0 = V(x, y + ca * 0.25 - sa * w, z + sa * 0.25 + ca * w);
    const p1 = V(x, y + ca * r - sa * w * 0.6, z + sa * r + ca * w * 0.6);
    const p2 = V(x, y + ca * r + sa * w * 0.6, z + sa * r - ca * w * 0.6);
    const p3 = V(x, y + ca * 0.25 + sa * w, z + sa * 0.25 - ca * w);
    b.poly2([p0, p1, p2, p3], COL.prop, PART.FIXED, V(1, 0, 0));
  }
  b.loft([[x + 0.6, y, 0.05, 0.05], [x, y, 0.32, 0.32]].reverse() as [number, number, number, number][], 0, Math.PI * 2, 8, COL.white, PART.ENGINE, z);
}

function gearLeg(b: AB, x: number, y0: number, z: number, yTop: number, tyreR: number, axles: number, width: number) {
  const hw = 0.09;
  // strut
  const top = Math.max(yTop, tyreR * 2 + 0.2);
  const pts = (yy0: number, yy1: number) => [V(x - hw, yy0, z - hw), V(x + hw, yy0, z - hw), V(x + hw, yy1, z - hw), V(x - hw, yy1, z - hw)];
  b.poly(pts(tyreR, top), COL.gear, PART.GEAR, V(0, 0, -1));
  b.poly(pts(tyreR, top).map((p) => p.setZ(z + hw)), COL.gear, PART.GEAR, V(0, 0, 1));
  b.poly([V(x - hw, tyreR, z - hw), V(x - hw, top, z - hw), V(x - hw, top, z + hw), V(x - hw, tyreR, z + hw)], COL.gear, PART.GEAR, V(-1, 0, 0));
  b.poly([V(x + hw, tyreR, z - hw), V(x + hw, top, z - hw), V(x + hw, top, z + hw), V(x + hw, tyreR, z + hw)], COL.gear, PART.GEAR, V(1, 0, 0));
  // wheels: octagonal discs each side of the strut
  const xs = axles === 1 ? [x] : [x - tyreR * 1.1, x + tyreR * 1.1];
  for (const ax of xs) {
    for (const s of [-1, 1]) {
      const wz = z + s * (width / 2);
      const n = 8;
      const ring = (zz: number) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return V(ax + Math.cos(a) * tyreR, y0 + tyreR + Math.sin(a) * tyreR, zz); });
      const a = ring(wz - 0.18), c = ring(wz + 0.18);
      b.poly(c, COL.tyre, PART.GEAR, V(0, 0, 1));
      b.poly(a, COL.tyre, PART.GEAR, V(0, 0, -1));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const mid = V((a[i].x + a[j].x) / 2 - ax, (a[i].y + a[j].y) / 2 - y0 - tyreR, 0);
        b.poly([a[i], a[j], c[j], c[i]], COL.tyre, PART.GEAR, mid);
      }
    }
  }
}
