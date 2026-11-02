import { describe, expect, it } from 'vitest';
import { createStatsMemory, figure, isStatsKey, type StatsStorage } from './stats';

const key = (k: string, extra: Partial<Parameters<typeof isStatsKey>[0]> = {}) => ({
  key: k,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

describe('isStatsKey', () => {
  it('is a plain C, in either case', () => {
    expect(isStatsKey(key('c'), null, false)).toBe(true);
    expect(isStatsKey(key('C'), null, false)).toBe(true);
    expect(isStatsKey(key('v'), null, false)).toBe(false);
  });

  it('leaves copy, a held key, a text field and an open sheet alone', () => {
    expect(isStatsKey(key('c', { ctrlKey: true }), null, false)).toBe(false);
    expect(isStatsKey(key('c', { metaKey: true }), null, false)).toBe(false);
    expect(isStatsKey(key('c', { altKey: true }), null, false)).toBe(false);
    expect(isStatsKey(key('c', { repeat: true }), null, false)).toBe(false);
    expect(isStatsKey(key('c'), { tagName: 'INPUT', type: 'text' }, false)).toBe(false);
    expect(isStatsKey(key('c'), null, true)).toBe(false);
  });
});

describe('figure', () => {
  it('groups digits and shows a dash for a number not known yet', () => {
    expect(figure(522)).toBe('522');
    expect(figure(20000)).toBe('20,000');
    expect(figure(0)).toBe('0');
    expect(figure(null)).toBe('-');
  });
});

describe('the memory', () => {
  const store = (): StatsStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it('starts off and keeps the last choice', () => {
    const s = store();
    const memory = createStatsMemory(() => s);
    expect(memory.on()).toBe(false);
    memory.set(true);
    expect(createStatsMemory(() => s).on()).toBe(true);
    memory.set(false);
    expect(createStatsMemory(() => s).on()).toBe(false);
  });

  it('reads as off, and does not throw, where storage is blocked', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    const memory = createStatsMemory(blocked);
    expect(memory.on()).toBe(false);
    expect(() => memory.set(true)).not.toThrow();
  });
});
