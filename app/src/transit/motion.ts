// Trapezoidal (accelerate / cruise / brake) motion between two stops.

/** Typical service acceleration = braking rate per mode id (m/s²), see MODES. */
export const MODE_ACCEL = new Float32Array([1.0, 1.0, 1.1, 0.6, 0.8, 0.5, 1.2]);

/**
 * Position along a segment of length L (m) traversed in T seconds, starting and
 * ending at rest, at time tau ∈ [0, T]. Uses constant acceleration `a` up to a
 * cruise speed chosen so the segment takes exactly T; if the schedule is too
 * tight for `a` the acceleration is raised (up to 2.5·a) so the vehicle still
 * eases in and out of the stop, beyond that it runs at constant speed.
 * With `linear` the speed is constant (used for pass-through points).
 * Writes [distance, speed] into `out`.
 */
export function segmentMotion(L: number, T: number, tau: number, a: number, linear: boolean, out: Float64Array): void {
  if (T <= 0 || L <= 0) {
    out[0] = L > 0 ? L : 0;
    out[1] = 0;
    return;
  }
  if (tau <= 0) { out[0] = 0; out[1] = linear ? L / T : 0; return; }
  if (tau >= T) { out[0] = L; out[1] = linear ? L / T : 0; return; }
  if (linear) {
    out[0] = (L * tau) / T;
    out[1] = L / T;
    return;
  }
  // Too tight to start and stop at `a`: use the (higher) acceleration that just
  // fits a trapezoid with a short cruise, so vehicles still ease in and out of
  // stops instead of stopping dead from cruise speed. Beyond 2.5·a it is not a
  // plausible stop any more — run through at constant speed.
  const need = (4.5 * L) / (T * T);
  if (need > a) {
    if (need > 2.5 * a) {
      out[0] = (L * tau) / T;
      out[1] = L / T;
      return;
    }
    a = need;
  }
  const disc = a * a * T * T - 4 * a * L;
  const v = (a * T - Math.sqrt(Math.max(0, disc))) / 2;
  const ta = v / a;
  if (tau < ta) {
    out[0] = 0.5 * a * tau * tau;
    out[1] = a * tau;
  } else if (tau <= T - ta) {
    out[0] = 0.5 * a * ta * ta + v * (tau - ta);
    out[1] = v;
  } else {
    const r = T - tau;
    out[0] = L - 0.5 * a * r * r;
    out[1] = a * r;
  }
}
