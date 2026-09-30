// Whole-consist transit vehicle models (far LOD / single-marker rendering).
//
// Each model is ONE merged, indexed BufferGeometry for a whole consist, built
// from the per-car low-detail geometries of consists.ts laid out straight, and
// unit-normalised (x ∈ [-.5, .5] = length, +x = front, y ∈ [0, 1] from the
// rail / road surface, z ∈ [-.5, .5] = width) so MarkerOverlay can scale it by
// `size` = [length, height, width] in metres. Attributes: position, normal
// (metre space, flat shaded), color (linear RGB), livery (0/1: region tinted by
// the instance colour), lamp, sign, glass (see consists.ts).
import * as THREE from 'three/webgpu';
import { consistFor, type ConsistSpec, type TransitMode } from './consists';
import { triangleCount } from './builder';

export { triangleCount };
export type VehicleKey = TransitMode;

export interface VehicleModel {
  name: string;
  /** cached, unit-normalised geometry (shared: do not dispose / mutate) */
  geometry(): THREE.BufferGeometry;
  /** real size [length, height, width] in metres — pass as MarkerOverlay `size` */
  size: [number, number, number];
  /** what the `livery` attribute marks (tinted by the instance colour) */
  liveryRegions?: string[];
  /** instance colour that reproduces the real livery (use when not tinting by route) */
  defaultTint: number;
}

const ATTRS = ['position', 'normal', 'color', 'livery', 'lamp', 'sign', 'glass'] as const;

/** Merge the cars of a consist (straight line, front car at +x) into one unit-box geometry. */
export function mergeConsist(c: ConsistSpec, detail: 'low' | 'high' = 'low'): THREE.BufferGeometry {
  const total = c.cars.reduce((a, s) => a + s.size[0], 0) + c.gaps.reduce((a, g) => a + g, 0);
  const H = Math.max(...c.cars.map((s) => s.size[1]));
  const W = Math.max(...c.cars.map((s) => s.size[2]));
  const out: Record<string, number[]> = Object.fromEntries(ATTRS.map((k) => [k, []]));
  const idx: number[] = [];
  let x = total / 2;
  c.cars.forEach((car, i) => {
    const g = detail === 'low' && car.lowGeometry ? car.lowGeometry() : car.geometry();
    const [L, h, w] = car.size;
    const cx = x - L / 2;
    const base = out.position.length / 3;
    const p = g.attributes.position.array as Float32Array;
    for (let k = 0; k < p.length; k += 3) {
      out.position.push((p[k] * L + cx) / total + 0, (p[k + 1] * h) / H, (p[k + 2] * w) / W);
    }
    for (const a of ATTRS) {
      if (a === 'position') continue;
      const src = g.attributes[a];
      if (src) out[a].push(...(src.array as Float32Array));
      else out[a].push(...new Array((p.length / 3) * (a === 'normal' || a === 'color' ? 3 : 1)).fill(0));
    }
    const ix = g.index!.array;
    for (let k = 0; k < ix.length; k++) idx.push(ix[k] + base);
    x -= L + (c.gaps[i] ?? 0);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.normal, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.color, 3));
  for (const a of ['livery', 'lamp', 'sign', 'glass']) g.setAttribute(a, new THREE.Float32BufferAttribute(out[a], 1));
  const nV = out.position.length / 3;
  g.setIndex(nV > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  g.userData.size = [total, H, W];
  return g;
}

function model(name: string, c: () => ConsistSpec, liveryRegions: string[], defaultTint: number): VehicleModel {
  let g: THREE.BufferGeometry | null = null;
  const geometry = () => (g ??= mergeConsist(c()));
  return {
    name, liveryRegions, defaultTint, geometry,
    get size() { return geometry().userData.size as [number, number, number]; },
  };
}

export const VEHICLE_MODELS: Record<VehicleKey, VehicleModel> = {
  subway: model('TTC Toronto Rocket (6 cars)', () => consistFor('subway', { agency: 'ttc', short: '1' }), ['line badge'], 0xf8c300),
  lrt: model('Line 5 Flexity Freedom (2 units)', () => consistFor('lrt', { agency: 'ttc', short: '5' }), ['side stripe'], 0xf58220),
  streetcar: model('TTC Flexity Outlook', () => consistFor('streetcar', { agency: 'ttc', short: '504' }), [], 0xffffff),
  commuter_rail: model('GO MP40PH-3C + 12 BiLevel', () => consistFor('commuter_rail', { agency: 'go', short: 'LW' }), [], 0xffffff),
  airport_rail: model('UP Express DMU (3 cars)', () => consistFor('airport_rail', { agency: 'up', short: 'UP' }), [], 0xffffff),
  intercity_rail: model('VIA Charger + 5 Venture', () => consistFor('intercity_rail', { agency: 'via', short: '' }), [], 0xffffff),
  bus: model('Nova LFS 40\'', () => consistFor('bus', { agency: 'ttc', short: '504' }), ['body stripe', 'roof-line stripe', 'front band'], 0xda251d),
};

/** Extra variants (not keyed by mode). */
export const EXTRA_MODELS = {
  subway2: model('TTC T1 (6 cars, Line 2)', () => consistFor('subway', { agency: 'ttc', short: '2' }), ['line badge'], 0x00923f),
  subway4: model('TTC Toronto Rocket (4 cars, Line 4)', () => consistFor('subway', { agency: 'ttc', short: '4' }), ['line badge'], 0xa21a68),
  lrt6: model('Line 6 Citadis Spirit', () => consistFor('lrt', { agency: 'ttc', short: '6' }), ['side stripe'], 0x969696),
  goShort: model('GO MP40PH-3C + 10 BiLevel', () => consistFor('commuter_rail', { agency: 'go', short: 'RH' }), [], 0xffffff),
  busArtic: model('Nova LFS Artic 18 m', () => consistFor('bus', { agency: 'ttc', short: '29' }), ['body stripe', 'roof-line stripe', 'front band'], 0xda251d),
};
