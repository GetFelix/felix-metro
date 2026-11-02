import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GO_UP_TEXT, cardText } from '../attribution';
import { canRemoveRoad, families, refusal, roadRefusal } from '../build';
import { whyNot } from '../placement';
import { BUILD_LABEL, DEMOLISH_LABEL, HINTS, ROAD_LABEL, ROAD_SECOND } from './build-bar';
import { HINT_TEXT } from './hint';
import { SHORTCUTS } from './keys';
import { archetypeLabel, doing, type Activity, type Archetype } from '../follow';
import { STOP_LABEL } from './follow-card';
import { SHARE_COPIED, SHARE_LABEL, SHARE_NONE } from './share';
import { CHOICES } from './settings';
import { GROUPS } from '../stats';
import { UNAVAILABLE_TEXT } from './sound';

// docs/ui.md sets the copy rules: plain words, none of the system's own, and no em dashes.
const JARGON = /\b(logs?|streams?|offsets?|ticks?|shards?|keyframes?|districts?)\b/i;

// What the follow card says: the kinds of resident, and what each activity reads as indoors, on foot and by car.
const activities: Activity[] = ['home', 'work', 'school', 'shop', 'leisure'];
const kinds: Archetype[] = ['office', 'shift', 'shopkeeper', 'student', 'retiree', 'night'];
const said = activities.flatMap((activity) => {
  const day = {
    id: 0,
    name: '',
    archetype: 'office' as const,
    home: 0,
    vehicle: 1,
    blocks: [{ activity, lot: 1, leave: 9 }],
  };
  return [0, 5000]
    .map((tick) => doing(day, tick, null).text)
    .concat(doing(day, 0, { car: true, to: 1 }).text, doing(day, 0, { car: false, to: 1 }).text);
});

const words = [
  STOP_LABEL,
  ...kinds.map(archetypeLabel),
  ...said,
  HINT_TEXT,
  GO_UP_TEXT,
  cardText({ kind: 'built', name: 'Ana', mine: false, tick: 5760 + 2208 }),
  cardText({ kind: 'built', name: 'Ana', mine: true, tick: 0 }),
  cardText({ kind: 'start' }),
  cardText({ kind: 'earlier' }),
  UNAVAILABLE_TEXT,
  SHARE_LABEL,
  SHARE_COPIED,
  SHARE_NONE,
  BUILD_LABEL,
  DEMOLISH_LABEL,
  ROAD_LABEL,
  ROAD_SECOND,
  ...Object.values(HINTS),
  ...[2, 20, 21, 22, 23].map((code) => roadRefusal(code)),
  refusal(23, 'build'),
  (canRemoveRoad({ city: { lots: [], development: [] }, built: new Map() }, null) as { why: string }).why,
  ...[1, 2, 3, 4, 5, 7, 8, 9, 10, 20, 21, 22, 23, 24, 99].map((code) => refusal(code)),
  ...families().flatMap((f) => [f.title, ...f.choices.map((c) => c.label)]),
  whyNot({ link: null, atTip: () => true, wantsLive: true }) ?? '',
  ...GROUPS.map((g) => g.label),
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
