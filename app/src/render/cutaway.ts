// See-through cutaway: buildings between the camera and what it looks at are
// dithered away in a cone around the line of sight, starting at the camera
// (the city-builder / GTA answer to occlusion — the camera itself never has
// to move for a building in the way). Set once per frame by whichever camera
// rig is active (CameraController.apply, InteractLayer.setCam).
import * as THREE from 'three/webgpu';
import { float, fract, dot, positionWorld, screenCoordinate, sin, smoothstep, uniform, vec2, length, max } from 'three/tsl';

const U = {
  cam: uniform(new THREE.Vector3()),
  focus: uniform(new THREE.Vector3()),
  /** 0 off, 1 on */
  on: uniform(0),
  /** cone radius at the camera (m) and growth per metre along the line of sight */
  r0: uniform(4),
  k: uniform(0.2),
  /** nothing within this distance (m) of the focus is cut */
  keep: uniform(10),
};

/**
 * Enable the cutaway for a camera at `cam` (three coords) looking at `focus`
 * (three coords), or disable it (null).
 */
export function setCutaway(cam: THREE.Vector3 | null, focus?: THREE.Vector3, opts: { r0?: number; k?: number; keep?: number } = {}) {
  if (!cam || !focus) { U.on.value = 0; return; }
  U.on.value = 1;
  U.cam.value.copy(cam);
  U.focus.value.copy(focus);
  U.r0.value = opts.r0 ?? 4;
  U.k.value = opts.k ?? 0.2;
  U.keep.value = opts.keep ?? 10;
}

/** Make a material cut away (alpha-tested dither) inside the camera's line-of-sight cone. */
export function applyCutaway(m: THREE.NodeMaterial) {
  const v = U.focus.sub(U.cam);
  const L = max(length(v), float(0.001));
  const dir = v.div(L);
  const rel = positionWorld.sub(U.cam);
  const t = dot(rel, dir);
  const d = length(rel.sub(dir.mul(t)));
  const R = U.r0.add(U.k.mul(max(t, float(0))));
  // inside the cone, in front of the camera, short of the focus
  const cone = float(1).sub(smoothstep(R.mul(0.7), R, d));
  const along = smoothstep(float(-2), float(0.5), t).mul(float(1).sub(smoothstep(L.sub(U.keep).sub(4), L.sub(U.keep), t)));
  const fade = cone.mul(along).mul(U.on);
  // screen-door dither (stable per pixel)
  const hash = fract(sin(dot(vec2(screenCoordinate.x, screenCoordinate.y), vec2(12.9898, 78.233))).mul(43758.5453));
  m.opacityNode = float(1).sub(smoothstep(hash.sub(0.001), hash, fade));
  m.alphaTest = 0.5;
}
