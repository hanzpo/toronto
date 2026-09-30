// Vegetation species models (shared by the tile worker's placement and the
// renderer's shaders). Toronto references: the City's street-tree inventory
// (Norway maple, honey locust, little-leaf linden, silver maple, London plane,
// Colorado spruce lead the counts), ravine forest (sugar maple, red oak,
// beech, hemlock, white pine, cedar in the wet bottoms), High Park's black-oak
// savanna, and backyard cedar hedges. Fall timing: Toronto colour peaks
// mid-October (maples), locusts turn and drop first, oaks and planes last.
//
// Two geometry families: LOBED (a crown of foliage lobes on a trunk; also
// pines, shrubs and clipped hedges) and TIERED (stacked branch whorls:
// spruce, cedar, hemlock). One draw per family per LOD, shapes morph per
// species in the vertex shader from the parameters below.

export const LOBED = 0, TIERED = 1;

export interface Species {
  name: string;
  family: 0 | 1;
  /** mature height range (m) */
  h: [number, number];
  /** crown diameter / height */
  w: [number, number];
  /** crown base as a fraction of height (clear trunk) */
  base: number;
  /** crown narrows toward the top (0 round … 1 cone) */
  taper: number;
  /** crown widens toward the top (vase / spreading) */
  vase: number;
  /** outer crown hangs down (weeping) */
  droop: number;
  /** foliage lobe size (1 dense … 0.6 airy / see-through) */
  open: number;
  /** trunk radius as a fraction of height */
  trunk: number;
  /** summer foliage (linear RGB) */
  leaf: [number, number, number];
  /** fall colour at peak */
  fall: [number, number, number];
  bark: [number, number, number];
  /** day of year: colour starts turning, peaks, leaves gone (0 = evergreen) */
  turn: number; peak: number; drop: number;
  /** fade-out distance (m) for small plants; 0 = keep to the horizon */
  maxDist: number;
}

const BARK: [number, number, number] = [0.085, 0.07, 0.06];
const BARK_GREY: [number, number, number] = [0.16, 0.155, 0.14];

