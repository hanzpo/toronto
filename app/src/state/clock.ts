// Simulation clock. Mutable singleton advanced by the render loop (no React in
// the per-frame path). Time is UTC epoch ms; helpers convert to/from
// America/Toronto wall-clock time (DST aware).

export type DayType = 'weekday' | 'saturday' | 'sunday';

export const TZ = 'America/Toronto';
export const SPEEDS = [0, 1, 10, 60, 300, 1800, 3600] as const;

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
});

export interface TorontoParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: number; // 0 = Sunday
  secOfDay: number;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let cacheKey = -1;
let cacheVal: TorontoParts | null = null;

/** Wall-clock parts in Toronto for a UTC ms timestamp (cached per second). */
export function torontoParts(ms: number): TorontoParts {
  const key = Math.floor(ms / 1000);
  if (key === cacheKey && cacheVal) {
    return cacheVal;
  }
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  const hour = +p.hour, minute = +p.minute, second = +p.second;
  cacheVal = {
    year: +p.year, month: +p.month, day: +p.day, hour, minute, second,
    weekday: WD[p.weekday] ?? 0,
    secOfDay: hour * 3600 + minute * 60 + second + (ms % 1000) / 1000,
  };
  cacheKey = key;
  return cacheVal;
}

/** Toronto UTC offset in minutes (e.g. -240 in summer) at the given instant. */
export function torontoOffsetMin(ms: number): number {
  const p = torontoParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** UTC ms for a Toronto wall-clock date + seconds since local midnight. */
export function torontoToUtc(year: number, month: number, day: number, secOfDay: number): number {
  const guess = Date.UTC(year, month - 1, day) + secOfDay * 1000;
  let off = torontoOffsetMin(guess);
  let ms = guess - off * 60000;
  off = torontoOffsetMin(ms);
  ms = guess - off * 60000;
  return ms;
}

export function dayTypeOf(weekday: number): DayType {
  return weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'weekday';
}

function defaultStart(): number {
  // Today in Toronto at 08:15 (morning rush).
  const p = torontoParts(Date.now());
  return torontoToUtc(p.year, p.month, p.day, 8 * 3600 + 15 * 60);
}

export const clock = {
  /** Simulation time, UTC epoch ms. */
  simMs: defaultStart(),
  /** Seconds of sim time advanced during the last frame. */
  lastDtSim: 0,

  advance(dtReal: number, speed: number) {
    this.lastDtSim = dtReal * speed;
    this.simMs += this.lastDtSim * 1000;
  },
  set(ms: number) {
    this.simMs = ms;
  },
  parts(): TorontoParts {
    return torontoParts(this.simMs);
  },
  /** Set Toronto time-of-day (seconds since local midnight) keeping the date. */
  setTimeOfDay(secOfDay: number) {
    const p = torontoParts(this.simMs);
    this.simMs = torontoToUtc(p.year, p.month, p.day, secOfDay);
  },
  /**
   * Service day (GTFS-style): the local date whose midnight the current time is
   * measured from, plus seconds since that midnight. Times after midnight but
   * before `rollover` (default 04:00) belong to the previous service day, so
   * seconds may exceed 86400.
   */
  serviceDay(rolloverSec = 4 * 3600): { year: number; month: number; day: number; weekday: number; sec: number } {
    const p = torontoParts(this.simMs);
    if (p.secOfDay >= rolloverSec) {
      return { year: p.year, month: p.month, day: p.day, weekday: p.weekday, sec: p.secOfDay };
    }
    const prev = torontoParts(this.simMs - 86400_000);
    return { year: prev.year, month: prev.month, day: prev.day, weekday: prev.weekday, sec: p.secOfDay + 86400 };
  },
};
