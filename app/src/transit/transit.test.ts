// Sanity test against the generated data:  node app/src/transit/transit.test.ts
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODES, type Mode, type Profile } from './format.ts';
import { TransitSystem, STATE_DWELL, type TransitLoader } from './TransitSystem.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/data/transit/');

function fsLoader(dir: string): TransitLoader {
  return {
    async json(file) {
      return JSON.parse(readFileSync(dir + file, 'utf8'));
    },
    async binary(file) {
      if (!existsSync(dir + file)) return null;
      const b = gunzipSync(readFileSync(dir + file));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
}

const hms = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;

function countByMode(ts: TransitSystem, t: number): Record<string, number> {
  const v = ts.evaluate(t);
  const c: Record<string, number> = {};
  for (let i = 0; i < v.count; i++) c[MODES[v.mode[i]]] = (c[MODES[v.mode[i]]] ?? 0) + 1;
  return c;
}

function countRoute(ts: TransitSystem, t: number, routeId: string, bus = false): number {
  const r = ts.routeIndex(routeId);
  const v = ts.evaluate(t);
  let n = 0;
  for (let i = 0; i < v.count; i++) if (v.route[i] === r && (v.mode[i] === 6) === bus) n++;
  return n;
}

function distToPolyline(x: number, y: number, xyz: Float32Array): number {
  let best = Infinity;
  for (let v = 0; v + 1 < xyz.length / 3; v++) {
    const ax = xyz[3 * v], ay = xyz[3 * v + 1], bx = xyz[3 * v + 3], by = xyz[3 * v + 4];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const ex = ax + dx * t - x, ey = ay + dy * t - y;
    best = Math.min(best, Math.hypot(ex, ey));
  }
  return best;
}

async function main() {
  const ts = new TransitSystem(fsLoader(DIR));
  let t0 = performance.now();
  await ts.load('weekday');
  console.log(`loaded weekday: ${ts.feedsInfo().length} files, ${ts.tripCount} trips, ${ts.stopCount} stops in ${(performance.now() - t0).toFixed(0)} ms`);

  const report: [Profile, number][] = [['weekday', 8 * 3600], ['weekday', 17.5 * 3600], ['weekday', 23.5 * 3600]];
  for (const [, t] of report) console.log(`  weekday ${hms(t)}`, JSON.stringify(countByMode(ts, t)));

  // --- counts at 08:00
  const c8 = countByMode(ts, 8 * 3600);
  const l1 = countRoute(ts, 8 * 3600, 'ttc:1');
  const l2 = countRoute(ts, 8 * 3600, 'ttc:2');
  console.log(`  Line 1 trains @08:00: ${l1}, Line 2: ${l2}`);
  check(l1 >= 45 && l1 <= 75, 'Line 1 has ~50-70 trains at 08:00');
  check((c8.commuter_rail ?? 0) >= 25, 'GO trains: dozens at 08:00');
  check((c8.bus ?? 0) >= 2500, 'buses in service (all agencies) at 08:00 >= 2500');
  let ttcBus = 0;
  {
    const v = ts.evaluate(8 * 3600);
    for (let i = 0; i < v.count; i++) if (v.mode[i] === 6 && ts.routes[v.route[i]].agency === 'ttc') ttcBus++;
  }
  console.log(`  TTC buses @08:00: ${ttcBus}`);
  // in-service trips only: terminal layovers between trips are not vehicles (~15-20% of the fleet)
  check(ttcBus >= 1150, 'TTC buses in service >= 1150 at 08:00 (~1500 incl. layovers)');
  check((c8.streetcar ?? 0) >= 100, 'TTC streetcars > 100 at 08:00');
  check((c8.lrt ?? 0) >= 10, 'LRT vehicles present at 08:00');
  check((c8.airport_rail ?? 0) >= 2, 'UP Express present');

  // --- no NaNs, positions on shape
  {
    const v = ts.evaluate(8 * 3600);
    let bad = 0;
    for (let i = 0; i < v.count; i++) {
      if (!Number.isFinite(v.x[i]) || !Number.isFinite(v.y[i]) || !Number.isFinite(v.z[i]) || !Number.isFinite(v.heading[i]) || !Number.isFinite(v.speed[i]) || !Number.isFinite(v.pitch[i])) bad++;
    }
    check(bad === 0, `no NaN in ${v.count} vehicles`);
    // position within 5 m of a route polyline (sampled)
    const lines = new Map<number, Float32Array[]>();
    for (const rl of ts.routeLines()) lines.set(rl.route, rl.lines);
    let worst = 0;
    const step = Math.max(1, Math.floor(v.count / 400));
    for (let i = 0; i < v.count; i += step) {
      const d = Math.min(...(lines.get(v.route[i]) ?? []).map((l) => distToPolyline(v.x[i], v.y[i], l)));
      worst = Math.max(worst, d);
    }
    check(worst < 5, `sampled vehicles within 5 m of their route shape (worst ${worst.toFixed(2)} m)`);
    let maxSpeed = 0;
    for (let i = 0; i < v.count; i++) if (v.mode[i] !== 5) maxSpeed = Math.max(maxSpeed, v.speed[i]);
    console.log(`  max speed (non-VIA) ${maxSpeed.toFixed(1)} m/s`);
  }

  // --- monotone progress + dwell behaviour on sampled trips
  {
    const v = ts.evaluate(8 * 3600);
    const trips = Array.from(v.trip.subarray(0, v.count)).filter((_, i) => i % 97 === 0);
    let nonMono = 0, dwellSeen = 0;
    for (const trip of trips) {
      let prev = -1;
      for (let t = 8 * 3600; t < 8 * 3600 + 1800; t += 5) {
        const s = ts.vehicleAt(trip, t);
        if (!s) break;
        if (s.dist < prev - 1e-3) nonMono++;
        if (s.state === STATE_DWELL) dwellSeen++;
        prev = s.dist;
      }
    }
    check(nonMono === 0, `monotone progress on ${trips.length} sampled trips`);
    check(dwellSeen > 0, 'vehicles dwell at stops');
  }

  // --- midnight wraparound
  {
    const v = ts.evaluate(20 * 60);
    let prevDay = 0;
    for (let i = 0; i < v.count; i++) {
      const info = ts.tripInfo(v.trip[i])!;
      if (info.start > 20 * 60 + 3600) prevDay++;
    }
    console.log(`  00:20 active ${v.count}, from previous service day ${prevDay}`);
    check(prevDay > 50, 'previous-day trips running after midnight are included');
    // continuity: evaluate(t) for t just after midnight == evaluate(t + 86400) for those trips
    const a = ts.evaluate(600);
    const mapA = new Map<number, number>();
    for (let i = 0; i < a.count; i++) mapA.set(a.trip[i], a.x[i]);
    const b = ts.evaluate(600 + 86400);
    let same = 0, diff = 0;
    for (let i = 0; i < b.count; i++) {
      const xa = mapA.get(b.trip[i]);
      if (xa === undefined) continue;
      if (Math.abs(xa - b.x[i]) < 1e-6) same++; else diff++;
    }
    check(same > 0 && diff === 0, `wraparound consistent (${same} trips match between t=600 and t=87000)`);
  }

  // --- queries
  {
    const v = ts.evaluate(8 * 3600);
    const i = Array.from(v.mode.subarray(0, v.count)).indexOf(3);
    const info = ts.tripInfo(v.trip[i])!;
    console.log(`  sample GO trip: ${info.routeMeta.short} ${info.name} → ${info.headsign}, ${info.stops.length} stops, ${hms(info.start)}–${hms(info.end)}`);
    const st = info.stops[Math.floor(info.stops.length / 2)];
    const arr = ts.arrivalsAt(st.stop, 8 * 3600, 5);
    console.log(`  next at ${st.name}:`, arr.map((a) => `${ts.routes[a.route].short} ${hms(a.dep)} ${a.headsign}`).join(' | '));
    check(arr.length > 0 && arr[0].dep >= 8 * 3600, 'arrivalsAt returns upcoming departures');
    const ml = ts.linesByMode('subway');
    console.log(`  subway overlay: ${ml.offsets.length - 1} polylines, ${ml.xyz.length / 3} vertices`);
    check(ml.offsets.length > 3, 'linesByMode(subway) has polylines');
    const stops = ts.stops({ modes: ['subway', 'lrt', 'commuter_rail', 'airport_rail', 'intercity_rail'] });
    console.log(`  rail stops: ${stops.index.length}`);
  }

  // --- timing
  {
    let n = 0;
    t0 = performance.now();
    const runs = 200;
    for (let k = 0; k < runs; k++) n += ts.evaluate(7 * 3600 + k * 17).count;
    const ms = (performance.now() - t0) / runs;
    console.log(`  evaluate(): ${ms.toFixed(2)} ms avg for ~${Math.round(n / runs)} vehicles`);
    check(ms < 3, 'evaluate() under 3 ms');
  }

  // --- Sunday
  const tsSun = new TransitSystem(fsLoader(DIR));
  await tsSun.load('sunday');
  console.log(`  sunday 14:00`, JSON.stringify(countByMode(tsSun, 14 * 3600)));
  check(TransitSystem.profileForDate(new Date(2026, 9, 4)) === 'sunday', 'profileForDate(Sun)');

  // --- mode filter
  ts.setModes(['subway'] as Mode[]);
  const onlySub = countByMode(ts, 8 * 3600);
  check(Object.keys(onlySub).length === 1 && onlySub.subway > 0, 'setModes filters evaluate()');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

main();
