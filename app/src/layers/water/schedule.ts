// Toronto Island ferry + Billy Bishop airport ferry timetables and vessel
// rostering, plus the seasonal / time-of-day / weather "boating" factors.
//
// Sources:
//   City of Toronto, "Ferry Routes & Schedules"
//   (toronto.ca/explore-enjoy/toronto-island-ferries/ferry-routes-schedules/),
//   fetched 2026-09-30:
//     Fall   Sep 16 – Oct 13: all three routes, tables below (verbatim)
//     Winter Oct 14 – mid-April: Ward's Island only, table below (verbatim)
//     Spring (mid-April – mid-May) "reduced trips on all three routes" — the
//       fall tables stand in until the City posts the spring table.
//     Summer (mid-May – mid-Sept): Centre Island 8:00 a.m. – 11:30 p.m. every
//       15–30 min (extra weekend/holiday service), Hanlan's 6:45 a.m. – 10:15
//       p.m., Ward's 6:30 a.m. – 10:45 p.m.; generated at those headways.
//   PortsToronto: Billy Bishop airport ferry (Marilyn Bell I) every 15 min,
//     5:15 a.m. – midnight, ~90 s crossing of the Western Gap (121 m).
//   Fleet roles: Wikipedia "Toronto Island ferries" (Ongiara = winter + vehicle
//     service, Trillium = summer peak/charters, Maple City = airport standby).
import type { BoatKey } from '../../models/boats';

export type Season = 'winter' | 'spring' | 'summer' | 'fall';
export type RouteId = 'centre' | 'hanlans' | 'wards';

const hm = (s: string) => {
  // "8:00 a.m." / "12:40 p.m."
  const m = /(\d+):(\d+)\s*([ap])/.exec(s)!;
  let h = +m[1] % 12;
  if (m[3] === 'p') h += 12;
  return h * 3600 + +m[2] * 60;
};
const list = (s: string) => s.split(',').map((x) => hm(x.trim()));

interface Table { city: number[]; island: number[] }

const FALL: Record<RouteId, Table> = {
  centre: {
    city: list('8:00 a, 8:30 a, 9:00 a, 10:00 a, 10:40 a, 11:20 a, 12:40 p, 1:20 p, 2:20 p, 3:00 p, 4:00 p, 4:40 p, 5:20 p, 6:20 p, 7:00 p, 7:40 p, 9:00 p, 9:40 p, 11:00 p, 11:30 p'),
    island: list('8:15 a, 8:45 a, 9:15 a, 10:20 a, 11:00 a, 11:40 a, 1:00 p, 1:40 p, 2:40 p, 3:20 p, 4:20 p, 5:00 p, 5:40 p, 6:40 p, 7:20 p, 8:00 p, 9:20 p, 10:00 p, 11:15 p, 11:45 p'),
  },
  hanlans: {
    city: list('6:45 a, 7:15 a, 7:45 a, 8:30 a, 9:15 a, 10:15 a, 11:15 a, 12:15 p, 1:15 p, 2:15 p, 3:15 p, 3:45 p, 4:45 p, 5:15 p, 5:45 p, 6:45 p, 7:15 p, 7:45 p, 8:15 p, 9:15 p, 9:45 p, 10:15 p'),
    island: list('7:00 a, 7:30 a, 8:00 a, 8:45 a, 9:30 a, 10:30 a, 11:30 a, 12:30 p, 1:30 p, 2:30 p, 3:30 p, 4:00 p, 5:00 p, 5:30 p, 6:00 p, 7:00 p, 7:30 p, 8:00 p, 8:30 p, 9:30 p, 10:00 p, 10:30 p'),
  },
  wards: {
    city: list('6:30 a, 7:00 a, 7:30 a, 8:15 a, 9:00 a, 9:30 a, 10:30 a, 11:30 a, 12:30 p, 1:30 p, 2:30 p, 3:30 p, 4:30 p, 5:30 p, 6:30 p, 7:30 p, 8:30 p, 9:30 p, 10:30 p, 11:30 p'),
    island: list('6:45 a, 7:15 a, 7:45 a, 8:30 a, 9:15 a, 9:45 a, 10:45 a, 11:45 a, 12:45 p, 1:45 p, 2:45 p, 3:45 p, 4:45 p, 5:45 p, 6:45 p, 7:45 p, 8:45 p, 9:45 p, 10:45 p, 11:45 p'),
  },
};

