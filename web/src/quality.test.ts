import { describe, expect, it } from 'vitest';
import { passesFor } from './passes';
import {
  MIN_SAMPLES,
  NEXT_WINDOW_MS,
  FIRST_WINDOW_MS,
  SETTLE_FRAMES,
  createQuality,
  decideTier,
  displayInterval,
  median,
  settingsFor,
  stepDown,
} from './quality';
import type { Tier } from './params';

const frames = (ms: number, n = 60) => Array<number>(n).fill(ms);

describe('median', () => {
  it('takes the middle of an odd list and the mean of the middle two of an even one', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('decideTier', () => {
  it('steps down one tier when the median is over the limit', () => {
    expect(decideTier('high', frames(30), false)).toBe('medium');
    expect(decideTier('medium', frames(30), false)).toBe('low');
  });

  it('stays on low', () => {
    expect(decideTier('low', frames(80), false)).toBe('low');
  });

  it('never steps up, however fast the frames are', () => {
    expect(decideTier('low', frames(4), false)).toBe('low');
    expect(decideTier('medium', frames(4), false)).toBe('medium');
  });

  it('keeps a fast tier', () => {
    expect(decideTier('high', frames(16), false)).toBe('high');
  });

  it('is not moved by a few slow frames', () => {
    expect(decideTier('high', [...frames(16, 50), ...frames(400, 5)], false)).toBe('high');
  });

  it('leaves a forced tier alone', () => {
    expect(decideTier('high', frames(80), true)).toBe('high');
  });

  it('needs enough frames to judge', () => {
    expect(decideTier('high', frames(80, MIN_SAMPLES - 1), false)).toBe('high');
  });

  it('steps down in order', () => {
    expect(stepDown('high')).toBe('medium');
    expect(stepDown('medium')).toBe('low');
    expect(stepDown('low')).toBe('low');
  });
});

describe('refresh rate', () => {
  it('does not step down a steady 30 Hz display', () => {
    expect(decideTier('high', frames(33.3), false)).toBe('high');
  });

  it('steps down a 60 Hz display that mostly runs at 30 ms', () => {
    const mixed = [...frames(16.7, 10), ...frames(30, 50)];
    expect(displayInterval(mixed)).toBeCloseTo(16.7);
    expect(decideTier('high', mixed, false)).toBe('medium');
  });

  it('keeps the 22 ms floor on a fast display', () => {
    const near = [...frames(8.3, 10), ...frames(21, 50)];
    expect(decideTier('high', near, false)).toBe('high');
  });
});

describe('settingsFor', () => {
  it('drops the look in steps: ambient occlusion, then tilt-shift, shadows and resolution', () => {
    expect(settingsFor('high')).toMatchObject({ ao: true, tiltShift: true, shadows: true, pixelRatioCap: 2 });
    expect(settingsFor('medium')).toMatchObject({ ao: false, tiltShift: true, shadows: true, pixelRatioCap: 2 });
    expect(settingsFor('low')).toMatchObject({ ao: false, tiltShift: false, shadows: false, pixelRatioCap: 1 });
  });

  it('allows pedestrian rigs only on high', () => {
    expect(settingsFor('high').rigs).toBe(true);
    expect(settingsFor('medium').rigs).toBe(false);
    expect(settingsFor('low').rigs).toBe(false);
  });

  it('keeps the shadow map sizes of each tier', () => {
    expect(settingsFor('high').shadowMapSize).toBe(4096);
    expect(settingsFor('medium').shadowMapSize).toBe(2048);
  });

  it('agrees with the post chain', () => {
    for (const t of ['high', 'medium', 'low'] as Tier[]) {
      const s = settingsFor(t);
      expect(passesFor(t).includes('ao')).toBe(s.ao);
      expect(passesFor(t).includes('tilt-shift')).toBe(s.tiltShift);
    }
  });
});

describe('createQuality', () => {
  // Feeds frames of one length until the controller reacts or the budget runs out.
  function run(q: ReturnType<typeof createQuality>, ms: number, count: number) {
    for (let i = 0; i < count; i++) q.tick(ms);
  }
  const make = (url: Tier | null, still = false) => {
    const changes: Tier[] = [];
    const q = createQuality({ url, still, onChange: (t) => changes.push(t) });
    return { q, changes };
  };

  it('starts on high in auto mode', () => {
    const { q } = make(null);
    expect([q.tier, q.mode]).toEqual(['high', 'auto']);
  });

  it('steps down after the first window and again while frames stay slow, then stops at low', () => {
    const { q, changes } = make(null);
    run(q, 40, Math.ceil(FIRST_WINDOW_MS / 40) + SETTLE_FRAMES);
    expect(changes).toEqual(['medium']);
    run(q, 40, Math.ceil(NEXT_WINDOW_MS / 40) + SETTLE_FRAMES);
    expect(changes).toEqual(['medium', 'low']);
    run(q, 40, 500);
    expect(changes).toEqual(['medium', 'low']);
  });

  it('stops choosing once a window is fast enough', () => {
    const { q, changes } = make(null);
    run(q, 10, 1000);
    run(q, 60, 1000);
    expect(changes).toEqual([]);
    expect(q.tier).toBe('high');
  });

  it('does not judge before its window is over', () => {
    const { q, changes } = make(null);
    run(q, 40, 50);
    expect(changes).toEqual([]);
  });

  it('keeps a tier from the URL and reports it as forced', () => {
    const { q, changes } = make('high');
    run(q, 80, 1000);
    expect([q.tier, q.mode, changes]).toEqual(['high', 'forced', []]);
  });

  it('never chooses on a frozen scene', () => {
    const { q, changes } = make(null, true);
    run(q, 80, 1000);
    expect([q.tier, q.mode, changes]).toEqual(['high', 'still', []]);
  });

  it('ignores frames while the page is hidden', () => {
    let hidden = true;
    const changes: Tier[] = [];
    const q = createQuality({ url: null, still: false, hidden: () => hidden, onChange: (t) => changes.push(t) });
    run(q, 500, 200);
    expect(changes).toEqual([]);
    hidden = false;
    run(q, 10, 1000);
    expect(changes).toEqual([]);
    expect(q.tier).toBe('high');
  });

  it('restartWindow drops what was collected', () => {
    const { q, changes } = make(null);
    run(q, 40, 60);
    q.restartWindow();
    run(q, 40, 60);
    expect(changes).toEqual([]);
  });

  it('records each tier it runs', () => {
    const { q } = make(null);
    run(q, 40, 85);
    q.setTier('low');
    expect(q.history).toEqual(['high', 'medium', 'low']);
  });

  it('setTier switches, tells the page, and ends the automatic choice', () => {
    const { q, changes } = make(null);
    q.setTier('low');
    run(q, 4, 1000);
    expect([q.tier, q.mode, changes]).toEqual(['low', 'forced', ['low']]);
  });
});
