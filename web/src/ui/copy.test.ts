import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { families, refusal } from '../build';
import { whyNot } from '../placement';
import { BUILD_LABEL, DEMOLISH_LABEL, HINTS } from './build-bar';
import { HINT_TEXT } from './hint';
import { SHORTCUTS } from './keys';
import { SHARE_COPIED, SHARE_LABEL, SHARE_NONE } from './share';
import { CHOICES } from './settings';
import { UNAVAILABLE_TEXT } from './sound';

// docs/ui.md sets the copy rules: plain words, none of the system's own, and no em dashes.
const JARGON = /\b(logs?|streams?|offsets?|ticks?|shards?|keyframes?|districts?)\b/i;

const words = [
  HINT_TEXT,
  UNAVAILABLE_TEXT,
  SHARE_LABEL,
  SHARE_COPIED,
  SHARE_NONE,
  BUILD_LABEL,
  DEMOLISH_LABEL,
  ...Object.values(HINTS),
  ...[1, 2, 3, 4, 5, 7, 8, 9, 99].map(refusal),
  ...families().flatMap((f) => [f.title, ...f.choices.map((c) => c.label)]),
  whyNot({ link: null, atTip: () => true, wantsLive: true }) ?? '',
  ...CHOICES.flatMap((c) => [c.label, c.hint]),
  ...SHORTCUTS.flatMap((g) => [g.title, g.when ?? '', ...g.rows.map((r) => r.action)]),
];

describe('copy', () => {
  it('keeps the system out of what a player reads', () => {
    for (const text of words) expect(text, text).not.toMatch(JARGON);
  });

  it('has no em or en dashes in the overlay code, styles or docs', () => {
    const dir = new URL('./', import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => /\.(ts|css)$/.test(f) && f !== 'copy.test.ts')
      .map((f) => new URL(f, dir));
    files.push(new URL('../../index.html', import.meta.url), new URL('../../../docs/ui.md', import.meta.url));
    for (const file of files) expect(readFileSync(file, 'utf8'), file.pathname).not.toMatch(/[–—]/);
  });
});
