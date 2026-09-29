// Trapezoidal (accelerate / cruise / brake) motion between two stops.

/** Typical service acceleration = braking rate per mode id (m/s²), see MODES. */
export const MODE_ACCEL = new Float32Array([1.0, 1.0, 1.1, 0.6, 0.8, 0.5, 1.2]);

/**
 * Position along a segment of length L (m) traversed in T seconds, starting and
 * ending at rest, at time tau ∈ [0, T]. Uses constant acceleration `a` up to a
 * cruise speed chosen so the segment takes exactly T; if even a triangular
 * profile at `a` cannot cover L in T the segment is run at constant speed.
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
  let v: number;
  let ta: number;
  const disc = a * a * T * T - 4 * a * L;
  if (disc >= 0) {
    v = (a * T - Math.sqrt(disc)) / 2;
    ta = v / a;
  } else {
    // schedule too tight to start and stop at `a`: run through at constant speed
    // (a triangular profile would peak at twice the average speed)
    out[0] = (L * tau) / T;
    out[1] = L / T;
    return;
  }
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
