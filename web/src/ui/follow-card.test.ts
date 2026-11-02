import { describe, expect, it } from 'vitest';
import { isStopKey } from './follow-card';

const press = (key: string, extra: object = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe('isStopKey', () => {
  it('is a plain Esc', () => {
    expect(isStopKey(press('Escape'), false, false)).toBe(true);
    expect(isStopKey(press('Enter'), false, false)).toBe(false);
    expect(isStopKey(press('Escape', { ctrlKey: true }), false, false)).toBe(false);
    expect(isStopKey(press('Escape', { metaKey: true }), false, false)).toBe(false);
  });

  it('is left to photo mode and to an open sheet, which close themselves on Esc first', () => {
    expect(isStopKey(press('Escape'), true, false)).toBe(false);
    expect(isStopKey(press('Escape'), false, true)).toBe(false);
  });
});
