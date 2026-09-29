// TSL node materials for the tiled base map.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, texture, uniform, positionLocal, positionGeometry, normalLocal,
  modelWorldMatrix, cameraPosition, transformNormalToView, mix, smoothstep, sin, step, cos, length,
  normalize, max, clamp, floor, fract, pow, luminance, vertexColor, positionWorld,
} from 'three/tsl';
import { U } from '../uniforms';

// ---------------------------------------------------------------------------- palette

/** Land-cover class → colour (SPEC ground classes). Cartographic, slightly desaturated. */
export const GROUND_PALETTE: Record<number, number> = {
  0: 0xdcd8c8, // land
  1: 0x86a9c4, // water
  2: 0xb5cf9a, // grass / park
  3: 0x93b384, // forest
  4: 0xe3ddcf, // residential
  5: 0xe0d5c8, // commercial
  6: 0xd6d1cb, // industrial
  7: 0xe4dfb8, // farmland
  8: 0xeadfbd, // sand / beach
  9: 0xbdb8b0, // road
  10: 0xc6bdb2, // rail
  11: 0xcfcbc4, // parking
  12: 0xc3d2b2, // cemetery
  13: 0xbcd7a0, // golf
  14: 0xdad6d0, // aeroway
  15: 0xc9bca5, // major road
  16: 0xa9c2a8, // wetland
  17: 0xe2d7c9, // institutional
  18: 0xd9cfbd, // construction
  19: 0xa9cf93, // sports pitch
  20: 0xbab7b2, // runway / taxiway
  21: 0xd8d2c8, // platform / plaza
  22: 0xcbc6be, // building footprint (L1/L2 far-view raster)
  255: 0xd4d3c8, // outside region
};

function paletteTexture(): THREE.DataTexture {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = GROUND_PALETTE[i] ?? GROUND_PALETTE[0];
    data[i * 4] = (c >> 16) & 255;
    data[i * 4 + 1] = (c >> 8) & 255;
    data[i * 4 + 2] = c & 255;
    data[i * 4 + 3] = i === 1 ? 255 : i === 16 ? 60 : 0; // alpha = "wetness" (water gloss)
  }
  const t = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

let _palette: THREE.DataTexture | null = null;
export const palette = () => (_palette ??= paletteTexture());

/** analytics-mode + base toning shared by all base materials */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export const baseTone = Fn(([c]: [N]) => {
  const col = vec3(c);
  const lum = luminance(col);
  const dark = mix(col, vec3(lum).mul(0.32).add(0.03), 0.92);
  return mix(col, dark, U.analytics);
});

// ---------------------------------------------------------------------------- terrain

export const GROUND_LAYERS = 64; // layers per page (DataArrayTexture)

export class GroundPage {
  tex: THREE.DataArrayTexture;
  free: number[] = [];
  material: THREE.MeshStandardNodeMaterial;
  constructor() {
    const data = new Uint8Array(256 * 256 * GROUND_LAYERS);
    this.tex = new THREE.DataArrayTexture(data, 256, 256, GROUND_LAYERS);
    this.tex.format = THREE.RedFormat;
    this.tex.type = THREE.UnsignedByteType;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    for (let i = GROUND_LAYERS - 1; i >= 0; i--) this.free.push(i);
    this.material = terrainMaterial(this.tex);
  }
  alloc(ground: Uint8Array): number {
    const l = this.free.pop()!;
    (this.tex.image.data as Uint8Array).set(ground, l * 65536);
    this.tex.addLayerUpdate(l);
    this.tex.needsUpdate = true;
    return l;
  }
  release(l: number) {
    this.free.push(l);
  }
}

