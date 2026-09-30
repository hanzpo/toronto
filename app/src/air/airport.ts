// Runtime airport: taxi graph with shortest-path routing (runway edges are
// penalised so taxiing aircraft only cross runways), runway lookup.
import type { AirportJson, RunwayJson, StandJson } from './data';

const KIND_COST = [1, 1.15, 14, 1.5];

export class Airport {
  readonly j: AirportJson;
  readonly icao: string;
  readonly E: Float64Array;
  readonly N: Float64Array;
  readonly H: Float32Array;
  private adjOff: Int32Array;
  private adjTo: Int32Array;
  private adjCost: Float32Array;
  private routes = new Map<string, number[]>();
  private rwyByDes = new Map<string, RunwayJson>();

  constructor(j: AirportJson) {
    this.j = j;
    this.icao = j.icao;
    const n = j.nodes.length;
    this.E = new Float64Array(n); this.N = new Float64Array(n); this.H = new Float32Array(n);
    j.nodes.forEach(([e, nn, h], i) => { this.E[i] = e; this.N[i] = nn; this.H[i] = h; });
    const deg = new Int32Array(n + 1);
    for (const [a, b] of j.edges) { deg[a + 1]++; deg[b + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.adjOff = deg;
    this.adjTo = new Int32Array(deg[n]);
    this.adjCost = new Float32Array(deg[n]);
    const fill = deg.slice();
    for (const [a, b, k] of j.edges) {
      const L = Math.hypot(this.E[a] - this.E[b], this.N[a] - this.N[b]) * KIND_COST[k] + 1;
      this.adjTo[fill[a]] = b; this.adjCost[fill[a]++] = L;
      this.adjTo[fill[b]] = a; this.adjCost[fill[b]++] = L;
    }
    for (const r of j.runways) this.rwyByDes.set(r.des, r);
  }

  runway(des: string): RunwayJson | undefined { return this.rwyByDes.get(des); }
  stand(i: number): StandJson { return this.j.stands[i]; }

  /** runway designator for a stream on a given configuration */
  runwayFor(stream: string, config: number): RunwayJson {
    const cfg = this.j.configs[config] ?? this.j.configs[0];
    const des = cfg.streams[stream] ?? Object.values(cfg.streams)[0];
    return this.rwyByDes.get(des) ?? this.j.runways[0];
  }

  /** node sequence from a to b (inclusive), cached */
  route(a: number, b: number): number[] {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    let r = this.routes.get(key);
    if (!r) {
      r = this.dijkstra(a, b);
      this.routes.set(key, r);
    }
    return a < b ? r : r.slice().reverse();
  }

  private dijkstra(a: number, b: number): number[] {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const n = this.E.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap: [number, number][] = [];
    const push = (d: number, v: number) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    dist[lo] = 0;
    push(0, lo);
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      if (u === hi) break;
      for (let k = this.adjOff[u]; k < this.adjOff[u + 1]; k++) {
        const v = this.adjTo[k], nd = d + this.adjCost[k];
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
      }
    }
    if (!isFinite(dist[hi])) return [lo, hi];
    const path: number[] = [];
    for (let v = hi; v >= 0; v = prev[v]) path.push(v);
    return path.reverse();
  }
}