// linear RGB. Doy: Oct 1 = 274, Oct 15 = 288, Nov 1 = 305.
export const SPECIES: Species[] = [
  /* 0 */ { name: 'norway maple', family: LOBED, h: [11, 16], w: [0.8, 1.0], base: 0.26, taper: 0.05, vase: 0, droop: 0, open: 1, trunk: 0.02, leaf: [0.05, 0.1, 0.035], fall: [0.42, 0.33, 0.04], bark: BARK, turn: 290, peak: 303, drop: 320, maxDist: 0 },
  /* 1 */ { name: 'silver maple', family: LOBED, h: [15, 22], w: [0.72, 0.9], base: 0.3, taper: 0, vase: 0.35, droop: 0.05, open: 0.86, trunk: 0.022, leaf: [0.085, 0.14, 0.06], fall: [0.4, 0.34, 0.1], bark: BARK_GREY, turn: 283, peak: 297, drop: 314, maxDist: 0 },
  /* 2 */ { name: 'sugar maple', family: LOBED, h: [14, 20], w: [0.62, 0.8], base: 0.25, taper: 0.18, vase: 0, droop: 0, open: 0.97, trunk: 0.019, leaf: [0.06, 0.125, 0.04], fall: [0.6, 0.13, 0.02], bark: BARK, turn: 275, peak: 291, drop: 307, maxDist: 0 },
  /* 3 */ { name: 'honey locust', family: LOBED, h: [11, 15], w: [0.9, 1.1], base: 0.34, taper: 0, vase: 0.45, droop: 0, open: 0.66, trunk: 0.017, leaf: [0.12, 0.18, 0.035], fall: [0.52, 0.4, 0.04], bark: BARK, turn: 272, peak: 286, drop: 298, maxDist: 0 },
  /* 4 */ { name: 'little-leaf linden', family: LOBED, h: [11, 15], w: [0.55, 0.68], base: 0.2, taper: 0.5, vase: 0, droop: 0, open: 1, trunk: 0.017, leaf: [0.055, 0.115, 0.04], fall: [0.38, 0.33, 0.06], bark: BARK, turn: 280, peak: 295, drop: 310, maxDist: 0 },
  /* 5 */ { name: 'london plane', family: LOBED, h: [17, 24], w: [0.75, 0.9], base: 0.3, taper: 0.05, vase: 0.15, droop: 0, open: 0.88, trunk: 0.022, leaf: [0.07, 0.125, 0.045], fall: [0.24, 0.16, 0.05], bark: [0.3, 0.28, 0.21], turn: 293, peak: 311, drop: 329, maxDist: 0 },
  /* 6 */ { name: 'oak', family: LOBED, h: [15, 22], w: [0.85, 1.05], base: 0.3, taper: 0, vase: 0.2, droop: 0, open: 0.85, trunk: 0.025, leaf: [0.045, 0.09, 0.03], fall: [0.3, 0.09, 0.025], bark: [0.07, 0.065, 0.06], turn: 290, peak: 307, drop: 331, maxDist: 0 },
  /* 7 */ { name: 'weeping willow', family: LOBED, h: [11, 15], w: [1.0, 1.2], base: 0.22, taper: 0, vase: 0.1, droop: 0.9, open: 0.9, trunk: 0.028, leaf: [0.13, 0.19, 0.045], fall: [0.4, 0.36, 0.07], bark: BARK, turn: 293, peak: 311, drop: 330, maxDist: 0 },
  /* 8 */ { name: 'beech', family: LOBED, h: [16, 22], w: [0.72, 0.9], base: 0.22, taper: 0.08, vase: 0, droop: 0.1, open: 0.97, trunk: 0.021, leaf: [0.07, 0.135, 0.045], fall: [0.36, 0.2, 0.04], bark: [0.2, 0.2, 0.19], turn: 286, peak: 302, drop: 323, maxDist: 0 },
  /* 9 */ { name: 'columnar', family: LOBED, h: [10, 15], w: [0.24, 0.32], base: 0.1, taper: 0.25, vase: 0, droop: 0, open: 1, trunk: 0.013, leaf: [0.07, 0.135, 0.045], fall: [0.5, 0.42, 0.04], bark: BARK_GREY, turn: 286, peak: 300, drop: 310, maxDist: 0 },
  /* 10 */ { name: 'ornamental', family: LOBED, h: [5, 8], w: [0.9, 1.15], base: 0.28, taper: 0, vase: 0.1, droop: 0.05, open: 0.92, trunk: 0.02, leaf: [0.065, 0.11, 0.04], fall: [0.46, 0.13, 0.035], bark: BARK, turn: 279, peak: 295, drop: 309, maxDist: 0 },
  /* 11 */ { name: 'pine', family: LOBED, h: [13, 19], w: [0.42, 0.58], base: 0.52, taper: 0.1, vase: 0.25, droop: 0, open: 0.82, trunk: 0.02, leaf: [0.03, 0.065, 0.04], fall: [0.03, 0.065, 0.04], bark: [0.12, 0.075, 0.05], turn: 0, peak: 0, drop: 0, maxDist: 0 },
  /* 12 */ { name: 'shrub', family: LOBED, h: [1.1, 2.4], w: [1.2, 1.6], base: 0, taper: 0.05, vase: 0.1, droop: 0, open: 0.95, trunk: 0, leaf: [0.055, 0.1, 0.035], fall: [0.3, 0.05, 0.035], bark: BARK, turn: 278, peak: 294, drop: 311, maxDist: 280 },
  /* 13 */ { name: 'cedar hedge', family: LOBED, h: [1.6, 2.8], w: [0.5, 0.7], base: 0, taper: 0.12, vase: 0, droop: 0, open: 1, trunk: 0, leaf: [0.045, 0.085, 0.03], fall: [0.045, 0.085, 0.03], bark: BARK, turn: 0, peak: 0, drop: 0, maxDist: 420 },
  /* 14 */ { name: 'white spruce', family: TIERED, h: [13, 20], w: [0.3, 0.38], base: 0.04, taper: 1, vase: 0, droop: 0.15, open: 1, trunk: 0.014, leaf: [0.025, 0.055, 0.035], fall: [0.025, 0.055, 0.035], bark: BARK, turn: 0, peak: 0, drop: 0, maxDist: 0 },
  /* 15 */ { name: 'blue spruce', family: TIERED, h: [9, 15], w: [0.36, 0.44], base: 0.03, taper: 1, vase: 0, droop: 0.05, open: 1, trunk: 0.014, leaf: [0.06, 0.085, 0.085], fall: [0.06, 0.085, 0.085], bark: BARK, turn: 0, peak: 0, drop: 0, maxDist: 0 },
  /* 16 */ { name: 'white cedar', family: TIERED, h: [7, 12], w: [0.22, 0.3], base: 0.02, taper: 0.7, vase: 0, droop: 0, open: 1, trunk: 0.012, leaf: [0.06, 0.1, 0.035], fall: [0.06, 0.1, 0.035], bark: [0.13, 0.09, 0.07], turn: 0, peak: 0, drop: 0, maxDist: 0 },
  /* 17 */ { name: 'hemlock', family: TIERED, h: [15, 22], w: [0.38, 0.48], base: 0.06, taper: 0.9, vase: 0, droop: 0.45, open: 1, trunk: 0.016, leaf: [0.028, 0.06, 0.038], fall: [0.028, 0.06, 0.038], bark: BARK, turn: 0, peak: 0, drop: 0, maxDist: 0 },
];

