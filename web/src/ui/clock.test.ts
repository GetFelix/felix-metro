import { describe, expect, it } from 'vitest';
import { changedDigits, rollDirection, sameShape } from './clock';

describe('rollDirection', () => {
  it('rolls forward as the clock moves on and back as it goes back', () => {
    expect(rollDirection('18:30', '18:31')).toBe(1);
    expect(rollDirection('18:31', '18:30')).toBe(-1);
    expect(rollDirection('09:00', '13:00')).toBe(1);
    expect(rollDirection('13:00', '09:00')).toBe(-1);
  });

  it('takes the short way round midnight', () => {
    expect(rollDirection('23:59', '00:00')).toBe(1);
    expect(rollDirection('00:00', '23:59')).toBe(-1);
  });

  it('rolls forward when it cannot tell', () => {
    expect(rollDirection('', '12:00')).toBe(1);
  });
});

describe('changedDigits', () => {
  it('lists only the digits that differ', () => {
    expect(changedDigits('12:59', '13:00')).toEqual([1, 3, 4]);
    expect(changedDigits('12:30', '12:31')).toEqual([4]);
  });

  it('leaves the colon alone', () => {
    expect(changedDigits('12:30', '12:30')).toEqual([]);
  });
});

describe('sameShape', () => {
  it('needs digits and separators in the same places', () => {
    expect(sameShape('12:30', '13:00')).toBe(true);
    expect(sameShape('', '13:00')).toBe(false);
    expect(sameShape('1230', '12:30')).toBe(false);
    expect(sameShape('12:30', '123:0')).toBe(false);
  });
});
