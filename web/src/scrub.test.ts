import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Latest } from './scrub';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A run the test finishes by hand. */
function slow() {
  const started: number[] = [];
  const finish: (() => void)[] = [];
  let live = 0;
  let widest = 0;
  const run = (tick: number) => {
    started.push(tick);
    widest = Math.max(widest, ++live);
    return new Promise<void>((resolve) =>
      finish.push(() => {
        live--;
        resolve();
      }),
    );
  };
  return { run, started, finish, widest: () => widest };
}

describe('Latest', () => {
  it('runs one seek at a time and skips to the newest target when it finishes', async () => {
    const s = slow();
    const l = new Latest(s.run);
    l.want(10, true);
    for (const t of [20, 30, 40, 50]) l.want(t, true);
    expect(s.started).toEqual([10]);
    s.finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.started).toEqual([10, 50]);
    s.finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.widest()).toBe(1);
    expect(l.idle).toBe(true);
  });

  it('waits for the handle to rest before a step or a release seeks, and takes only the last', async () => {
    const s = slow();
    const l = new Latest(s.run, 80);
    l.want(100, false);
    await vi.advanceTimersByTimeAsync(60);
    l.want(160, false);
    await vi.advanceTimersByTimeAsync(60);
    expect(s.started).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(s.started).toEqual([160]);
  });

  it('a seek that fails does not stop the next target', async () => {
    const seen: number[] = [];
    const l = new Latest(async (t) => {
      seen.push(t);
      if (t === 1) throw new Error('no');
    });
    l.want(1, true);
    l.want(2, true);
    await l.settled();
    expect(seen).toEqual([1, 2]);
  });

  it('settled resolves once the last target has been shown', async () => {
    const seen: number[] = [];
    const l = new Latest(async (t) => void seen.push(t), 80);
    l.want(5, false);
    const done = l.settled();
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(seen).toEqual([5]);
  });
});
