import { describe, expect, it } from 'vitest';
import { trapTarget } from './sheet';

const order = ['a', 'b', 'c'];

describe('trapTarget', () => {
  it('lets Tab move on inside the panel', () => {
    expect(trapTarget(order, 'a', false)).toBeNull();
    expect(trapTarget(order, 'b', true)).toBeNull();
  });

  it('wraps from the last control to the first, and back', () => {
    expect(trapTarget(order, 'c', false)).toBe('a');
    expect(trapTarget(order, 'a', true)).toBe('c');
  });

  it('pulls focus in from outside', () => {
    expect(trapTarget(order, null, false)).toBe('a');
    expect(trapTarget(order, null, true)).toBe('c');
    expect(trapTarget(order, 'elsewhere', false)).toBe('a');
  });

  it('has nowhere to go with no controls', () => {
    expect(trapTarget([], null, false)).toBeNull();
  });

  it('keeps a single control where it is', () => {
    expect(trapTarget(['a'], 'a', false)).toBe('a');
    expect(trapTarget(['a'], 'a', true)).toBe('a');
  });
});
