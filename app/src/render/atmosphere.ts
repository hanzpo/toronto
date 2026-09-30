// Sky gradient, distance haze, sun/hemisphere lighting, day/night and a
// camera-following directional shadow map.
import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, positionWorldDirection, positionView, mix, max, pow, dot, smoothstep, exp, length, output,
} from 'three/tsl';
import { U } from './uniforms';
import type { FrameContext } from '../engine/types';

const DAY_ZENITH = new THREE.Color(0x5d8fcf);
const DAY_HORIZON = new THREE.Color(0xd3dfe8);
const SUNSET_HORIZON = new THREE.Color(0xe8b48a);
const SUNSET_ZENITH = new THREE.Color(0x4a6a9e);
const NIGHT_ZENITH = new THREE.Color(0x070b18);
const NIGHT_HORIZON = new THREE.Color(0x1a2233);
const ANALYTIC_ZENITH = new THREE.Color(0x0d1117);
const ANALYTIC_HORIZON = new THREE.Color(0x1b222c);

export class Atmosphere {
  sun = new THREE.DirectionalLight(0xffffff, 2.2);
  hemi = new THREE.HemisphereLight(0xdfe9f5, 0x8a8472, 1.1);
  water: THREE.Mesh;
  shadowsEnabled = true;
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();

  constructor(scene: THREE.Scene, shadowMapSize = 2048) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.near = 1; sc.far = 6000;
    scene.add(this.sun, this.sun.target, this.hemi);

    // sky: gradient on view elevation + sun glow
    scene.backgroundNode = Fn(() => {
      const d = positionWorldDirection;
      const up = max(d.y, 0);
      const base = mix(U.skyHorizon, U.skyZenith, pow(up, 0.45));
      const below = mix(U.skyHorizon, U.fogColor, smoothstep(0, -0.15, d.y));
      const sky = d.y.greaterThan(0).select(base, below);
      const s = max(dot(d, U.sunDir), 0);
      const glow = U.sunColor.mul(pow(s, 900).mul(4).add(pow(s, 12).mul(0.22))).mul(float(1).sub(U.analytics));
      return vec4(sky.add(glow), 1);
    })();

    // haze: exponential in true distance, capped; colour = horizon
    scene.fogNode = Fn(() => {
      const d = length(positionView);
      const f = float(1).sub(exp(d.mul(U.fogDensity).negate())).mul(U.fogMax);
      return vec4(mix(output.rgb, U.fogColor, f), output.a);
    })();

    // Water plane beyond the tile pyramid. It sits far below every terrain
    // surface (lake-class terrain is at -1.5 m, DSM quays dip to ~-7 m) so it is
    // never coplanar with tile water/shoreline: it only shows where no tile
    // exists (outside the bbox, or briefly through a loading hole).
    const wm = new THREE.MeshStandardNodeMaterial({ roughness: 0.25, metalness: 0 });
    wm.colorNode = Fn(() => {
      const c = vec3(0.33, 0.5, 0.64);
      const lum = dot(c, vec3(0.3, 0.59, 0.11));
      return mix(c, vec3(lum).mul(0.32).add(0.03), U.analytics.mul(0.92));
    })();
    wm.name = 'lake';
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), wm);
    this.water.position.y = -60;
    this.water.scale.set(600000, 1, 600000);
    this.water.receiveShadow = false;
    this.water.renderOrder = -1;
    this.water.name = 'lakePlane';
    scene.add(this.water);
  }

  update(ctx: FrameContext, sunDir: THREE.Vector3) {
    const elev = sunDir.y;
    // 1 day, 0 night; twilight ~ -6°..+8°
    const day = THREE.MathUtils.smoothstep(elev, -0.1, 0.14);
    const golden = 1 - THREE.MathUtils.smoothstep(elev, 0.02, 0.35);
    ctx.daylight = day;
    U.night.value = 1 - day;
    U.sunDir.value.copy(sunDir);
    U.time.value = ctx.time;
    U.analytics.value += ((ctx.analyticsMode ? 1 : 0) - U.analytics.value) * Math.min(1, ctx.dt * 6);
    const a = U.analytics.value;

    // sky colours
    const zen = this.tmpC.copy(NIGHT_ZENITH).lerp(this.tmpC2.copy(SUNSET_ZENITH).lerp(DAY_ZENITH, 1 - golden), day);
    U.skyZenith.value.copy(zen).lerp(ANALYTIC_ZENITH, a);
    const hor = this.tmpC.copy(NIGHT_HORIZON).lerp(this.tmpC2.copy(SUNSET_HORIZON).lerp(DAY_HORIZON, 1 - golden * 0.8), day);
    U.skyHorizon.value.copy(hor).lerp(ANALYTIC_HORIZON, a);
    U.fogColor.value.copy(U.skyHorizon.value);
    U.sunColor.value.setRGB(1, 0.93 - golden * 0.25, 0.84 - golden * 0.45);

    // haze distance scales with altitude so the whole region stays legible from above
    const alt = Math.max(ctx.altitude, 2);
    const L = 22000 + alt * 3.5;
    U.fogDensity.value = 1 / L;
    U.fogMax.value = 0.8 - 0.25 * THREE.MathUtils.smoothstep(alt, 5000, 80000);

    // lights
    this.sun.color.copy(U.sunColor.value);
    // strong key light, modest sky fill: sunlit vs shaded faces and shadows read clearly
    this.sun.intensity = 3.1 * day * (1 - a * 0.5);
    this.hemi.intensity = 0.3 + 0.55 * day;
    this.hemi.color.setRGB(0.85 + 0.1 * day, 0.9 + 0.05 * day, 1.0);
    this.hemi.groundColor.setRGB(0.5 * day + 0.08, 0.48 * day + 0.08, 0.42 * day + 0.1);
    if (day < 0.05) { this.hemi.color.setRGB(0.45, 0.52, 0.75); this.hemi.intensity = 0.45; }

    // Shadow frustum around the focus point. castShadow is never toggled:
    // flipping it rebuilds every lit material's shader (a multi-100 ms stall
    // when zooming across the cutoff). Instead the shadow fades out by
    // altitude / sun elevation and the shadow pass stops rendering when unseen.
    const focus = ctx.focus;
    const fade = this.shadowsEnabled
      ? (1 - THREE.MathUtils.smoothstep(ctx.altitude, 1800, 2800)) * THREE.MathUtils.smoothstep(elev, 0.02, 0.08)
      : 0;
    this.sun.shadow.intensity = fade;
    this.sun.shadow.autoUpdate = fade > 0.001;
    // frustum radius in discrete steps: continuous resizing makes shadows shimmer
    const want = THREE.MathUtils.clamp(ctx.altitude * 1.2 + 150, 200, 1800);
    const r = Math.min(1800, 200 * Math.pow(1.25, Math.ceil(Math.log(want / 200) / Math.log(1.25))));
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    if (sc.right !== r) {
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
      sc.updateProjectionMatrix();
    }
    // snap the focus to shadow texels to avoid shimmering
    const texel = (2 * r) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + sunDir.x * 3000, focus.y + Math.max(sunDir.y, 0.05) * 3000, fz + sunDir.z * 3000);
    this.sun.target.updateMatrixWorld();
  }
}
