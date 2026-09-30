// TSL node materials for the tiled base map.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, texture, uniform, positionLocal, positionGeometry, normalLocal,
  modelWorldMatrix, cameraPosition, transformNormalToView, mix, smoothstep, sin, step, length,
  normalize, clamp, floor, fract, pow, luminance, vertexColor, positionWorld,
} from 'three/tsl';
import { U } from '../uniforms';
import { waterSurface } from './groundMaterial';

// ---------------------------------------------------------------------------- palette

/** Land-cover class → colour (SPEC ground classes). Cartographic, slightly desaturated. */
export const GROUND_PALETTE: Record<number, number> = {
  0: 0x9ea477, // land: rough grass / meadow (as the vector ground)
  1: 0x86a9c4, // water
  2: 0x7f9c58, // grass / park
  3: 0x5b6a3e, // forest
  4: 0x839c5e, // residential: lawns (roofs come from class 22 / houses)
  5: 0x8b8984, // commercial paving
  6: 0x87837a, // industrial yard
  7: 0xa19d66, // farmland
  8: 0xd8c9a0, // sand / beach
  9: 0x6f6e6b, // road (asphalt: matches the textured road ribbons)
  10: 0x857d72, // rail lands
  11: 0x5d5c59, // parking
  12: 0x7a9860, // cemetery
  13: 0x71a04f, // golf
  14: 0xdad6d0, // aeroway
  15: 0x666562, // major road
  16: 0x69774f, // wetland
  17: 0x839f5c, // institutional grounds
  18: 0x9a8a6d, // construction
  19: 0x5c9644, // sports pitch
  20: 0x8a8985, // runway / taxiway
  21: 0xb2ada3, // platform / plaza
  22: 0xcbc6be, // building footprint (L1/L2 far-view raster)
  23: 0x8fad68, // airfield grass (mown; paving is the airport layer)
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

let _grass: THREE.Texture | null = null, _conc: THREE.Texture | null = null;
function detailTex(name: string) {
  const t = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}textures/${name}`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const grassTex = () => (_grass ??= detailTex('grass_color.webp'));
const concreteTex = () => (_conc ??= detailTex('concrete_color.webp'));

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

// Layers per page (DataArrayTexture; 256 is WebGPU's guaranteed minimum).
// Every page has its own material, so fewer, larger pages mean fewer shader builds.
export const GROUND_LAYERS = 256;

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
  const water = waterSurface(positionLocal.x, positionLocal.z.negate(), dist, viewDir, float(0), float(32), float(0), float(0.5));
  const lake = wet.greaterThan(0.99).select(float(1), float(0)); // wetland (alpha 60) keeps land shading
  const col = mix(c2, water.wcol.mul(float(1).sub(water.fres)), lake);

  // close-range micro texture: grass blades on green classes, concrete grain elsewhere
  // (luminance-only modulation, keeps the land-cover hue; world-space, 4 m / 2.5 m periods divide the tile size)
  const gp = vec2(positionLocal.x, positionLocal.z.negate());
  const closeK = smoothstep(450, 40, dist).mul(float(1).sub(wet));
  const greenK = smoothstep(0.01, 0.05, sampled.g.sub(sampled.r.add(sampled.b).mul(0.5)));
  const grassL = luminance(texture(grassTex(), gp.div(4)).rgb).div(0.12);
  const concL = luminance(texture(concreteTex(), gp.div(2.5)).rgb).div(0.46);
  const detail = mix(concL.mul(0.35).add(0.65), grassL.mul(0.6).add(0.4), greenK);
  const colD = col.mul(mix(float(1), clamp(detail, 0.4, 1.6), closeK));
  m.colorNode = baseTone(colD);

  (m as unknown as { emissiveNode: N }).emissiveNode = water.sky.mul(water.fres).mul(lake).mul(float(1).sub(U.analytics.mul(0.8))).mul(0.7);
  m.normalNode = transformNormalToView(normalize(mix(normalLocal, water.wN, lake)));
  m.roughnessNode = mix(float(0.97), float(0.07), lake);
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
