import { describe, expect, it } from 'vitest';
import { parseParams } from './params';

describe('parseParams', () => {
  it('defaults to a running high-tier scene with the overlay', () => {
    expect(parseParams('')).toEqual({ frozenHour: null, still: false, tier: 'high', ui: true });
  });

  it('reads the frozen hour, still, tier and ui flags', () => {
    expect(parseParams('?t=17.8&still&tier=low&ui=0')).toEqual({
      frozenHour: 17.8,
      still: true,
      tier: 'low',
      ui: false,
    });
  });

  it('keeps the overlay for any ui value but 0', () => {
    expect(parseParams('?ui=1').ui).toBe(true);
  });
});
