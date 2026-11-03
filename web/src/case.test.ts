import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  attempt,
  hints,
  hourLabel,
  isRight,
  OPEN_CASE,
  question,
  readInvestigation,
  statusText,
  verdictText,
  type Answer,
  type Investigation,
} from './case';

// The case table as core describes it. sim/src/world/case_file/tests.rs writes it and recomputes it from the day's events.
const fixture = JSON.parse(readFileSync(new URL('./investigation-fixture.json', import.meta.url), 'utf8')) as {
  investigations: Investigation[];
};
const inv = fixture.investigations[0]!;
const right: Answer = { street: inv.street, hour: inv.hour, purpose: inv.purpose };

describe('readInvestigation', () => {
  it('reads the case file core sends and nothing from a city without one', () => {
    expect(readInvestigation(JSON.stringify(inv))).toEqual(inv);
    expect(readInvestigation(undefined)).toBeNull();
    expect(readInvestigation('{"seed":"ember"}')).toBeNull();
  });
});

describe('isRight', () => {
  it('needs all three parts right', () => {
    expect(isRight(inv, right)).toBe(true);
    expect(isRight(inv, { ...right, street: inv.neighbour })).toBe(false);
    expect(isRight(inv, { ...right, hour: inv.hour + 1 })).toBe(false);
    expect(isRight(inv, { ...right, purpose: 'school' })).toBe(false);
    expect(isRight(inv, { street: null, hour: null, purpose: null })).toBe(false);
  });
});

describe('attempt', () => {
  it('does not count an answer with a part missing', () => {
    expect(attempt(inv, OPEN_CASE, { ...right, hour: null })).toBe(OPEN_CASE);
  });

  it('counts each wrong answer and then the right one', () => {
    const wrong = { ...right, purpose: 'leisure' };
    const once = attempt(inv, OPEN_CASE, wrong);
    const twice = attempt(inv, once, wrong);
    expect(twice).toEqual({ attempts: 2, solved: false });
    expect(attempt(inv, twice, right)).toEqual({ attempts: 3, solved: true });
  });

  it('stops counting once the case is solved', () => {
    const solved = attempt(inv, OPEN_CASE, right);
    expect(attempt(inv, solved, { ...right, hour: 0 })).toBe(solved);
  });
});

describe('the words', () => {
  it('names an hour by its start and end on the clock', () => {
    expect(hourLabel(0)).toBe('12 am to 1 am');
    expect(hourLabel(7)).toBe('7 am to 8 am');
    expect(hourLabel(11)).toBe('11 am to 12 pm');
    expect(hourLabel(23)).toBe('11 pm to 12 am');
  });

  it('counts the day from 1, as the page clock does', () => {
    expect(question(inv)).toContain(`Day ${inv.day + 1} `);
  });

  it('hints at a two-hour window holding the hour and a crossing street, never the answer', () => {
    const [when, where] = hints(inv);
    expect(when).toBe('It was between 6 am and 8 am.');
    expect(where).toContain(inv.neighbour);
    expect(hints(inv).join(' ')).not.toContain(inv.street);
    expect(inv.hintFrom).toBeLessThanOrEqual(inv.hour);
    expect(inv.hour).toBeLessThan(inv.hintFrom + 2);
  });

  it('says how the case stands and what a check found, without saying which part is wrong', () => {
    expect(statusText(OPEN_CASE)).toBe('Open');
    expect(statusText({ attempts: 1, solved: false })).toBe('Open, 1 try');
    expect(statusText({ attempts: 3, solved: false })).toBe('Open, 3 tries');
    expect(statusText({ attempts: 1, solved: true })).toBe('Solved first try');
    expect(statusText({ attempts: 4, solved: true })).toBe('Solved in 4 tries');
    const wrong = { ...right, hour: 3 };
    expect(verdictText({ attempts: 1, solved: false }, wrong)).toBe('Not all three are right. Watch the day again.');
    expect(verdictText({ attempts: 1, solved: false }, { ...right, hour: null })).toBe(
      'Choose a street, an hour and a purpose.',
    );
    expect(verdictText({ attempts: 2, solved: true }, right)).toBe('Case closed. All three are right.');
  });
});
