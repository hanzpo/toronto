// Global TSL uniforms shared by all base-map materials. Updated once per frame by the engine.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

export const U = {
  /** 0 = normal map, 1 = analytics (desaturated / darkened base map) */
  analytics: uniform(0),
  /** 0 = day, 1 = night — hook for emissive window lights */
  night: uniform(0),
  sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  fogColor: uniform(new THREE.Color(0xc9d6e2)),
  /** 1 / fog e-folding distance (m) */
  fogDensity: uniform(1 / 20000),
  fogMax: uniform(0.85),
  skyZenith: uniform(new THREE.Color(0x6f9fd8)),
  skyHorizon: uniform(new THREE.Color(0xd6e2ec)),
  sunColor: uniform(new THREE.Color(0xfff1d6)),
  /** seconds; drives water animation */
  time: uniform(0),
};