function terrainMaterial(groundTex: THREE.DataArrayTexture): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'terrain';
  const layer = uniform(0).onObjectUpdate(({ object }) => (object?.userData.groundLayer as number) ?? 0);
  const tileSize = uniform(1024).onObjectUpdate(({ object }) => (object?.userData.tileSize as number) ?? 1024);
  const pal = palette();

  const classAt = (i: N, j: N) => {
    const uv = vec2(clamp(i, 0, 255).add(0.5).div(256), clamp(j, 0, 255).add(0.5).div(256));
    const v = texture(groundTex, uv).depth(layer).r;
    return texture(pal, vec2(v.mul(255).add(0.5).div(256), 0.5));
  };

  // local uv in [0,1] across the tile, v = north
  const u = positionLocal.x.div(tileSize);
  const vN = positionLocal.z.negate().div(tileSize);
  const px = u.mul(256).sub(0.5), py = vN.mul(256).sub(0.5);
  const i0 = floor(px), j0 = floor(py);
  const fx = fract(px), fy = fract(py);

  const sampled = Fn(() => {
    const c00 = classAt(i0, j0), c10 = classAt(i0.add(1), j0);
    const c01 = classAt(i0, j0.add(1)), c11 = classAt(i0.add(1), j0.add(1));
    // sharpen the bilinear blend so class edges stay crisp but anti-aliased
    const sx = smoothstep(0.25, 0.75, fx), sy = smoothstep(0.25, 0.75, fy);
    return mix(mix(c00, c10, sx), mix(c01, c11, sx), sy);
  })();

  const h = positionLocal.y;
  const wet = sampled.a;
  const ny = normalLocal.y;
  // slope tint (rock/earth on steep ground) + gentle elevation lightening
  const c1 = mix(vec3(sampled.rgb), vec3(0.62, 0.58, 0.52), smoothstep(0.9, 0.62, ny).mul(float(1).sub(wet)));
  const c2 = c1.mul(float(1).add(clamp(h, -50, 400).mul(0.00035)));

  // water: fresnel sky tint + animated normal
  const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const toCam = cameraPosition.sub(wp);
  const dist = length(toCam);
  const viewDir = toCam.div(dist);
  const fres = pow(float(1).sub(max(viewDir.y, 0)), 4);
  const waterCol = mix(vec3(0.33, 0.5, 0.64), U.skyHorizon, fres.mul(0.55));
  const col = mix(c2, waterCol, wet);

  m.colorNode = baseTone(col);

  // tile-periodic waves (all wavelengths divide 1024 m, so patterns are seamless across tiles)
  const TAU = Math.PI * 2;
  const x = positionLocal.x, z = positionLocal.z, t = U.time;
  const k1 = TAU / (1024 / 48), k2 = TAU / (1024 / 80), k3 = TAU / (1024 / 128);
  const dx = cos(x.mul(k1).add(z.mul(k1 * 0.5)).add(t.mul(0.9))).mul(k1)
    .add(cos(x.mul(k2 * 0.3).sub(z.mul(k2)).add(t.mul(1.3))).mul(k2 * 0.3))
    .add(cos(x.mul(k3).add(z.mul(k3)).sub(t.mul(1.7))).mul(k3));
  const dz = cos(x.mul(k1).add(z.mul(k1 * 0.5)).add(t.mul(0.9))).mul(k1 * 0.5)
    .sub(cos(x.mul(k2 * 0.3).sub(z.mul(k2)).add(t.mul(1.3))).mul(k2))
    .add(cos(x.mul(k3).add(z.mul(k3)).sub(t.mul(1.7))).mul(k3));
  const amp = float(0.035).mul(float(1).sub(smoothstep(200, 2500, dist))).mul(wet);
  const wn = normalize(vec3(dx.mul(amp).negate(), 1, dz.mul(amp).negate()));
  const baseN = normalize(mix(normalLocal, wn, wet));
  m.normalNode = transformNormalToView(baseN);
  m.roughnessNode = mix(float(0.97), float(0.16), wet);
  m.metalness = 0;
  void sin;
  return m;
}

// ---------------------------------------------------------------------------- buildings / roads

/** Lambert with vertex colours (+ optional instance colour), analytics toning. */
export function vertexColorMaterial(name: string, opts: { pull?: number; pullConst?: number; emissiveWindows?: boolean } = {}) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = name;
  // vertex colours are sRGB bytes; convert to linear here (vertexColors stays false
  // so NodeMaterial does not multiply them in a second time)
  const vc = vertexColor();
  let base = pow(vec3(vc.r, vc.g, vc.b), vec3(2.2));
  if (opts.emissiveWindows) {
    // subtle storey banding on walls so facades read at street level
    const wall = float(1).sub(normalLocal.y.abs());
    const band = smoothstep(0.55, 0.62, fract(positionWorld.y.div(3.5))).mul(smoothstep(0.98, 0.9, fract(positionWorld.y.div(3.5))));
    base = base.mul(float(1).sub(band.mul(wall).mul(0.13)));
  }
  m.colorNode = baseTone(base);
  if (opts.pull) {
    // depth bias: pull vertices toward the camera proportionally to distance
    // (keeps screen position, wins the depth test against terrain)
    const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
    const toCam = cameraPosition.sub(wp);
    const d = length(toCam);
    m.positionNode = positionGeometry.add(toCam.div(d).mul(min2(d.mul(opts.pull).add(opts.pullConst ?? 0.2), d.mul(0.5))));
  }
  if (opts.emissiveWindows) {
    // night hook: sparse lit windows (hashed per storey × 4 m column), warm/cool mix
    const wallMask = smoothstep(0.3, 0.1, normalLocal.y.abs());
    const fy = positionWorld.y.div(3.5);
    const fu = positionWorld.x.sub(positionWorld.z).div(4.0);
    const cell = vec2(floor(fy), floor(fu));
    const rnd = fract(sin(cell.x.mul(12.9898).add(cell.y.mul(78.233))).mul(43758.5453));
    const lit = smoothstep(0.62, 0.66, rnd);
    const shape = smoothstep(0.3, 0.38, fract(fy)).mul(smoothstep(0.82, 0.74, fract(fy)))
      .mul(smoothstep(0.15, 0.25, fract(fu))).mul(smoothstep(0.85, 0.75, fract(fu)));
    const tint = mix(vec3(1.0, 0.72, 0.4), vec3(0.75, 0.85, 1.0), step(0.9, rnd));
    (m as unknown as { emissiveNode: N }).emissiveNode = tint.mul(U.night.mul(wallMask).mul(lit).mul(shape).mul(0.9)).mul(float(1).sub(U.analytics.mul(0.7)));
  }
  return m;
}

function min2(a: N, b: N) {
  return a.min(b);
}
