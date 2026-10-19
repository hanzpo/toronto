// Materials for the unified surface (docs/SURFACE.md, `?surf=1`, workers/surface.ts).
// Group 0 (land cover, water, walls, banks) uses the vector-ground material as is.
// Group 1 (carriageway, junctions, curbs, sidewalks, pavers, medians, ballast, crossing
// panels, driveways, paths) uses the street material's surface / marking graph, but
// without its per-layer depth pull: the surface is a single partition, there is
// nothing to win a depth fight against.
import * as THREE from 'three/webgpu';
import { positionGeometry } from 'three/tsl';
import { roadMaterial } from './roadMaterial';
import { groundMaterial } from './groundMaterial';

let paved: THREE.MeshStandardNodeMaterial | null = null;

export function surfacePavedMaterial(): THREE.MeshStandardNodeMaterial {
  if (paved) return paved;
  const m = roadMaterial('surface-paved');
  m.positionNode = positionGeometry;
  paved = m;
  return m;
}

/** [ground, paved] for a surface mesh's two index groups */
export function surfaceMaterials(): THREE.Material[] {
  return [groundMaterial(), surfacePavedMaterial()];
}
