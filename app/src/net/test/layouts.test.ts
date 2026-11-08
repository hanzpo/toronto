import { describe, expect, it } from 'vitest';
import { LAYOUTS } from '../../bench/layouts';
import { build } from '../core/build';

describe('bench layouts', () => {
  for (const l of LAYOUTS) {
    it(l.id, () => {
      const b = build(l.desc());
      let tris = 0;
      for (const [m, buf] of b.meshes) {
        for (const v of buf.pos) expect(Number.isFinite(v), `${l.id} ${m}`).toBe(true);
        for (const i of buf.idx) expect(i).toBeLessThan(buf.pos.length / 3);
        tris += buf.idx.length / 3;
      }
      for (const ln of b.lanes) for (const p of ln.pts) expect(Number.isFinite(p.x + p.y + p.z), `${l.id} lane ${ln.id}`).toBe(true);
      const kinds = b.nodes.map((n) => `${n.id}:${n.kind}:${n.control}`).filter((s) => !/:end:|:continue:/.test(s));
      console.log(l.id, { tris, lanes: b.lanes.length, props: b.props.length, tracks: b.tracks.length, nodes: kinds, review: b.review.map((r) => r.kind + ' ' + r.note) });
      expect(tris).toBeGreaterThan(0);
    });
  }
});
