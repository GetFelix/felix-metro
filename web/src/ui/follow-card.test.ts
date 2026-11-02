import { describe, expect, it } from 'vitest';
import { isFollowKey, isStopKey } from './follow-card';

const press = (key: string, extra: object = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe('isStopKey', () => {
  it('is a plain Esc', () => {
    expect(isStopKey(press('Escape'), false, false, false)).toBe(true);
    expect(isStopKey(press('Enter'), false, false, false)).toBe(false);
    expect(isStopKey(press('Escape', { ctrlKey: true }), false, false, false)).toBe(false);
    expect(isStopKey(press('Escape', { metaKey: true }), false, false, false)).toBe(false);
  });

  it('is left to photo mode, an open sheet and the open city menu, which close themselves on Esc first', () => {
    expect(isStopKey(press('Escape'), true, false, false)).toBe(false);
    expect(isStopKey(press('Escape'), false, true, false)).toBe(false);
    expect(isStopKey(press('Escape'), false, false, true)).toBe(false);
  });
});

describe('isFollowKey', () => {
  const f = (key: string, extra: object = {}) => ({ ...press(key), repeat: false, ...extra });

  it('is a plain F, either case', () => {
    expect(isFollowKey(f('f'), null, false)).toBe(true);
    expect(isFollowKey(f('F'), null, false)).toBe(true);
    expect(isFollowKey(f('g'), null, false)).toBe(false);
  });

  it('leaves F alone with a modifier, held down, in a field or under a sheet', () => {
    expect(isFollowKey(f('f', { ctrlKey: true }), null, false)).toBe(false);
    expect(isFollowKey(f('f', { metaKey: true }), null, false)).toBe(false);
    expect(isFollowKey(f('f', { repeat: true }), null, false)).toBe(false);
    expect(isFollowKey(f('f'), { tagName: 'INPUT', type: 'text' }, false)).toBe(false);
    expect(isFollowKey(f('f'), null, true)).toBe(false);
  });
});
