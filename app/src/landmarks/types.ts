import type * as THREE from 'three/webgpu'
import type { V2 } from './kit'

/** One raw OSM building:part replaced by a landmark (local frame). */
export interface OsmPart {
  id: number
  poly: V2[]
  h: number | null
  minH: number
  roof: string
  roofH: number
  /** compass bearing (deg) the roof slopes down towards */
  roofDir: number | null
  levels?: number | null
  minLevel?: number | null
  /** building:part value, e.g. "yes", "column", "steps" */
  kind?: string | null
}

/** An entry of data/landmarks.json (see docs/SPEC.md). */
export interface LandmarkEntry {
  id: string
  name: string
  /** world metres [E, N] of the model origin */
  pos: [number, number]
  /** ground elevation (datum metres) of the model origin */
  base: number
  /** radians CCW about +y from the model's canonical orientation */
  rotation: number
  height?: number
  /** OSM building ids (ways +, relations -) the tile renderer must skip */
  suppress: number[]
  footprint?: V2[]
  parts?: Record<string, V2[]>
  osmParts?: OsmPart[]
  kind?: string
  // bridge extras
  span?: number
  river?: number
  // waterfall extras
  line?: [number, number][]
  top?: number
  bottom?: number
}

export type Detail = 'high' | 'low'

export interface BuildCtx {
  entry: LandmarkEntry | null
  detail: Detail
  /** Named footprint from landmarks.json `parts`, else the fallback. CCW. */
  part(name: string, fallback: V2[]): V2[]
  /** Main footprint from landmarks.json, else the fallback. CCW. */
  footprint(fallback: V2[]): V2[]
}

export interface LandmarkDef {
  /** Builds the model in local coordinates: origin = pos at base, +y up,
   * canonical frame (x = local east, -z = local north). */
  build: (ctx: BuildCtx) => THREE.Object3D
  /** Real height (m) of the model's top */
  height: number
  name: string
  /** Distance (m) beyond which the low-detail variant is shown */
  lodDistance?: number
}
