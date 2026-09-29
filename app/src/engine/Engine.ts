// Engine core: renderer (WebGPU w/ WebGL2 fallback), scene, camera, render
// loop, layer plug-ins, floating anchor, stats.
import * as THREE from 'three/webgpu';
import { CameraController, type CamState, type GroundHit } from './CameraController';
import type { Anchor, FrameContext, Layer } from './types';
import { sunDirection } from './sun';
import { config } from './config';
import { clock } from '../state/clock';
import { simSpeed, useApp } from '../state/store';
import { Atmosphere } from '../render/atmosphere';
import { TileManager } from '../render/tiles/TileManager';

const ANCHOR_GRID = 1024;
const ANCHOR_REBASE = 3000;

class FloatingAnchor implements Anchor {
  origin = new THREE.Vector3();
  version = 0;
  update(cam: THREE.Vector3): boolean {
    const dx = cam.x - this.origin.x, dz = cam.z - this.origin.z;
    if (this.version > 0 && Math.hypot(dx, dz) < ANCHOR_REBASE) return false;
    this.origin.set(Math.round(cam.x / ANCHOR_GRID) * ANCHOR_GRID, 0, Math.round(cam.z / ANCHOR_GRID) * ANCHOR_GRID);
    this.version++;
    return true;
  }
  toLocal(e: number, n: number, elev: number, out: THREE.Vector3) {
    return out.set(e - this.origin.x, elev, -n - this.origin.z);
  }
}

export const DEFAULT_VIEW: CamState = {
  // oblique view over downtown Toronto looking roughly north-west from the lake
  e: -350, n: -700, h: 0, dist: 3200, heading: -0.35, pitch: 0.62,
};

export class Engine {
  renderer!: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  /** add screen-space overlays here (drawn after the base map) */
  overlayRoot = new THREE.Group();
  camera: THREE.PerspectiveCamera;
  controls!: CameraController;
  atmosphere!: Atmosphere;
  tiles!: TileManager;
  anchor = new FloatingAnchor();
  layers: Layer[] = [];
  backend = '';
  readonly ctx: FrameContext;
  private container: HTMLElement;
  private last = 0;
  private start = performance.now();
  private frame = 0;
  private statAcc = { t: 0, frames: 0, cpu: 0 };
  private resizeObs: ResizeObserver | null = null;
  private sun = new THREE.Vector3();
  private disposed = false;
  private picker = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  lastDrawCalls = 0;
  lastTriangles = 0;

