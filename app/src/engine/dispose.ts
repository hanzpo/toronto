// three's WebGPU renderer keeps one RenderObject per (object, material, pass)
// — pipeline + bindings (uniform buffers), and strong references to the object
// and its geometry, i.e. every vertex array — until the *object* dispatches
// 'dispose' (or its material is disposed). Plain Mesh / Group never do that
// themselves, so removed meshes with shared materials stayed alive forever
// (~90 MB of tile arrays per minute of flying). Call this on anything taken
// out of the scene for good.
import type * as THREE from 'three/webgpu';

/** Dispose the geometries under `root` (sprites share theirs: kept) and release its render objects. */
export function releaseObject(root: THREE.Object3D, geometry = true) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (geometry && m.geometry && !(o as THREE.Sprite).isSprite) m.geometry.dispose();
    (o as unknown as THREE.EventDispatcher<{ dispose: object }>).dispatchEvent({ type: 'dispose' });
  });
}
