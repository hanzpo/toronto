import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PropOut } from '../core/model';
import { flat } from './materials';
import { vec3, uv, float, smoothstep } from 'three/tsl';
import { U } from '../../render/uniforms';

type Part = { g: THREE.BufferGeometry; m: THREE.Material };

const M = {
  pole: flat(0x55585c, 0.6, 0.4),
  poleDark: flat(0x2e3033, 0.6, 0.3),
  wood: flat(0x5a4632, 0.95),
  lampHead: glowing(0x3a3c40, 0xffd9a0, 2.4),
  lens: flat(0xf3eedc, 0.3, 0, 0x000000),
  red: flat(0xb4271f, 0.6),
  yellow: flat(0xd8a51a, 0.6),
  white: flat(0xeeeeea, 0.6),
  black: flat(0x1c1d1f, 0.6),
  concrete: flat(0xa9a59c, 0.85),
  steelGreen: flat(0x3d5145, 0.6, 0.3),
  bench: flat(0x3b3b3b, 0.7, 0.4),
  glass: flat(0x9fb6c4, 0.2, 0.1),
  roof: flat(0x6d7075, 0.6, 0.3),
  sign: flat(0x2d6e3e, 0.6),
};

function glowing(base: number, glow: number, k: number): THREE.MeshStandardNodeMaterial {
  const m = flat(base, 0.5, 0.3);
  const c = new THREE.Color(glow);
  m.emissiveNode = vec3(c.r, c.g, c.b).mul(U.night.mul(k));
  return m;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (r0: number, r1: number, h: number, x = 0, y = 0, z = 0, seg = 8) => new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y + h / 2, z);

function merge(parts: Part[]): Part[] {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    g.deleteAttribute('uv');
    const a = byMat.get(p.m) ?? [];
    a.push(g);
    byMat.set(p.m, a);
  }
  return [...byMat].map(([m, gs]) => ({ m, g: mergeGeometries(gs)! }));
}

const STATIC: Record<string, () => Part[]> = {
  lamp: () => [
    { g: cyl(0.09, 0.12, 8.5), m: M.pole },
    { g: box(2.2, 0.08, 0.08, 1.1, 8.4, 0), m: M.pole },
    { g: box(0.7, 0.14, 0.3, 2.1, 8.33, 0), m: M.lampHead },
  ],
  lamp_res: () => [
    { g: cyl(0.13, 0.16, 9.5), m: M.wood },
    { g: box(1.6, 0.08, 0.08, 0.8, 8.6, 0), m: M.pole },
    { g: box(0.6, 0.15, 0.28, 1.5, 8.53, 0), m: M.lampHead },
  ],
  hydrant: () => [{ g: cyl(0.12, 0.14, 0.7), m: M.red }, { g: cyl(0.14, 0.14, 0.12, 0, 0.7), m: M.yellow }],
  bin: () => [{ g: cyl(0.3, 0.28, 1.0, 0, 0, 0, 10), m: M.steelGreen }],
  bench: () => [{ g: box(0.5, 0.06, 1.8, 0, 0.45, 0), m: M.bench }, { g: box(0.06, 0.45, 1.8, -0.22, 0.65, 0), m: M.bench },
    { g: box(0.45, 0.45, 0.06, 0, 0.22, 0.8), m: M.bench }, { g: box(0.45, 0.45, 0.06, 0, 0.22, -0.8), m: M.bench }],
  stop_sign: () => [{ g: cyl(0.04, 0.04, 2.6), m: M.pole }, { g: new THREE.CylinderGeometry(0.38, 0.38, 0.03, 8).rotateZ(Math.PI / 2).rotateX(Math.PI / 8).translate(0.03, 2.4, 0), m: M.red }],
  crossbuck: () => [
    { g: cyl(0.05, 0.05, 3.6), m: M.pole },
    { g: box(0.03, 0.22, 1.25, 0.04, 3.2, 0).rotateX(0.785), m: M.white },
    { g: box(0.03, 0.22, 1.25, 0.04, 3.2, 0).rotateX(-0.785), m: M.white },
  ],
  ocs_pole: () => [{ g: cyl(0.12, 0.15, 7.5), m: M.poleDark }],
  buffer_stop: () => [{ g: box(0.8, 1.0, 3.0, 0, 0.5, 0), m: M.red }, { g: box(1.2, 0.4, 3.2, -0.4, 0.2, 0), m: M.black }],
  switch_machine: () => [{ g: box(1.4, 0.4, 0.5, 0, 0.2, 0), m: M.black }],
  canopy: () => [{ g: cyl(0.12, 0.12, 3.6, 0, 0, 0), m: M.pole }, { g: box(11.5, 0.25, 5.2, 0, 3.7, 0), m: M.roof }],
  platform_lamp: () => [{ g: cyl(0.06, 0.06, 4), m: M.pole }, { g: box(0.3, 0.12, 0.8, 0, 4, 0), m: M.lampHead }],
  bus_stop: () => [{ g: cyl(0.04, 0.04, 2.8), m: M.pole }, { g: box(0.03, 0.5, 0.35, 0, 2.6, 0), m: M.red }],
  shelter: () => [{ g: box(1.6, 0.08, 3.6, 0, 2.4, 0), m: M.roof }, { g: box(0.05, 2.3, 3.4, -0.75, 1.15, 0), m: M.glass },
    { g: box(1.5, 2.3, 0.05, 0, 1.15, 1.7), m: M.glass }, { g: box(1.5, 2.3, 0.05, 0, 1.15, -1.7), m: M.glass }],
  tram_stop: () => [{ g: cyl(0.04, 0.04, 2.8), m: M.pole }, { g: box(0.03, 0.4, 0.4, 0, 2.6, 0), m: M.red }],
  bollard: () => [{ g: cyl(0.1, 0.1, 0.9), m: M.yellow }],
};

