import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CouncilEvent } from './council';
import { goalsView, openingPolicy, readChapter, type Chapter } from './goals';
import { policyRows, USUAL_POLICY } from './policy';

// The chapter table and the council and funds the sim reached after three days of each run. sim/src/world/council/tests.rs
// writes it.
const fixture = JSON.parse(readFileSync(new URL('./chapter-fixture.json', import.meta.url), 'utf8')) as {
  chapters: Chapter[];
  ignored: { council: CouncilEvent; funds: number };
  raised: { council: CouncilEvent; funds: number };
};
const chapter = fixture.chapters[0]!;

describe('readChapter', () => {
  it('reads the chapter core sends and nothing from a city without one', () => {
    expect(readChapter(JSON.stringify(chapter))).toEqual(chapter);
    expect(readChapter(undefined)).toBeNull();
    expect(readChapter('{"seed":"pier"}')).toBeNull();
  });
});

describe('openingPolicy', () => {
  it('shows the limits a chapter city opens with, before any policy event exists', () => {
    const rows = policyRows(openingPolicy(chapter), 0);
    expect(rows.map((r) => r.value)).toEqual(['Usual', '40% of their speed', '60% of their speed']);
    expect(rows.every((r) => r.again === null)).toBe(true);
  });

  it('is the usual policy for a city with no chapter', () => {
    expect(openingPolicy(null)).toBe(USUAL_POLICY);
  });
});

describe('goalsView against the sim', () => {
  it('calls a mayor who changed nothing lost: the commute is too long and the council has recalled them', () => {
    const view = goalsView(chapter, fixture.ignored.council, fixture.ignored.funds);
    expect(view.verdict).toBe('lost');
    expect(view.status).toBe('Lost');
    expect(view.rows.map((r) => r.state)).toEqual(['failed', 'failed', 'met']);
    expect(view.rows[0]!.now).toBe('24 min');
    expect(
      goalsView(
        chapter,
        {
          ...fixture.raised.council,
          standings: [
            { ...fixture.raised.council.standings[0]!, measure: 70 },
            ...fixture.raised.council.standings.slice(1),
          ],
        },
        1,
      ).rows[0]!.now,
    ).toBe('17.5 min');
  });

  it('calls a mayor who raised the limits the winner', () => {
    const view = goalsView(chapter, fixture.raised.council, fixture.raised.funds);
    expect(view.verdict).toBe('won');
    expect(view.status).toBe('Won');
    expect(view.rows.map((r) => r.state)).toEqual(['met', 'met', 'met']);
  });
});

describe('goalsView on the way', () => {
  const council = (days: number, measure: number, unhappyDays = 0): CouncilEvent => ({
    type: 'council',
    days,
    patience: 3,
    standings: [
      { demand: 48, measure, satisfaction: 50, unhappyDays },
      { demand: 80, measure: 100, satisfaction: 100, unhappyDays: 0 },
      { demand: 5, measure: 5, satisfaction: 100, unhappyDays: 0 },
    ],
  });

  it('keeps playing, with nothing judged, until a day is scored', () => {
    const view = goalsView(chapter, council(0, 0), 100_000);
    expect(view.verdict).toBe('playing');
    expect(view.status).toBe('Day 1 of 3');
    expect(view.rows[0]).toMatchObject({ state: 'open', now: null });
    expect(goalsView(chapter, null, null).rows.map((r) => r.state)).toEqual(['open', 'met', 'open']);
  });

  it('keeps playing while a commute is long and the deadline has not come', () => {
    const view = goalsView(chapter, council(2, 96, 2), 100_000);
    expect(view.verdict).toBe('playing');
    expect(view.status).toBe('Day 3 of 3');
  });

  it('loses at once when a faction recalls the mayor, before the deadline', () => {
    expect(goalsView({ ...chapter, days: 5 }, council(3, 96, 3), 100_000).verdict).toBe('lost');
  });

  it('loses when the account runs dry', () => {
    expect(goalsView(chapter, council(1, 60), 0).verdict).toBe('lost');
    expect(goalsView(chapter, council(1, 60), -5).rows[2]!.state).toBe('failed');
  });

  it('does not call a chapter won before its last day is scored, even with the commute met', () => {
    const view = goalsView(chapter, council(2, 60), 100_000);
    expect(view.verdict).toBe('playing');
    expect(view.rows[0]!.state).toBe('met');
  });

  it('counts the commute goal met at exactly the limit and failed one tick over, on the last day', () => {
    expect(goalsView(chapter, council(3, chapter.commuteTicks), 1).verdict).toBe('won');
    expect(goalsView(chapter, council(3, chapter.commuteTicks + 1), 1).verdict).toBe('lost');
  });
});
