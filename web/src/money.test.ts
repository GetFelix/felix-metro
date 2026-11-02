import { describe, expect, it } from 'vitest';
import { money } from './money';

describe('money', () => {
  it('groups thousands', () => {
    expect(money(0)).toBe('$0');
    expect(money(999)).toBe('$999');
    expect(money(100000)).toBe('$100,000');
    expect(money(1234567)).toBe('$1,234,567');
  });

  it('puts the sign before the dollar', () => {
    expect(money(-1200)).toBe('-$1,200');
  });
});
