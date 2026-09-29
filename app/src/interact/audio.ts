// Tiny WebAudio cues: TTC-style door chime, horn / streetcar bell.
let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, t0: number, dur: number, type: OscillatorType = 'sine', gain = 0.12) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = c.currentTime + t0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Three descending notes, like the TTC "doors closing" chime. */
export function doorChime() {
  tone(1318.5, 0, 0.5); tone(1046.5, 0.22, 0.5); tone(880, 0.44, 0.9);
}

export function doorsOpen() {
  tone(880, 0, 0.25, 'sine', 0.06); tone(1174.7, 0.12, 0.35, 'sine', 0.06);
}

export function horn(mode: string) {
  if (mode === 'streetcar') {
    for (let i = 0; i < 2; i++) { tone(2093, i * 0.18, 0.35, 'triangle', 0.08); tone(2637, i * 0.18, 0.3, 'sine', 0.05); }
    return;
  }
  // two-tone air horn
  tone(311, 0, 0.9, 'sawtooth', 0.05); tone(370, 0, 0.9, 'sawtooth', 0.05);
}

export function beep() {
  tone(1760, 0, 0.12, 'square', 0.03);
}