  private dataRoot: string;
  constructor(container: HTMLElement, dataRoot: string) {
    this.dataRoot = dataRoot;
    this.container = container;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 600000);
    this.scene.name = 'world';
    this.overlayRoot.name = 'overlays';
    this.overlayRoot.renderOrder = 10;
    this.ctx = {
      frame: 0, time: 0, dt: 0, simMs: clock.simMs, simDt: 0, camera: this.camera,
      cameraPos: this.camera.position, focus: new THREE.Vector3(), altitude: 1000,
      viewport: { width: 1, height: 1, dpr: 1 }, pixelScale: 1, sunDir: this.sun, daylight: 1,
      anchor: this.anchor, analyticsMode: false,
    };
  }

  async init() {
    const renderer = new THREE.WebGPURenderer({
      antialias: true,
      forceWebGL: config.forceWebGL,
      reversedDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    await renderer.init();
    // reversed-Z needs float depth (WebGPU) or EXT_clip_control (WebGL2); otherwise log depth
    if (!renderer.reversedDepthBuffer) (renderer as unknown as { logarithmicDepthBuffer: boolean }).logarithmicDepthBuffer = true;
    const backendAny = renderer.backend as unknown as { isWebGPUBackend?: boolean };
    this.backend = backendAny.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    this.backend += renderer.reversedDepthBuffer ? ' · reversed-Z' : ' · log-depth';
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.info.autoReset = true;
    this.renderer = renderer;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(renderer.domElement);

    this.atmosphere = new Atmosphere(this.scene);
    this.tiles = new TileManager(this.dataRoot);
    this.tiles.lodScale = config.lodScale;
    await this.tiles.init();
    this.scene.add(this.tiles.root);
    this.scene.add(this.overlayRoot);

    let start = DEFAULT_VIEW;
    if (this.tiles.manifest.synthetic) start = { ...DEFAULT_VIEW, e: 0, n: -600, dist: 2600 };
    if (config.cam && config.cam.length >= 2) {
      const [e, n, dist, hd, pd] = config.cam;
      start = { ...start, e, n, dist: dist || start.dist, heading: hd !== undefined && !isNaN(hd) ? (hd * Math.PI) / 180 : start.heading, pitch: pd !== undefined && !isNaN(pd) ? (pd * Math.PI) / 180 : start.pitch };
    }
    this.controls = new CameraController({
      camera: this.camera,
      dom: renderer.domElement,
      heightAt: (e, n) => this.heightAt(e, n),
      pickGround: (x, y) => this.pickGround(x, y),
    }, start);
    this.controls.apply();

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.container);
    this.last = performance.now();
    renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------------ layers

  async addLayer(layer: Layer) {
    this.layers.push(layer);
    await layer.init(this);
  }

  removeLayer(id: string) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i >= 0) {
      this.layers[i].dispose();
      this.layers.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------------ queries

  /** terrain elevation (datum m) at world E,N (finest loaded LOD, 0 if unknown) */
  heightAt(e: number, n: number): number {
    return this.tiles ? this.tiles.heightAt(e, n, 0) : 0;
  }

  /** ray-march the terrain height field under a screen point */
  pickGround(clientX: number, clientY: number): GroundHit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    return this.pickGroundNdc(this.ndc.x, this.ndc.y);
  }

  pickGroundNdc(x: number, y: number): GroundHit | null {
    this.picker.setFromCamera(this.ndc.set(x, y), this.camera);
    const o = this.picker.ray.origin, d = this.picker.ray.direction;
    let t = 0;
    let prevT = 0;
    const maxT = 400000;
    for (let i = 0; i < 400 && t < maxT; i++) {
      const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
      const above = py - this.heightAt(px, -pz);
      if (above <= 0) {
        // bisect between prevT and t
        let a = prevT, b = t;
        for (let k = 0; k < 20; k++) {
          const m = (a + b) / 2;
          const my = o.y + d.y * m;
          if (my - this.heightAt(o.x + d.x * m, -(o.z + d.z * m)) > 0) a = m; else b = m;
        }
        const hx = o.x + d.x * b, hz = o.z + d.z * b;
        return { e: hx, n: -hz, h: this.heightAt(hx, -hz) };
      }
      if (d.y >= 0 && py > 3000) return null;
      prevT = t;
      t += Math.max(above * 0.7, 1, t * 0.004);
    }
    return null;
  }

  /** world (E, N, elev) → screen px, or null if behind the camera */
  project(e: number, n: number, elev: number, out = new THREE.Vector3()) {
    out.set(e, elev, -n).project(this.camera);
    if (out.z < -1 || out.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (out.x * 0.5 + 0.5) * r.width, y: (-out.y * 0.5 + 0.5) * r.height };
  }

  // ------------------------------------------------------------------------ loop

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.ctx.viewport.width = w;
    this.ctx.viewport.height = h;
    this.ctx.viewport.dpr = this.renderer.getPixelRatio();
  }

  private tick() {
    if (this.disposed) return;
    const now = performance.now();
    const cpu0 = now;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const st = useApp.getState();
    clock.advance(dt, simSpeed());

    const ctx = this.ctx;
    ctx.frame = ++this.frame;
    ctx.time = (now - this.start) / 1000;
    ctx.dt = dt;
    ctx.simMs = clock.simMs;
    ctx.simDt = clock.lastDtSim;
    ctx.analyticsMode = st.analyticsMode;

    this.controls.update(dt);
    const cur = this.controls.cur;
    ctx.focus.set(cur.e, cur.h, -cur.n);
    ctx.altitude = this.camera.position.y - this.heightAt(this.camera.position.x, -this.camera.position.z);
    ctx.pixelScale = this.ctx.viewport.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));

    // near/far adapt to altitude for best depth use
    const near = THREE.MathUtils.clamp(ctx.altitude * 0.02, 0.3, 50);
    if (Math.abs(this.camera.near - near) / near > 0.2) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }

    if (this.anchor.update(this.camera.position)) this.tiles.rebase(this.anchor.origin.x, -this.anchor.origin.z);

    sunDirection(ctx.simMs, this.sun);
    this.atmosphere.shadowsEnabled = st.shadows;
    this.atmosphere.update(ctx, this.sun);
    this.tiles.update(ctx);
    for (const l of this.layers) l.update(ctx);

    this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info.render;
    this.lastDrawCalls = info.drawCalls;
    this.lastTriangles = info.triangles;

    const sa = this.statAcc;
    sa.t += dt; sa.frames++; sa.cpu += performance.now() - cpu0;
    if (sa.t >= 0.5) {
      const ts = this.tiles.stats();
      useApp.getState().setStats({
        fps: sa.frames / sa.t,
        frameMs: sa.cpu / sa.frames,
        drawCalls: info.drawCalls,
        triangles: info.triangles,
        tilesLoaded: ts.loaded,
        tilesVisible: ts.visible,
        tilesPending: ts.pending,
        gpuMB: ts.bytes / (1024 * 1024),
        backend: this.backend,
        altitude: ctx.altitude,
        cameraE: this.camera.position.x,
        cameraN: -this.camera.position.z,
        heading: cur.heading,
        metersPerPixel: Math.max(0.01, cur.dist / ctx.pixelScale),
      });
      sa.t = 0; sa.frames = 0; sa.cpu = 0;
    }
  }

  dispose() {
    this.disposed = true;
    this.renderer?.setAnimationLoop(null);
    this.resizeObs?.disconnect();
    for (const l of this.layers) l.dispose();
    this.controls?.dispose();
    this.tiles?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}
