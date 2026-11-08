import type { Built } from '../core/model';

export function simJson(b: Built): string {
  return JSON.stringify({
    lanes: b.lanes.map((l) => ({
      kind: l.kind, cls: l.cls, pts: l.pts, width: l.width, speed: l.speed, node: l.node ?? null, next: l.next, prev: l.prev,
      bidir: l.bidir, signal: l.signal ?? null, conflicts: l.conflicts ?? [], crosswalk: !!l.crosswalk, turn: l.turn ?? null,
      stopSign: !!l.stopSign,
    })),
    signals: b.signals,
    nodes: b.nodes.map((n) => ({ id: n.id, kind: n.kind })),
  });
}