export class PropsView {
  group = new THREE.Group();
  private lit = { red: flat(0xff2a1a, 0.4, 0, 0xff2a1a), amber: flat(0xffa41a, 0.4, 0, 0xffa41a), green: flat(0x3dff7a, 0.4, 0, 0x2ad46a), off: flat(0x222324, 0.5) };

  constructor(props: PropOut[], toThree: (x: number, y: number, z: number) => THREE.Vector3) {
    const byKind = new Map<string, PropOut[]>();
    for (const p of props) { const a = byKind.get(p.kind) ?? []; a.push(p); byKind.set(p.kind, a); }
    const dummy = new THREE.Object3D();
    for (const [kind, list] of byKind) {
      if (kind === 'tree' || kind === 'tree_small') continue;
      const make = STATIC[kind];
      if (make) {
        for (const part of merge(make())) {
          const im = new THREE.InstancedMesh(part.g, part.m, list.length);
          im.castShadow = true;
          im.receiveShadow = true;
          list.forEach((p, i) => {
            dummy.position.copy(toThree(p.x, p.y, p.z));
            dummy.rotation.set(0, p.h, 0);
            dummy.updateMatrix();
            im.setMatrixAt(i, dummy.matrix);
          });
          this.group.add(im);
        }
        continue;
      }
      for (const p of list) {
        const o = this.special(p);
        if (!o) continue;
        o.position.copy(toThree(p.x, p.y, p.z));
        this.staging.add(o);
      }
    }
    this.bake();
    this.pools(props, toThree);
  }

  private pools(props: PropOut[], toThree: (x: number, y: number, z: number) => THREE.Vector3) {
    const lamps = props.filter((p) => p.kind === 'lamp' || p.kind === 'lamp_res' || p.kind === 'platform_lamp');
    if (!lamps.length) return;
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = uv().sub(0.5).length().mul(2);
    const fall = float(1).sub(smoothstep(0.0, 1.0, r)).pow(2);
    mat.colorNode = vec3(1.0, 0.78, 0.5).mul(fall).mul(U.night.mul(0.55));
    const im = new THREE.InstancedMesh(geo, mat, lamps.length);
    const d = new THREE.Object3D();
    lamps.forEach((p, i) => {
      const reach = p.kind === 'lamp' ? 2.1 : p.kind === 'lamp_res' ? 1.5 : 0;
      const ox = Math.cos(p.h) * reach, oy = Math.sin(p.h) * reach;
      d.position.copy(toThree(p.x + ox, p.y + oy, p.z - 0.1));
      d.position.y += 0.06;
      const size = p.kind === 'platform_lamp' ? 9 : 18;
      d.scale.set(size, 1, size);
      d.updateMatrix();
      im.setMatrixAt(i, d.matrix);
    });
    im.renderOrder = 2;
    this.group.add(im);
  }

