// Shared screen-space label declutter for the DOM label layers (stations,
// municipalities). Layers submit their candidate labels each frame (anchor
// pixel, priority, wanted opacity); the board places them greedily by
// priority, hides the ones that would overlap an already placed label, and
// eases every label's opacity toward its target so they fade in/out instead
// of popping. Resolution runs once per frame in a microtask after all layers
// have submitted (before the browser paints).
import type { Engine } from '../engine/Engine';

interface Item {
  el: HTMLElement;
  x: number;
  y: number;
  /** anchor as a fraction of the label size (0,0 = top-left at the point; -0.5,-1 = centred above) */
  ax: number;
  ay: number;
  /** extra px offset applied after the anchor */
  dy: number;
  prio: number;
  want: number;
  cur: number;
  w: number;
  h: number;
  pad: number;
  seen: number;
  shownTf: string;
  shownOp: string;
}

class LabelBoard {
  private items = new Map<HTMLElement, Item>();
  private frame = 0;
  private scheduled = false;
  private last = performance.now();

  /** Offer a label for this frame. `want` = opacity it would have without declutter. */
  submit(el: HTMLElement, x: number, y: number, prio: number, want: number, opts: { ax?: number; ay?: number; dy?: number; pad?: number } = {}) {
    let it = this.items.get(el);
    if (!it) {
      it = { el, x, y, ax: -0.5, ay: -0.5, dy: 0, prio, want, cur: 0, w: 0, h: 0, pad: 4, seen: -1, shownTf: '', shownOp: '' };
      this.items.set(el, it);
    }
    if (!it.w) { it.w = el.offsetWidth || 60; it.h = el.offsetHeight || 16; }
    it.x = x; it.y = y; it.prio = prio; it.want = want;
    it.ax = opts.ax ?? -0.5; it.ay = opts.ay ?? -0.5; it.dy = opts.dy ?? 0; it.pad = opts.pad ?? 4;
    it.seen = this.frame;
    this.schedule();
  }

  /** Forget a label (element removed from the DOM). */
  remove(el: HTMLElement) {
    this.items.delete(el);
  }

  /** The label's content changed size: re-measure next frame. */
  invalidate(el: HTMLElement) {
    const it = this.items.get(el);
    if (it) it.w = 0;
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush() {
    this.scheduled = false;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const live: Item[] = [];
    for (const it of this.items.values()) if (it.seen === this.frame && it.want > 0.02) live.push(it);
    live.sort((a, b) => b.prio - a.prio);
    const placed: number[] = []; // x0 y0 x1 y1
    const shown = new Set<Item>();
    for (const it of live) {
      const x0 = it.x + it.ax * it.w - it.pad, y0 = it.y + it.ay * it.h + it.dy - it.pad;
      const x1 = x0 + it.w + 2 * it.pad, y1 = y0 + it.h + 2 * it.pad;
      let hit = false;
      for (let k = 0; k < placed.length; k += 4) {
        if (x0 < placed[k + 2] && x1 > placed[k] && y0 < placed[k + 3] && y1 > placed[k + 1]) { hit = true; break; }
      }
      if (hit) continue;
      placed.push(x0, y0, x1, y1);
      shown.add(it);
    }
    const k = 1 - Math.exp(-dt * 8);
    for (const it of this.items.values()) {
      const target = shown.has(it) ? it.want : 0;
      it.cur += (target - it.cur) * k;
      if (Math.abs(target - it.cur) < 0.01) it.cur = target;
      const op = it.cur < 0.02 ? '0' : it.cur.toFixed(2);
      if (op !== it.shownOp) {
        it.el.style.opacity = op;
        it.el.style.visibility = op === '0' ? 'hidden' : '';
        it.shownOp = op;
      }
      if (op !== '0' && it.seen === this.frame) {
        const tf = `translate(${(it.x + it.ax * it.w).toFixed(1)}px, ${(it.y + it.ay * it.h + it.dy).toFixed(1)}px)`;
        if (tf !== it.shownTf) { it.el.style.transform = tf; it.shownTf = tf; }
      }
    }
    this.frame++;
  }
}

export const labelBoard = new LabelBoard();

/**
 * Line of sight from the camera to a world point (E, N, elevation): false when
 * terrain or a (loaded) building volume is in between. The last `skipEnd`
 * metres before the point are not tested (the label sits on/above its own
 * building).
 */
export function visibleFrom(engine: Engine, cx: number, cy: number, cz: number, e: number, n: number, h: number, skipEnd = 40): boolean {
  const ce = cx, cn = -cz, ch = cy;
  const de = e - ce, dn = n - cn, dh = h - ch;
  const L = Math.hypot(de, dn, dh);
  if (L < skipEnd + 1) return true;
  // dense near the camera (a single wall next to the eye hides everything),
  // sparser with distance
  const tEnd = L - skipEnd;
  let k = 0;
  for (let t = 2; t < tEnd && k < 90; t += Math.max(3, t * 0.06), k++) {
    const f = t / L;
    const pe = ce + de * f, pn = cn + dn * f, ph = ch + dh * f;
    if (engine.heightAt(pe, pn) > ph + 1) return false;
    if (engine.buildings && engine.buildings.topAt(pe, pn, ph) > ph) return false;
  }
  return true;
}
