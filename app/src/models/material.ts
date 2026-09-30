// Shared TSL shading for instanced vehicles / pedestrians built by app/src/models
// and app/src/layers/traffic/models.ts. Reads the per-vertex tags written by
// MeshBuilder (color, livery|tint, lamp, sign, glass) and turns them into
//   • body colour  = vertex colour × (instance tint where livery = 1)
//   • glass        = low roughness + fresnel sky reflection (reads as glazing
//                    without an env map)
//   • lamps        = emissive: headlights (DRL by day, bright at night / when
//                    flagged), tail lights (night + brake), indicators (blink)
//   • signs        = emissive amber destination signs
//
// Two entry points:
//   vehicleMaterial(opts)  lit MeshStandardNodeMaterial (scene sun + hemi light,
//                          shadows) — for InstancedMesh pools (TrafficLayer).
//   vehicleShade(nWorld, opts)  colour node with built-in sun/hemisphere
//                          lighting for unlit MeshBasicNodeMaterial overlays
//                          whose positionNode does its own instancing
//                          (MarkerOverlay); pass the heading-rotated normal.
import * as THREE from 'three/webgpu';
import {
  attribute, clamp, dot, float, floor, fract, max, mix, mod, normalView, positionViewDirection, pow, step, vec3, vec4,
} from 'three/tsl';
import { U } from '../render/uniforms';

type N = ReturnType<typeof float>;
type N3 = ReturnType<typeof vec3>;

export interface VehicleShadingOpts {
  /** instance tint (vec3); default attribute('iCol') */
  tint?: N3 | ReturnType<typeof attribute>;
  /** per-vertex livery weight attribute name: 'livery' (models/) or 'tint' (traffic models) */
  liveryAttr?: 'livery' | 'tint';
  /** instance flag bitfield (float): 1 brake, 4 indicator-left, 8 indicator-right, 16 headlights on */
  flags?: N | ReturnType<typeof attribute>;
  /** geometry has lamp / sign / glass attributes (default true) */
  tagged?: boolean;
}

const bit = (flags: N, v: number) => step(0.5, mod(floor(flags.div(v)), 2));

/** Albedo, emissive, glass mask nodes shared by both paths. */
export function vehicleSurface(o: VehicleShadingOpts = {}) {
  const vc = attribute('color', 'vec3');
  const liv = attribute(o.liveryAttr ?? 'livery', 'float');
  const tint = (o.tint ?? attribute('iCol', 'vec3')) as N3;
  const albedo = vc.mul(mix(vec3(1, 1, 1), tint, liv));
  if (o.tagged === false) return { albedo, emissive: vec3(0, 0, 0), glass: float(0) };
  const lamp = attribute('lamp', 'float');
  const sign = attribute('sign', 'float');
  const glass = attribute('glass', 'float');
  const flags = (o.flags ?? float(0)) as N;
  const is = (k: number) => step(k - 0.5, lamp).mul(step(lamp, k + 0.5));
  const night = U.night;
  const brake = bit(flags, 1), left = bit(flags, 4), right = bit(flags, 8), headOn = bit(flags, 16);
  const blink = step(0.5, fract(U.time.mul(1.5)));
  const head = is(1).mul(float(0.25).add(night.mul(2.8)).add(headOn.mul(1.5)));
  const tail = is(2).mul(night.mul(1.1).add(brake.mul(2.4)));
  const ind = is(3).mul(left).add(is(4).mul(right)).mul(blink).mul(2.5);
  // flag 32: powered down (a train stabled in a depot) — no lamps, no signs
  const on = float(1).sub(bit(flags, 32));
  const emissive = vec3(1.0, 0.93, 0.78).mul(head)
    .add(vec3(1.0, 0.06, 0.03).mul(tail))
    .add(vec3(1.0, 0.5, 0.05).mul(ind))
    .add(vec3(1.0, 0.62, 0.12).mul(sign.mul(float(0.3).add(night.mul(1.4)))))
    .mul(on);
  return { albedo, emissive, glass };
}

/** Fresnel sky reflection on glazing (view space). */
function glassReflect(glass: N): N3 {
  const f = pow(float(1).sub(clamp(dot(normalView, positionViewDirection), 0, 1)), 3);
  const sky = mix(U.skyHorizon, U.skyZenith, 0.35);
  return sky.mul(glass).mul(f.mul(0.32).add(0.03)).mul(float(1).sub(U.night.mul(0.85))) as N3;
}

/** Lit material for InstancedMesh vehicle pools. */
export function vehicleMaterial(o: VehicleShadingOpts & { name?: string } = {}): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.05 });
  m.name = o.name ?? 'vehicles';
  const s = vehicleSurface(o);
  m.colorNode = s.albedo;
  m.roughnessNode = mix(float(0.5), float(0.08), s.glass);
  m.metalnessNode = mix(float(0.12), float(0.0), s.glass);
  m.emissiveNode = s.emissive.add(glassReflect(s.glass as unknown as N));
  return m;
}

/**
 * Colour node with built-in lighting for unlit (MeshBasicNodeMaterial)
 * overlays. `nWorld` = world-space normal (rotate the geometry normal by the
 * instance heading yourself).
 */
export function vehicleShade(nWorld: N3, o: VehicleShadingOpts = {}) {
  const s = vehicleSurface(o);
  const n = nWorld;
  const day = float(1).sub(U.night);
  const sun = max(dot(n, U.sunDir), 0).mul(day).mul(1.05);
  const hemi = mix(vec3(0.42, 0.4, 0.36), vec3(0.62, 0.68, 0.76), n.y.mul(0.5).add(0.5)).mul(day.mul(0.8).add(0.2));
  const light = hemi.add(U.sunColor.mul(sun));
  const spec = pow(max(dot(n, U.sunDir), 0), 24).mul(s.glass).mul(day).mul(0.6);
  const skyRefl = mix(U.skyHorizon, U.skyZenith, max(n.y, 0)).mul(s.glass).mul(0.35).mul(day.mul(0.85).add(0.15));
  const c = s.albedo.mul(light).add(skyRefl).add(vec3(spec, spec, spec)).add(s.emissive);
  return vec4(c, 1);
}