const WINTER_WARDS: Table = {
  city: list('6:30 a, 7:00 a, 7:30 a, 8:15 a, 9:00 a, 9:30 a, 10:30 a, 11:30 a, 12:30 p, 1:30 p, 2:30 p, 3:45 p, 4:15 p, 5:30 p, 6:30 p, 7:30 p, 8:30 p, 9:30 p, 10:30 p, 11:30 p'),
  island: list('6:45 a, 7:15 a, 7:45 a, 8:30 a, 9:15 a, 9:45 a, 10:45 a, 11:45 a, 12:45 p, 1:45 p, 2:45 p, 4:00 p, 4:45 p, 5:45 p, 6:45 p, 7:45 p, 8:45 p, 9:45 p, 10:45 p, 11:45 p'),
};

/** departures every `step` min in [from, to] (h:mm strings), island legs `back` min later */
function every(spans: [string, string, number][], back = 15): Table {
  const city: number[] = [];
  for (const [a, b, step] of spans) {
    const t0 = hm(a), t1 = hm(b);
    for (let t = t0; t <= t1; t += step * 60) if (!city.includes(t)) city.push(t);
  }
  city.sort((x, y) => x - y);
  return { city, island: city.map((t) => t + back * 60) };
}

function summer(weekend: boolean): Record<RouteId, Table> {
  return {
    centre: weekend
      ? every([['8:00 a', '9:00 a', 30], ['9:00 a', '9:00 p', 15], ['9:30 p', '11:30 p', 30]])
      : every([['8:00 a', '10:00 a', 30], ['10:00 a', '7:00 p', 15], ['7:30 p', '11:30 p', 30]]),
    hanlans: every([['6:45 a', '10:15 p', 30]]),
    wards: every([['6:30 a', '10:45 p', 30]]),
  };
}

export function seasonOf(month: number, day: number): Season {
  const md = month * 100 + day;
  if (md >= 1014 || md < 415) return 'winter';
  if (md < 516) return 'spring';
  if (md < 916) return 'summer';
  return 'fall';
}

export interface Trip {
  route: RouteId;
  vessel: string;
  /** seconds since local midnight */
  dep: number; arr: number; depBack: number; arrBack: number;
}

export interface Vessel { name: string; model: BoatKey; note: string }
export const VESSELS: Record<string, Vessel> = {
  'Sam McBride': { name: 'Sam McBride', model: 'ferryBig', note: 'Toronto Island ferry (1939)' },
  'Thomas Rennie': { name: 'Thomas Rennie', model: 'ferryBig', note: 'Toronto Island ferry (1951)' },
  'William Inglis': { name: 'William Inglis', model: 'ferryInglis', note: 'Toronto Island ferry (1935)' },
  Ongiara: { name: 'Ongiara', model: 'ongiara', note: 'Toronto Island vehicle ferry (1963)' },
  Trillium: { name: 'Trillium', model: 'trillium', note: 'sidewheel paddle steamer (1910)' },
  'Marilyn Bell I': { name: 'Marilyn Bell I', model: 'marilynBell', note: 'Billy Bishop airport ferry (2009)' },
};

export const ROUTE_NAME: Record<RouteId, string> = { centre: 'Centre Island', hanlans: "Hanlan's Point", wards: "Ward's Island" };
/** nominal crossing times (s) */
const CROSS: Record<RouteId, number> = { centre: 13 * 60, hanlans: 11 * 60, wards: 12 * 60 };

function fleet(season: Season, weekend: boolean): Record<RouteId, string[]> {
  if (season === 'winter') return { centre: [], hanlans: [], wards: ['Ongiara'] };
  if (season === 'summer') return {
    centre: weekend ? ['Sam McBride', 'Thomas Rennie', 'Trillium'] : ['Sam McBride', 'Thomas Rennie'],
    hanlans: ['William Inglis'],
    wards: ['Ongiara'],
  };
  return { centre: ['Thomas Rennie', 'Sam McBride'], hanlans: ['William Inglis'], wards: ['Ongiara'] };
}

function tables(season: Season, weekend: boolean): Record<RouteId, Table> {
  if (season === 'winter') return { centre: { city: [], island: [] }, hanlans: { city: [], island: [] }, wards: WINTER_WARDS };
  if (season === 'summer') return summer(weekend);
  return FALL;
}

export interface DayPlan { season: Season; trips: Trip[]; idle: string[] }

/**
 * Roster one service day: every city departure gets the first vessel of the
 * route's fleet that is back at the terminal, its return leg is the first
 * island departure after it arrives. Crossing time = nominal, shortened when
 * the timetable leaves less (≥ 2 min at each dock).
 */