export const S = {
  NORWAY: 0, SILVER: 1, SUGAR: 2, LOCUST: 3, LINDEN: 4, PLANE: 5, OAK: 6, WILLOW: 7, BEECH: 8, COLUMNAR: 9,
  ORNAMENTAL: 10, PINE: 11, SHRUB: 12, HEDGE: 13, SPRUCE: 14, BLUE_SPRUCE: 15, CEDAR: 16, HEMLOCK: 17,
} as const;

export const N_SPECIES = SPECIES.length;
export const familyOf = (sp: number) => SPECIES[sp]?.family ?? LOBED;

/** OSM genus code (p_var bits 1–4, see pipeline osm_extract TREE_GENUS) → species; -1 unknown */
export const GENUS: number[] = [-1, S.NORWAY, S.LOCUST, S.LINDEN, S.PLANE, S.OAK, S.WILLOW, S.PINE, S.SPRUCE, S.CEDAR, S.HEMLOCK, S.BEECH, S.SILVER, S.COLUMNAR, S.ORNAMENTAL, -1];

/** instance record written by the worker (stride 8):
 *  x, n (tile-local E, N), z (ground, datum m), seed (0..1),
 *  height (m), crown width (m), species, extra (hedge: 8·length + angle + π; else 0) */
export const VEG_STRIDE = 8;

/**
 * Per-species parameter rows for the shaders (vec4 each, SPECIES_ROWS per species):
 *  0: base, taper, vase, droop
 *  1: open, trunk, family, maxDist
 *  2: leaf rgb, turn
 *  3: fall rgb, peak
 *  4: bark rgb, drop
 */
export const SPECIES_ROWS = 5;
export function speciesRows(): number[][] {
  const out: number[][] = [];
  for (const s of SPECIES) {
    out.push([s.base, s.taper, s.vase, s.droop]);
    out.push([s.open, s.trunk, s.family, s.maxDist]);
    out.push([...s.leaf, s.turn]);
    out.push([...s.fall, s.peak]);
    out.push([...s.bark, s.drop]);
  }
  return out;
}
