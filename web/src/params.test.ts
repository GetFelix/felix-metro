import { describe, expect, it } from 'vitest';
import { parseParams } from './params';

describe('parseParams', () => {
  it('defaults to a running scene with the overlay and no forced tier', () => {
    expect(parseParams('')).toEqual({ frozenHour: null, still: false, tier: null, ui: true, hud: false, slow: 0 });
  });

  it('reads the frozen hour, still, tier, ui and hud flags', () => {
    expect(parseParams('?t=17.8&still&tier=low&ui=0&hud&slow=40')).toEqual({
      frozenHour: 17.8,
      still: true,
      tier: 'low',
      ui: false,
      hud: true,
      slow: 40,
    });
  });

  it('keeps the overlay for any ui value but 0', () => {
    expect(parseParams('?ui=1').ui).toBe(true);
  });

  it('ignores an unknown tier', () => {
    expect(parseParams('?tier=ultra').tier).toBeNull();
  });
});