export function planDay(month: number, day: number, weekday: number): DayPlan {
  const season = seasonOf(month, day);
  const weekend = weekday === 0 || weekday === 6;
  const T = tables(season, weekend), Fl = fleet(season, weekend);
  const trips: Trip[] = [];
  const used = new Set<string>();
  for (const r of Object.keys(T) as RouteId[]) {
    const { city, island } = T[r];
    const names = Fl[r];
    if (!names.length || !city.length) continue;
    const free = new Map(names.map((n) => [n, 0]));
    const taken = new Set<number>();
    for (let i = 0; i < city.length; i++) {
      const dep = city[i];
      // first vessel back at the terminal (else the one back earliest)
      let v = names[0], best = Infinity;
      for (const n of names) { const f = free.get(n)!; if (f <= dep) { v = n; best = -1; break; } if (f < best) { best = f; v = n; } }
      const nextIsland = island.find((t, j) => !taken.has(j) && t >= dep + 5 * 60);
      const arr = dep + Math.min(CROSS[r], (nextIsland ?? dep + 3600) - dep - 120);
      let jBack = island.findIndex((t, j) => !taken.has(j) && t >= arr + 60);
      if (jBack < 0) jBack = -1;
      const depBack = jBack >= 0 ? island[jBack] : arr + 5 * 60;
      if (jBack >= 0) taken.add(jBack);
      const nextCity = city.find((t) => t > depBack);
      const arrBack = depBack + Math.min(CROSS[r], nextCity !== undefined ? Math.max(5 * 60, nextCity - depBack - 120) : CROSS[r]);
      trips.push({ route: r, vessel: v, dep, arr, depBack, arrBack });
      free.set(v, arrBack + 60);
      used.add(v);
    }
  }
  const idle = ['Sam McBride', 'Thomas Rennie', 'William Inglis', 'Ongiara'].filter((n) => !used.has(n));
  return { season, trips, idle };
}

/** Billy Bishop airport ferry: departs the Bathurst St. terminal every 15 min, 5:15 a.m. – midnight. */
export const AIRPORT = { first: 5 * 3600 + 15 * 60, last: 24 * 3600, headway: 15 * 60, cross: 90, backOffset: 7.5 * 60 };

// --------------------------------------------------------------------------- activity factors
const MONTH_BOATING = [0, 0, 0, 0.04, 0.3, 0.8, 1, 1, 0.62, 0.2, 0.02, 0]; // Jan..Dec
/** fraction of marina slips with a boat in the water (haul-out Nov – Apr) */
const MONTH_AFLOAT = [0.03, 0.03, 0.03, 0.12, 0.6, 0.92, 0.95, 0.95, 0.9, 0.55, 0.12, 0.03];

export interface Weather { good: number; windDir: number; wind: number; label: string }

/** Deterministic daily "boating weather" (no global weather model yet). */
export function weatherOf(year: number, month: number, day: number, hash: (a: number, b: number, c: number) => number): Weather {
  const r = hash(year, month * 37 + day, 11);
  const good = r < 0.62 ? 1 : r < 0.85 ? 0.6 : 0.15;
  // prevailing SW-W wind over Lake Ontario, knots 4-18
  const windDir = (200 + 90 * hash(year, month * 37 + day, 12)) * Math.PI / 180; // direction wind blows FROM (compass)
  const wind = 2 + 7 * hash(year, month * 37 + day, 13); // m/s
  return { good, windDir, wind, label: good === 1 ? 'fair' : good > 0.5 ? 'cloudy' : 'rain' };
}

/** 0..1 pleasure-boat activity for this time (season × hour × weekday × weather). */
export function boatingFactor(month: number, weekday: number, hour: number, weather: Weather) {
  const m = MONTH_BOATING[month - 1];
  const h = hour < 6 ? 0.01 : hour < 10 ? 0.02 + 0.98 * ((hour - 6) / 4) ** 1.5 : hour < 18.5 ? 1 : hour < 21.5 ? 1 - 0.9 * ((hour - 18.5) / 3) : 0.06;
  const wd = weekday === 0 || weekday === 6 ? 1 : 0.5;
  return m * h * wd * weather.good;
}

export function afloatFraction(month: number) {
  return MONTH_AFLOAT[month - 1];
}

/** St. Lawrence Seaway navigation season (late March – end of December). */
export function seawayOpen(month: number, day: number) {
  const md = month * 100 + day;
  return md >= 322 && md <= 1231;
}
