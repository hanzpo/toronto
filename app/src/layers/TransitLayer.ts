// Schedule-driven transit: route lines (analytics) + every active vehicle.
// Positions come straight from the timetable at the current sim time, so
// scrubbing/speeding the clock needs no simulation state.
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { LineOverlay } from '../render/overlay/LineOverlay';
import { MarkerOverlay } from '../render/overlay/MarkerOverlay';
import { clock } from '../state/clock';
import { useApp, type AnalyticsKey } from '../state/store';
import { MODES, TransitSystem, fetchLoader, type Mode, type Profile } from '../transit';

interface ModeStyle {
  key: AnalyticsKey;
  /** real vehicle size [length, height, width] m */
  size: [number, number, number];
  lineWidth: number;
  minPixels: number;
  shape: 'train' | 'bus';
}

const STYLE: Record<Mode, ModeStyle> = {
  subway: { key: 'subway', size: [138, 3.7, 3.1], lineWidth: 5, minPixels: 9, shape: 'train' },
  lrt: { key: 'lrt', size: [60, 3.7, 2.65], lineWidth: 4, minPixels: 8, shape: 'train' },
  streetcar: { key: 'streetcar', size: [30.2, 3.8, 2.54], lineWidth: 2.5, minPixels: 6, shape: 'train' },
  commuter_rail: { key: 'go', size: [305, 4.8, 3.0], lineWidth: 4, minPixels: 10, shape: 'train' },
  airport_rail: { key: 'upx', size: [76, 4.3, 3.1], lineWidth: 4, minPixels: 8, shape: 'train' },
  intercity_rail: { key: 'via', size: [180, 4.3, 3.1], lineWidth: 3, minPixels: 9, shape: 'train' },
  bus: { key: 'bus', size: [12.2, 3.2, 2.6], lineWidth: 1.2, minPixels: 3, shape: 'bus' },
};

const MODE_LIST = Object.keys(STYLE) as Mode[];
/** transit MODE_ID (index into MODES) -> Mode */
const MODE_LIST_BY_ID: readonly Mode[] = MODES;

function hex(c: string): number {
  return parseInt(c.replace('#', ''), 16) || 0x888888;
}

export class TransitLayer implements Layer {
  readonly id = 'transit';
  readonly system: TransitSystem;
  private lines = new Map<Mode, LineOverlay>();
  private markers = new Map<Mode, MarkerOverlay>();
  private routeColor: number[] = [];
  private profile: Profile | null = null;
  private loading = false;
  private linesBuilt = new Set<Mode>();
  private ready = false;

  constructor(dataRoot: string) {
    this.system = new TransitSystem(fetchLoader(`${dataRoot}/transit/`));
  }

  async init(engine: Engine) {
    await this.system.loadIndex();
    for (const m of MODE_LIST) {
      const s = STYLE[m];
      this.lines.set(m, new LineOverlay(engine, { name: `lines-${m}`, width: s.lineWidth, lift: 3, order: m === 'bus' ? 1 : 2 }));
      this.markers.set(m, new MarkerOverlay(engine, {
        name: `veh-${m}`, capacity: m === 'bus' ? 6000 : 800, shape: s.shape, size: s.size,
        minPixels: s.minPixels, lift: 0.2,
      }));
    }
    this.ready = true;
    void this.ensureProfile();
  }

  private currentProfile(): Profile {
    const o = useApp.getState().dayTypeOverride;
    if (o) return o;
    const wd = clock.serviceDay().weekday;
    return wd === 0 ? 'sunday' : wd === 6 ? 'saturday' : 'weekday';
  }

  private async ensureProfile() {
    const p = this.currentProfile();
    if (p === this.profile || this.loading) return;
    this.loading = true;
    try {
      await this.system.load(p, { onFeed: () => this.onFeedLoaded() });
      this.profile = p;
      this.onFeedLoaded();
    } finally {
      this.loading = false;
    }
  }

  private onFeedLoaded() {
    this.routeColor = this.system.routes.map((r) => hex(r.color));
    this.linesBuilt.clear();
  }

  private buildLines(mode: Mode) {
    const overlay = this.lines.get(mode)!;
    const specs = this.system.routeLines({ modes: [mode] }).flatMap((rl) =>
      rl.lines.map((pts, i) => ({ id: `${rl.meta.id}:${i}`, points: pts, color: hex(rl.meta.color) })),
    );
    overlay.set(specs);
    this.linesBuilt.add(mode);
  }

  update(ctx: FrameContext) {
    if (!this.ready) return;
    if (!this.loading && this.currentProfile() !== this.profile) void this.ensureProfile();
    const st = useApp.getState();
    const an = st.analytics;
    // route lines per analytics toggle
    for (const m of MODE_LIST) {
      const on = an[STYLE[m].key];
      const ov = this.lines.get(m)!;
      if (on && !this.linesBuilt.has(m) && this.system.tripCount > 0) this.buildLines(m);
      ov.setVisible(on);
      ov.update(ctx);
    }
    // vehicles
    const counts = new Map<Mode, number>();
    for (const m of MODE_LIST) counts.set(m, 0);
    if (an.vehicles && this.system.tripCount > 0) {
      const v = this.system.evaluate(clock.serviceDay().sec);
      const near = ctx.altitude < 3000;
      for (let i = 0; i < v.count; i++) {
        const mode = MODE_LIST_BY_ID[v.mode[i]];
        if (!mode) continue;
        if (!near && !an[STYLE[mode].key]) continue;
        const mk = this.markers.get(mode)!;
        const k = counts.get(mode)!;
        if (k >= mk.capacity) continue;
        mk.setMarker(k, v.x[i], v.y[i], v.z[i], v.heading[i], this.routeColor[v.route[i]] ?? 0xffffff);
        counts.set(mode, k + 1);
      }
    }
    for (const m of MODE_LIST) {
      const mk = this.markers.get(m)!;
      mk.setCount(counts.get(m)!);
      mk.commit();
      mk.update(ctx);
    }
  }

  dispose() {
    for (const o of this.lines.values()) o.dispose();
    for (const o of this.markers.values()) o.dispose();
  }
}
