// Parked-car occupancy by lot type and time of day (workers/props.ts LOT / carTag).
// Share of stalls taken: [hour, retail, work, home, 24 h, commuter].
// Retail plazas fill through the day and empty after closing (~21–22 h); workplaces and
// GO commuter lots fill 7–9 h and empty 16–19 h; homes are full overnight, half-empty by
// day; hospitals / stations stay busy around the clock.
const SCHED: number[][] = [
  [0, 0.03, 0.04, 0.9, 0.35, 0.04], [5.5, 0.03, 0.05, 0.9, 0.35, 0.06], [7, 0.06, 0.25, 0.78, 0.45, 0.45],
  [8.5, 0.15, 0.8, 0.55, 0.7, 0.92], [10, 0.3, 0.84, 0.45, 0.8, 0.95], [12.5, 0.55, 0.82, 0.45, 0.82, 0.95],
  [16, 0.55, 0.75, 0.52, 0.8, 0.88], [17.5, 0.62, 0.4, 0.7, 0.7, 0.5], [19, 0.5, 0.15, 0.82, 0.55, 0.2],
  [21, 0.3, 0.07, 0.88, 0.45, 0.08], [22.5, 0.07, 0.05, 0.9, 0.4, 0.05], [24, 0.03, 0.04, 0.9, 0.35, 0.04],
];
export const LOT_TYPES = 5;

/** stall occupancy per lot type for Toronto time `secOfDay` on `weekday` (0 = Sunday) */
export function lotOccupancy(secOfDay: number, weekday: number, out: Float32Array): Float32Array {
  const hr = (secOfDay / 3600) % 24;
  for (let i = 0; i < SCHED.length - 1; i++) {
    const a = SCHED[i], b = SCHED[i + 1];
    if (hr >= a[0] && hr <= b[0]) {
      const t = (hr - a[0]) / Math.max(1e-6, b[0] - a[0]);
      for (let k = 0; k < LOT_TYPES; k++) out[k] = a[k + 1] + (b[k + 1] - a[k + 1]) * t;
      break;
    }
  }
  if (weekday === 0 || weekday === 6) {
    out[0] = Math.min(0.95, out[0] * 1.25); // weekend shopping
    out[1] = Math.min(out[1], 0.04 + out[1] * 0.2);
    out[2] = Math.max(out[2], 0.7);
    out[4] = Math.min(out[4], 0.12);
  }
  return out;
}
