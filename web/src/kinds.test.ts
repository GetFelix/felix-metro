import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { KINDS, TREE_FIRST } from './kinds';

it('matches the kind table in core', () => {
  const rust = readFileSync(new URL('../../core/src/kinds.rs', import.meta.url), 'utf8');
  const rows = [...rust.matchAll(/k\("(\w+)", "([\w-]+)"\)/g)].map((m) => ({ pack: m[1], model: m[2] }));
  expect(KINDS).toEqual(rows);
});

it('starts the trees where core does', () => {
  const rust = readFileSync(new URL('../../core/src/kinds.rs', import.meta.url), 'utf8');
  expect(Number(/TREE_FIRST: u8 = (\d+)/.exec(rust)![1])).toBe(TREE_FIRST);
});
