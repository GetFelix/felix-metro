import { describe, expect, it } from 'vitest';
import { clockText, policyRows, type PolicyEvent } from './policy';

const event = (...settings: PolicyEvent['settings']): PolicyEvent => ({ type: 'policy', settings });
const usual = [
  { value: 0, changed: null },
  { value: 100, changed: null },
  { value: 100, changed: null },
];

describe('policyRows', () => {
  it('shows the usual hours and no limits for a city nobody has set', () => {
    const rows = policyRows(event(...usual));
    expect(rows.map((r) => [r.name, r.value, r.again])).toEqual([
      ['Shop hours', 'Usual', null],
      ['Avenue speed limit', 'No limit', null],
      ['Street speed limit', 'No limit', null],
    ]);
  });

  it('says when a changed policy can change again', () => {
    // Set at 17:30 on day 1, so it can change from 17:30 on day 2.
    const rows = policyRows(event({ value: 2, changed: 4200 }, { value: 60, changed: 100 }, usual[2]!));
    expect(rows[0]).toMatchObject({ value: '2 h later', again: 'Day 2, 17:30' });
    expect(rows[1]).toMatchObject({ value: '60% of their speed', again: 'Day 2, 00:25' });
  });

  it('reads the clock like the page does', () => {
    expect(clockText(0)).toBe('Day 1, 00:00');
    expect(clockText(5760 + 6 * 240 + 4)).toBe('Day 2, 06:01');
  });
});
