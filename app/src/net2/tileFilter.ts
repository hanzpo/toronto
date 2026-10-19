// ?net=2: inside the primitive-network slice bbox the tile's own street drawing is dropped --
// road pieces, junction surfaces / corner sidewalks / curb returns / tactile plates, signal
// poles, medians and street-running track -- because the slice generates all of it from the
// primitive network (net2/gen.ts). Everything else in the tile is untouched.
import type { TypedArray } from '../data/tbn';

type Arr = Record<string, TypedArray>;

function keepPieces(a: Arr, p: string, keep: (i: number, mx: number, my: number) => boolean) {
  const off = a[`${p}_off`] as Uint32Array | undefined, xyz = a[`${p}_xyz`] as Float32Array | undefined;
  if (!off || !xyz || off.length < 2) return;
  const nP = off.length - 1, nV = off[nP];
  const kept: number[] = [];
  for (let i = 0; i < nP; i++) {
    const m = Math.floor((off[i] + off[i + 1] - 1) / 2);
    if (keep(i, xyz[m * 3], xyz[m * 3 + 1])) kept.push(i);
  }
  if (kept.length === nP) return;
  const newOff = new Uint32Array(kept.length + 1);
  const vIdx: number[] = [];
  kept.forEach((i, k) => { for (let v = off[i]; v < off[i + 1]; v++) vIdx.push(v); newOff[k + 1] = vIdx.length; });
  for (const key of Object.keys(a)) {
    if (!key.startsWith(`${p}_`) || key === `${p}_off`) continue;
    const src = a[key];
    const Ctor = src.constructor as new (n: number) => TypedArray;
    if (src.length === nP && nP !== nV) {
      const dst = new Ctor(kept.length);
      kept.forEach((i, k) => { dst[k] = src[i]; });
      a[key] = dst;
    } else if (nV > 0 && src.length % nV === 0) {
      const st = src.length / nV;
      const dst = new Ctor(vIdx.length * st);
      vIdx.forEach((v, k) => { for (let c = 0; c < st; c++) dst[k * st + c] = src[v * st + c]; });
      a[key] = dst;
    }
  }
  a[`${p}_off`] = newOff;
}

function keepTris(a: Arr, p: string, inBox: (x: number, y: number) => boolean) {
  const xy = a[`${p}_xy`] as Float32Array | undefined, tri = a[`${p}_tri`] as Uint32Array | undefined;
  if (!xy || !tri) return;
  const out: number[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const cx = (xy[tri[t] * 2] + xy[tri[t + 1] * 2] + xy[tri[t + 2] * 2]) / 3, cy = (xy[tri[t] * 2 + 1] + xy[tri[t + 1] * 2 + 1] + xy[tri[t + 2] * 2 + 1]) / 3;
    if (!inBox(cx, cy)) out.push(tri[t], tri[t + 1], tri[t + 2]);
  }
  a[`${p}_tri`] = new Uint32Array(out);
}

function keepPoints(a: Arr, p: string, xyKey: string, inBox: (x: number, y: number, i: number) => boolean) {
  const xy = a[`${p}_${xyKey}`] as Float32Array | undefined;
  if (!xy) return;
  const n = xy.length / 2;
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (!inBox(xy[2 * i], xy[2 * i + 1], i)) kept.push(i);
  if (kept.length === n) return;
  for (const key of Object.keys(a)) {
    if (!key.startsWith(`${p}_`)) continue;
    const src = a[key];
    if (src.length % n !== 0) continue;
    const st = src.length / n;
    const dst = new (src.constructor as new (m: number) => TypedArray)(kept.length * st);
    kept.forEach((i, k) => { for (let c = 0; c < st; c++) dst[k * st + c] = src[i * st + c]; });
    a[key] = dst;
  }
}

/** drop the tile's street drawing inside the slice box (world bbox, tile origin x0, y0) */
export function dropNet2(a: Arr, box: number[], x0: number, y0: number) {
  const bx0 = box[0] - x0, by0 = box[1] - y0, bx1 = box[2] - x0, by1 = box[3] - y0;
  const inBox = (x: number, y: number) => x > bx0 && x < bx1 && y > by0 && y < by1;
  const rcls = a.r_class as Uint8Array | undefined;
  keepPieces(a, 'r', (i, x, y) => !inBox(x, y) || (rcls ? rcls[i] >= 8 : false));      // paths stay (ped mesh later)
  const lcls = a.l_class as Uint8Array | undefined;
  const railToo = (box[4] ?? 0) > 0;          // the slice draws the main / siding track as well (primrail)
  keepPieces(a, 'l', (i, x, y) => !inBox(x, y) || (lcls ? (lcls[i] !== 4 && !(railToo && lcls[i] <= 1)) : true));
  keepTris(a, 'js', inBox);
  keepTris(a, 'jw', inBox);
  keepPieces(a, 'md', (_i, x, y) => !inBox(x, y));
  keepPoints(a, 'sg', 'xy', inBox);
  // mapped street lamps and furniture (bins, hydrants, benches, news / post boxes, bike parking, pay
  // stations): the slice places its own in the asset prop slots (net2/props.ts); bike-share docks stay
  const pk = a.p_kind as Uint8Array | undefined;
  if (pk) {
    const DROP = new Set([4, 21, 22, 23, 24, 26, 27, 29]);
    keepPoints(a, 'p', 'xy', (x, y, i) => inBox(x, y) && DROP.has(pk[i]));
  }
  keepPoints(a, 'jt', 'xy', inBox);
  // curb return lines (jc_off / jc_xy, 2D)
  const jo = a.jc_off as Uint32Array | undefined, jxy = a.jc_xy as Float32Array | undefined;
  if (jo && jxy) {
    const offs = [0], pts: number[] = [];
    for (let i = 0; i < jo.length - 1; i++) {
      if (inBox(jxy[jo[i] * 2], jxy[jo[i] * 2 + 1])) continue;
      for (let v = jo[i]; v < jo[i + 1]; v++) pts.push(jxy[v * 2], jxy[v * 2 + 1]);
      offs.push(pts.length / 2);
    }
    a.jc_off = new Uint32Array(offs); a.jc_xy = new Float32Array(pts);
  }
}
