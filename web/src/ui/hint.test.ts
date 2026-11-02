import { describe, expect, it, vi } from 'vitest';
import { HINT_MS, HINT_TEXT, createHint, hintDue, createMemory, type HintStorage } from './hint';

const storage = (): HintStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

// A page with nothing in it: a toast that counts its removals and an interaction the test fires by hand.
function page(memory = createMemory(() => storage())) {
  const shown: { text: string; ms: number | null; removed: number }[] = [];
  let touch: (() => void) | null = null;
  const hint = createHint({
    memory,
    show: (text, ms) => {
      const entry = { text, ms, removed: 0 };
      shown.push(entry);
      return { remove: () => void entry.removed++ };
    },
    onInteraction: (cb) => {
      touch = cb;
      return () => (touch = null);
    },
  });
  return { hint, shown, interact: () => touch?.(), listening: () => touch !== null };
}

describe('the first-visit tip', () => {
  it('shows the tip in plain words for a few seconds', () => {
    const { hint, shown } = page();
    expect(hint.offer()).toBe(true);
    expect(shown).toEqual([{ text: HINT_TEXT, ms: HINT_MS, removed: 0 }]);
    expect(HINT_TEXT).toBe('Drag the timeline to go back in time');
  });

  it('is shown once on a page, however often it is offered', () => {
    const { hint, shown } = page();
    hint.offer();
    expect(hint.offer()).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('is not shown to someone who has seen it', () => {
    const store = storage();
    expect(page(createMemory(() => store)).hint.offer()).toBe(true);
    expect(page(createMemory(() => store)).hint.offer()).toBe(false);
  });

  it('goes at the first interaction and stops listening', () => {
    const { hint, shown, interact, listening } = page();
    hint.offer();
    expect(listening()).toBe(true);
    interact();
    expect(shown[0]!.removed).toBe(1);
    expect(listening()).toBe(false);
  });

  it('is still shown, once, when storage is blocked', () => {
    const blocked = createMemory(() => {
      throw new Error('blocked');
    });
    const { hint, shown } = page(blocked);
    expect(hint.offer()).toBe(true);
    expect(hint.offer()).toBe(false);
    expect(shown).toHaveLength(1);
  });
});

describe('createMemory', () => {
  it('remembers across instances that share storage', () => {
    const store = storage();
    expect(createMemory(() => store).seen()).toBe(false);
    createMemory(() => store).remember();
    expect(createMemory(() => store).seen()).toBe(true);
  });

  it('reads blocked storage as not seen and does not throw on a write', () => {
    const memory = createMemory(() => {
      throw new Error('blocked');
    });
    expect(memory.seen()).toBe(false);
    expect(() => memory.remember()).not.toThrow();
  });

  it('ignores a value it did not write', () => {
    const store = storage();
    store.setItem('felix-metro.hint', 'maybe');
    expect(createMemory(() => store).seen()).toBe(false);
  });
});

describe('listenForInteraction', () => {
  it('listens to the pointer, the keys and the wheel, and stops when told', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal('addEventListener', (e: string) => added.push(e));
    vi.stubGlobal('removeEventListener', (e: string) => removed.push(e));
    const { listenForInteraction } = await import('./hint');
    const off = listenForInteraction(() => {});
    off();
    vi.unstubAllGlobals();
    expect(added.sort()).toEqual(['keydown', 'pointerdown', 'wheel']);
    expect(removed.sort()).toEqual(['keydown', 'pointerdown', 'wheel']);
  });
});

describe('when the tip is due', () => {
  it('is when the timeline appears over the live city', () => {
    expect(hintDue(true, false)).toBe(true);
  });

  it('is not when the timeline is not new, or the page already shows an earlier moment', () => {
    expect(hintDue(false, false)).toBe(false);
    expect(hintDue(true, true)).toBe(false);
  });
});
