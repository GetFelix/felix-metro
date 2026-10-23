import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { KINDS } from './kinds';

it('matches the kind table in core', () => {
  const rust = readFileSync(new URL('../../core/src/kinds.rs', import.meta.url), 'utf8');
  const rows = [...rust.matchAll(/k\("(\w+)", "([\w-]+)"\)/g)].map((m) => ({ pack: m[1], model: m[2] }));
  expect(KINDS).toEqual(rows);
});