  private staging = new THREE.Group();
  private lampMesh: THREE.InstancedMesh | null = null;
  private lampInfo: { node: number; group: number; k: number; gate: boolean; idx: number }[] = [];
  private arms: { mesh: THREE.Mesh; base: THREE.Matrix4; node: number }[] = [];

  private bake() {
    const root = this.staging;
    root.updateMatrixWorld(true);
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const lamps: { m: THREE.Matrix4; info: { node: number; group: number; k: number; gate: boolean } }[] = [];
    const armRoots: THREE.Object3D[] = [];
    root.traverse((o) => { if (o.userData.arm) armRoots.push(o); });
    const inArm = (o: THREE.Object3D) => { for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q.userData.arm) return true; return false; };
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.lamp) { lamps.push({ m: mesh.matrixWorld.clone(), info: mesh.userData.lamp }); return; }
      if (inArm(mesh)) return;
      const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
      g.deleteAttribute('uv');
      const a = byMat.get(mesh.material as THREE.Material) ?? [];
      a.push(g);
      byMat.set(mesh.material as THREE.Material, a);
    });
    for (const [m, gs] of byMat) {
      const merged = new THREE.Mesh(mergeGeometries(gs)!, m);
      merged.castShadow = true;
      merged.receiveShadow = true;
      this.group.add(merged);
    }
    if (lamps.length) {
      const geo = new THREE.CylinderGeometry(0.11, 0.11, 0.05, 10).rotateZ(Math.PI / 2);
      const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicNodeMaterial({ color: 0xffffff }), lamps.length);
      lamps.forEach((l, i) => { im.setMatrixAt(i, l.m); im.setColorAt(i, OFF); this.lampInfo.push({ ...l.info, idx: i }); });
      this.lampMesh = im;
      this.group.add(im);
    }
    for (const a of armRoots) {
      const gs: THREE.BufferGeometry[] = [];
      a.updateMatrixWorld(true);
      const inv = a.matrixWorld.clone().invert();
      a.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
        g.deleteAttribute('uv');
        const c = ((mesh.material as THREE.MeshStandardNodeMaterial).color ?? new THREE.Color(1, 1, 1));
        const col = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        gs.push(g);
      });
      if (!gs.length) continue;
      const mesh = new THREE.Mesh(mergeGeometries(gs)!, ARM_MAT);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = true;
      const base = a.matrixWorld.clone();
      mesh.matrix.copy(base);
      this.group.add(mesh);
      this.arms.push({ mesh, base, node: a.userData.arm.node });
    }
    root.clear();
  }

  private special(p: PropOut): THREE.Object3D | null {
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = g) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const P = p.p ?? {};
    if (p.kind === 'signal_pole') {
      add(cyl(0.13, 0.16, 6.6), M.poleDark);
      const head = (parent: THREE.Object3D, x: number, y: number, z: number, face: number) => {
        const h = new THREE.Group();
        h.position.set(x, y, z);
        h.rotation.y = face;
        add(box(0.3, 1.05, 0.38, 0, 0, 0), M.black, h);
        add(box(0.04, 1.25, 0.6, -0.17, 0, 0), M.black, h);
        const lamps: THREE.Mesh[] = [];
        for (const [k, yy] of [[0, 0.32], [1, 0], [2, -0.32]] as const) {
          const l = add(new THREE.BufferGeometry(), this.lit.off, h);
          l.position.set(0.17, yy, 0);
          l.userData.lamp = { node: P.node ?? -1, group: 0, k, gate: false };
          lamps[k] = l;
        }
        parent.add(h);
        return lamps as [THREE.Mesh, THREE.Mesh, THREE.Mesh];
      };
      const arm = new THREE.Group();
      arm.rotation.y = P.armDir ?? 0;
      g.add(arm);
      const reach = P.arm ?? 0;
      if (reach > 0.5) {
        add(box(reach + 0.3, 0.14, 0.14, (reach + 0.3) / 2, 6.3, 0), M.poleDark, arm);
        const n = reach > 6 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const x = reach * (n === 1 ? 0.75 : 0.45 + 0.5 * k);
          const lamps = head(arm, x, 5.6, 0, (p.h - (P.armDir ?? 0)));
          for (const l of lamps) l.userData.lamp.group = P.group ?? 0;
        }
      }
      const lamps = head(g, 0, 3.6, 0, p.h);
      for (const l of lamps) l.userData.lamp.group = P.group ?? 0;
      const holder = g.children[g.children.length - 1];
      holder.position.add(new THREE.Vector3(Math.cos(p.h) * 0.25, 0, -Math.sin(p.h) * 0.25));
      if (P.side !== undefined) {
        const s = head(g, 0, 3.6, 0, P.side);
        for (const l of s) l.userData.lamp.group = P.sideGroup ?? 0;
        const hh = g.children[g.children.length - 1];
        hh.position.add(new THREE.Vector3(Math.cos(P.side) * 0.25, 0, -Math.sin(P.side) * 0.25));
      }
      return g;
    }
    if (p.kind === 'gate') {
      add(cyl(0.1, 0.12, 4.2), M.white);
      const cb = new THREE.Group();
      cb.rotation.y = p.h;
      g.add(cb);
      add(box(0.03, 0.22, 1.25, 0.12, 3.9, 0).rotateX(0.785), M.white, cb);
      add(box(0.03, 0.22, 1.25, 0.12, 3.9, 0).rotateX(-0.785), M.white, cb);
      add(box(0.05, 0.25, 1.4, 0.12, 2.8, 0), M.black, cb);
      for (const [k, zz] of [[0, 0.5], [1, -0.5]] as const) {
        const l = add(new THREE.BufferGeometry(), this.lit.off, cb);
        l.position.set(0.16, 2.8, zz);
        l.scale.set(1.35, 1.35, 1.35);
        l.userData.lamp = { node: P.node ?? -1, group: 0, k, gate: true };
      }
      add(box(0.6, 1.1, 0.5, 0, 0.55, 0), M.concrete);
      const pivot = new THREE.Group();
      pivot.position.y = 1.05;
      pivot.rotation.y = P.armDir ?? 0;
      g.add(pivot);
      const arm = new THREE.Group();
      arm.userData.arm = { node: P.node ?? -1 };
      pivot.add(arm);
      const L = P.arm ?? 4;
      for (let k = 0; k < Math.ceil(L / 0.6); k++) {
        add(box(Math.min(0.6, L - k * 0.6), 0.1, 0.1, 0.3 + k * 0.6, 0, 0), k % 2 ? M.white : M.red, arm);
      }
      return g;
    }
    if (p.kind === 'pier') {
      const w = Math.max(1.5, (P.width ?? 6) * 0.8);
      const h = P.height ?? 5;
      const r = new THREE.Group();
      r.rotation.y = p.h;
      g.add(r);
      if (P.thin) {
        for (const z of [-w * 0.3, 0, w * 0.3]) add(cyl(0.45, 0.45, h, 0, 0, z, 12), M.concrete, r);
        add(box(1.2, 1.0, w, 0, h - 0.5, 0), M.concrete, r);
      } else {
        add(box(1.4, h, w, 0, h / 2, 0), M.concrete, r);
        add(box(1.8, 0.8, w + 0.6, 0, h - 0.4, 0), M.concrete, r);
      }
      return g;
    }
    return null;
  }

  setSignals(state: (node: number, group: number) => 'red' | 'amber' | 'green') {
    if (!this.lampMesh) return;
    let dirty = false;
    for (const l of this.lampInfo) {
      if (l.gate) continue;
      const st = state(l.node, l.group);
      const on = (l.k === 0 && st === 'red') || (l.k === 1 && st === 'amber') || (l.k === 2 && st === 'green');
      const c = on ? (l.k === 0 ? RED : l.k === 1 ? AMBER : GREEN) : OFF;
      this.lampMesh.setColorAt(l.idx, c);
      dirty = true;
    }
    if (dirty && this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
  }

  setGates(state: (node: number) => { down: number; flash: boolean }) {
    for (const a of this.arms) {
      const s = state(a.node);
      a.mesh.matrix.multiplyMatrices(a.base, ROT.makeRotationZ((1 - s.down) * (Math.PI / 2 - 0.05)));
      a.mesh.matrixWorldNeedsUpdate = true;
    }
    if (!this.lampMesh) return;
    for (const l of this.lampInfo) {
      if (!l.gate) continue;
      const s = state(l.node);
      const on = s.down > 0 && (l.k === 0 ? s.flash : !s.flash);
      this.lampMesh.setColorAt(l.idx, on ? RED : OFF);
    }
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
  }
}

const OFF = new THREE.Color(0x1a1b1d), RED = new THREE.Color(0xff3020), AMBER = new THREE.Color(0xffb020), GREEN = new THREE.Color(0x40ff80);
const ROT = new THREE.Matrix4();
const ARM_MAT = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 });
