// Landmarks whose buildings are drawn by the tile facade shader instead of the landmark model
// (the model keeps only its site furniture). Their suppressed OSM buildings are passed to the
// tile worker as "heritage" buildings (workers/buildings.ts): Victorian industrial brick (loft
// style: segmental-arched, multi-pane sash windows) with shopfronts on every lane side.
export const TILE_FACADE_LANDMARKS = new Set(['distillery_district']);
/** limestone buildings among them (Gooderham & Worts Stone Distillery, 1859, and its range) */
export const HERITAGE_STONE = new Set([192836911, 192836912]);
