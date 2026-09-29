import type * as THREE from 'three/webgpu';
import type { Engine } from './Engine';

/** Shared per-frame context handed to every layer's `update`. Read-only for layers. */
export interface FrameContext {
  frame: number;
  /** real seconds since engine start */
  time: number;
  /** real seconds since previous frame (clamped to 0.1) */
  dt: number;
  /** sim time, UTC epoch ms */
  simMs: number;
  /** sim seconds advanced this frame (0 when paused) */
  simDt: number;
  camera: THREE.PerspectiveCamera;
  /** camera world position (three axes: x=E, y=elev, z=-N) */
  cameraPos: THREE.Vector3;
  /** controller focus point on the ground (world) */
  focus: THREE.Vector3;
  /** camera height above terrain (m) */
  altitude: number;
  viewport: { width: number; height: number; dpr: number };
  /** pixels per radian-ish factor: projected size(px) = worldSize * pixelScale / distance */
  pixelScale: number;
  /** unit vector towards the sun (world) */
  sunDir: THREE.Vector3;
  /** 0 = night … 1 = full day */
  daylight: number;
  anchor: Anchor;
  analyticsMode: boolean;
}

/**
 * Plug-in interface. Layers own their THREE objects and add them to
 * `engine.scene` (or `engine.overlayRoot`) in `init`.
 */
export interface Layer {
  readonly id: string;
  init(engine: Engine): void | Promise<void>;
  update(ctx: FrameContext): void;
  dispose(): void;
}

/**
 * Floating origin. Large-world objects whose vertex/instance data can't be
 * tile-local write positions relative to `anchor.origin` and set their
 * object position to `anchor.origin`. When the camera travels far the anchor
 * re-bases and `version` increments — re-write your relative data then.
 */
export interface Anchor {
  /** world position of the anchor (y = 0) — snapped to a 1024 m grid */
  readonly origin: THREE.Vector3;
  /** increments whenever `origin` changes */
  readonly version: number;
  /** world (E, N, elev) → anchor-relative three coords */
  toLocal(e: number, n: number, elev: number, out: THREE.Vector3): THREE.Vector3;
}
