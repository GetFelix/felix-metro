import { describe, expect, it } from 'vitest';
import { createAttract } from './attract';

describe('attract mode', () => {
  it('starts after the wait and not before', () => {
    const a = createAttract(0, 60);
    expect(a.active(59_999)).toBe(false);
    expect(a.active(60_000)).toBe(true);
  });

  it('starts the wait over when someone is there', () => {
    const a = createAttract(0, 60);
    a.poke(50_000);
    expect(a.active(100_000)).toBe(false);
    expect(a.active(110_000)).toBe(true);
    a.poke(111_000);
    expect(a.active(112_000)).toBe(false);
  });

  it('never starts when the wait is zero', () => {
    expect(createAttract(0, 0).active(1e9)).toBe(false);
  });
});
