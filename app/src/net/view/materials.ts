import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, texture, positionWorld, mix, fract, abs, smoothstep, max, sin, floor, uv, normalWorld, attribute } from 'three/tsl';
import type { Mat } from '../core/assets';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const loader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();
function tex(name: string, srgb = true) {
  let t = texCache.get(name);
  if (t) return t;
  t = loader.load(`${import.meta.env.BASE_URL}textures/${name}`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texCache.set(name, t);
  return t;
}

const hash = (p: N): N => fract(sin(p.dot(vec2(127.1, 311.7))).mul(43758.5453));
const vnoise = (p: N): N => {
  const i: N = floor(p), f: N = fract(p);
  const a = hash(i), b = hash(i.add(vec2(1, 0))), c = hash(i.add(vec2(0, 1))), d = hash(i.add(vec2(1, 1)));
  const u: N = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
};

interface Spec { color: number; tex?: string; scale?: number; rough?: number; metal?: number; detail?: number; joints?: 'sidewalk' | 'slab' | 'deck'; offset?: number }

const SPECS: Record<Mat, Spec> = {
  asphalt: { color: 0x5e5e5b, tex: 'asphalt_color.webp', scale: 0.25, rough: 0.92, detail: 0.25 },
  asphalt_dark: { color: 0x4c4c4a, tex: 'asphalt_color.webp', scale: 0.25, rough: 0.92, detail: 0.25 },
  concrete: { color: 0xb3afa6, tex: 'concrete_color.webp', scale: 0.3, rough: 0.85, joints: 'sidewalk' },
  pavers: { color: 0x8a5a44, tex: 'pavers_color.webp', scale: 0.5, rough: 0.85 },
  grass: { color: 0x6f8f4a, tex: 'grass_color.webp', scale: 0.2, rough: 1, detail: 0.35 },
  terrain: { color: 0x768f50, tex: 'grass_color.webp', scale: 0.12, rough: 1, detail: 0.45 },
  curb: { color: 0xa9a59c, rough: 0.8 },
  row_slab: { color: 0xa7a398, tex: 'concrete_color.webp', scale: 0.25, rough: 0.85, joints: 'slab' },
  ballast: { color: 0x7c766d, rough: 1, detail: 0.6 },
  platform: { color: 0xbab6ad, tex: 'concrete_color.webp', scale: 0.25, rough: 0.8, joints: 'slab' },
  gravel: { color: 0x8c8678, rough: 1, detail: 0.5 },
  barrier: { color: 0xb8b4ab, rough: 0.8 },
  bike: { color: 0x2f7d4f, rough: 0.9 },
  paint_white: { color: 0xe8e8e2, rough: 0.7, offset: -2 },
  paint_yellow: { color: 0xe0b020, rough: 0.7, offset: -2 },
  paint_red: { color: 0xb03028, rough: 0.7, offset: -2 },
  tactile: { color: 0xd9a514, rough: 0.7, offset: -1 },
  rail: { color: 0x7c7a78, rough: 0.35, metal: 0.8 },
  tie: { color: 0x9a968d, rough: 0.9 },
  tie_wood: { color: 0x4b3a2c, rough: 0.95 },
  deck: { color: 0x9d998f, tex: 'concrete_color.webp', scale: 0.15, rough: 0.9 },
  pier: { color: 0x9a968c, tex: 'concrete_color.webp', scale: 0.15, rough: 0.9 },
  wall: { color: 0x9b968a, tex: 'concrete_color.webp', scale: 0.15, rough: 0.9 },
  tunnel: { color: 0x6e6b66, rough: 0.9 },
  crossing_panel: { color: 0x55534f, rough: 0.85, offset: -1 },
  dirt: { color: 0x6b5a45, rough: 1, detail: 0.4 },
  steel: { color: 0x6a6c70, rough: 0.5, metal: 0.6 },
};

const cache = new Map<Mat, THREE.MeshStandardNodeMaterial>();

export function material(m: Mat): THREE.MeshStandardNodeMaterial {
  let mat = cache.get(m);
  if (mat) return mat;
  const s = SPECS[m];
  mat = new THREE.MeshStandardNodeMaterial({ roughness: s.rough ?? 0.9, metalness: s.metal ?? 0 });
  const base = new THREE.Color(s.color);
  const wp = positionWorld.xz;
  mat.colorNode = Fn(() => {
    let c: N = vec3(base.r, base.g, base.b);
    if (s.tex) {
      const t = texture(tex(s.tex), wp.mul(s.scale ?? 0.25)).rgb;
      const lum = t.dot(vec3(0.299, 0.587, 0.114));
      c = c.mul(mix(float(1), lum.mul(2.2), 0.55));
    }
    if (s.detail) {
      const n1 = vnoise(wp.mul(0.35)), n2 = vnoise(wp.mul(2.3));
      c = c.mul(mix(float(1), n1.mul(0.6).add(n2.mul(0.4)).mul(0.6).add(0.7), s.detail));
    }
    if (s.joints === 'sidewalk') {
      const q = uv();
      const along = abs(fract(q.x.div(1.5)).sub(0.5)).mul(1.5);
      const j = smoothstep(0.012, 0.03, along);
      c = c.mul(mix(float(0.72), float(1), max(j, float(0))));
    } else if (s.joints === 'slab') {
      const q = uv();
      const along = abs(fract(q.x.div(4.5)).sub(0.5)).mul(4.5);
      c = c.mul(mix(float(0.75), float(1), smoothstep(0.01, 0.03, along)));
    }
    if (m === 'terrain' || m === 'grass') {
      const slope = float(1).sub(normalWorld.y);
      c = mix(c, vec3(0.42, 0.36, 0.27), smoothstep(0.25, 0.6, slope).mul(0.6));
    }
    return c;
  })();
  cache.set(m, mat);
  return mat;
}

let tvc: THREE.MeshStandardNodeMaterial | null = null;
export function terrainVC(): THREE.MeshStandardNodeMaterial {
  if (tvc) return tvc;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  const wp = positionWorld.xz;
  m.colorNode = Fn(() => {
    const base: N = attribute('color', 'vec3');
    const t = texture(tex('grass_color.webp'), wp.mul(0.12)).rgb;
    const lum = t.dot(vec3(0.299, 0.587, 0.114));
    const n1 = vnoise(wp.mul(0.35)), n2 = vnoise(wp.mul(2.3));
    let c: N = base.mul(mix(float(1), lum.mul(2.2), 0.35));
    c = c.mul(mix(float(1), n1.mul(0.6).add(n2.mul(0.4)).mul(0.6).add(0.7), 0.3));
    const slope = float(1).sub(normalWorld.y);
    return mix(c, vec3(0.42, 0.36, 0.27), smoothstep(0.3, 0.65, slope).mul(0.6));
  })();
  tvc = m;
  return m;
}

export function flat(color: number, rough = 0.8, metal = 0, emissive?: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal });
  if (emissive !== undefined) m.emissive = new THREE.Color(emissive);
  return m;
}
