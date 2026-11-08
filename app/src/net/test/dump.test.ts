import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LAYOUTS } from '../../bench/layouts';
import { build } from '../core/build';
import { simJson } from '../sim/encode';

it('dump sim inputs', () => {
  const dir = '../netsim/tests/data';
  mkdirSync(dir, { recursive: true });
  for (const l of LAYOUTS) writeFileSync(`${dir}/${l.id}.json`, simJson(build(l.desc())));
});
