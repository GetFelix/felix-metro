import { afterEach, describe, expect, it, vi } from 'vitest';
import { passesFor } from './passes';
import {
  MIN_SAMPLES,
  PROBE_FRAMES,
  PROBE_GAPS,
  createQuality,
  decideTier,
  displayInterval,
  median,
  refreshFromGaps,
  settingsFor,
  stepDown,
} from './quality';
import type { Tier } from './params';

const frames = (ms: number, n = 60) => Array<number>(n).fill(ms);
// A 60 Hz display that sometimes makes its frame and mostly does not.
const slow60 = (ms: number) => [...frames(16.7, 12), ...frames(ms, 48)];

describe('median', () => {
  it('takes the middle of an odd list and the mean of the middle two of an even one', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('decideTier', () => {
  it('steps down one tier when the median is over the limit', () => {
    expect(decideTier('high', slow60(30), false)).toBe('medium');
    expect(decideTier('medium', slow60(30), false)).toBe('low');
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

describe('a display measured apart from the frames', () => {
  it('steps down a 60 Hz display whose every frame takes two refreshes', () => {
    // From the frames alone this is a 30 Hz display and is left on high for good.
    expect(decideTier('high', frames(33.3), false)).toBe('high');
    expect(decideTier('high', frames(33.3), false, 16.7)).toBe('medium');
  });

  it('still leaves a display that really runs at 30 Hz alone', () => {
    expect(decideTier('high', frames(33.3), false, 33.3)).toBe('high');
  });

  it('keeps the 22 ms floor on a 120 Hz display', () => {
    expect(decideTier('high', frames(20), false, 8.3)).toBe('high');
    expect(decideTier('high', frames(24), false, 8.3)).toBe('medium');
  });

  it('keeps a tier that makes its refresh', () => {
    expect(decideTier('high', frames(16.7), false, 16.7)).toBe('high');
  });
});

describe('measuring the display when the frames cannot say', () => {
  // Plays frames of `frameMs` until the quality asks to skip, then frames `refreshMs` apart while it measures.
  function run(frameMs: number, refreshMs: number) {
    const changed: Tier[] = [];
    const q = createQuality({ url: null, still: false, hidden: () => false, onChange: (t) => changed.push(t) });
    let now = 1000;
    let skipped = 0;
    for (let i = 0; i < 600 && changed.length === 0; i++) {
      if (q.skipFrame(now)) {
        skipped++;
        now += refreshMs;
      } else {
        q.tick(frameMs);
        now += frameMs;
      }
    }
    return { q, changed, skipped };
  }

  it('steps down a 60 Hz display that shows every frame twice', () => {
    const { changed, skipped, q } = run(33.3, 16.7);
    expect(changed).toEqual(['medium']);
    expect(skipped).toBeGreaterThanOrEqual(PROBE_GAPS);
    expect(q.refreshMs).toBeCloseTo(16.7);
  });

  it('keeps a display that really runs at 30 Hz', () => {
    const { changed, skipped, q } = run(33.3, 33.3);
    expect(changed).toEqual([]);
    expect(skipped).toBeGreaterThanOrEqual(PROBE_GAPS);
    expect(q.refreshMs).toBeCloseTo(33.3);
  });

  it('does not stop a page whose frames are fast', () => {
    const { skipped } = run(12, 16.7);
    expect(skipped).toBe(0);
  });

  it('does not measure when the frames alone already say step down', () => {
    const { changed, skipped } = run(80, 16.7);
    expect(changed).toEqual(['medium']);
    expect(skipped).toBe(0);
  });

  it('draws again once it has the answer, or has waited long enough', () => {
    const q = createQuality({ url: null, still: false, hidden: () => false, onChange: () => {} });
    for (let i = 0; i < 200; i++) q.tick(33.3);
    let now = 0;
    let skips = 0;
    // A tab that is hidden gives frames too far apart to be a refresh rate; the probe must not wait for ever.
    while (q.skipFrame((now += 5000))) skips++;
    expect(skips).toBeLessThanOrEqual(PROBE_FRAMES);
    expect(q.skipFrame(now + 16.7)).toBe(false);
    expect(q.refreshMs).toBeNull();
  });

  it('ignores gaps from a stall when it reads the display', () => {
    expect(refreshFromGaps([...Array<number>(20).fill(16.7), 400, 900])).toBeCloseTo(16.7);
    expect(refreshFromGaps([16.7, 16.7])).toBeNull();
  });

  it('stops measuring when a tier is chosen by hand', () => {
    const q = createQuality({ url: null, still: false, hidden: () => false, onChange: () => {} });
    for (let i = 0; i < 200; i++) q.tick(33.3);
    expect(q.skipFrame(1000)).toBe(true);
    q.setTier('medium');
    expect(q.skipFrame(1017)).toBe(false);
  });

  it('does not measure a forced tier', () => {
    const q = createQuality({ url: 'high', still: false, hidden: () => false, onChange: () => {} });
    for (let i = 0; i < 200; i++) q.tick(33.3);
    expect(q.skipFrame(1000)).toBe(false);
  });
});

describe('settingsFor', () => {
  it('drops the look in steps: ambient occlusion, then tilt-shift, shadows and resolution', () => {
    expect(settingsFor('high')).toMatchObject({ ao: true, tiltShift: true, shadows: true, pixelRatioCap: 2 });
    expect(settingsFor('medium')).toMatchObject({ ao: false, tiltShift: true, shadows: true, pixelRatioCap: 2 });
    expect(settingsFor('low')).toMatchObject({ ao: false, tiltShift: false, shadows: false, pixelRatioCap: 1 });
  });

  it('caps the cars and walkers drawn by tier', () => {
    expect(settingsFor('high').movers).toBe(Infinity);
    expect(settingsFor('medium').movers).toBe(160);
    expect(settingsFor('low').movers).toBe(80);
  });

  it('allows pedestrian rigs only on high', () => {
    expect(settingsFor('high').rigs).toBe(true);
    expect(settingsFor('medium').rigs).toBe(false);
    expect(settingsFor('low').rigs).toBe(false);
  });

  it('draws less ambient life on lower tiers: low keeps the shop windows and nothing that moves', () => {
    const [high, medium, low] = (['high', 'medium', 'low'] as const).map((t) => settingsFor(t).ambient);
    expect(low).toEqual({ shops: true, smoke: 0, birds: 0, vans: 0, truck: false, signals: false });
    expect(medium!.smoke).toBeLessThan(high!.smoke);
    expect(medium!.birds).toBeLessThan(high!.birds);
    expect(medium!.vans).toBeLessThan(high!.vans);
    expect(medium).toMatchObject({ shops: true, truck: true, signals: true });
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
  // Every fifth frame makes 60 Hz, the rest take ms.
  function runSlow(q: ReturnType<typeof createQuality>, ms: number, count: number) {
    for (let i = 0; i < count; i++) q.tick(i % 5 === 0 ? 16.7 : ms);
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
    runSlow(q, 40, 100);
    expect(changes).toEqual(['medium']);
    runSlow(q, 40, 80);
    expect(changes).toEqual(['medium', 'low']);
    runSlow(q, 40, 500);
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
    runSlow(q, 40, 100);
    q.setTier('low');
    expect(q.history).toEqual(['high', 'medium', 'low']);
  });

  it('setTier switches, tells the page, and ends the automatic choice', () => {
    const { q, changes } = make(null);
    q.setTier('low');
    run(q, 4, 1000);
    expect([q.tier, q.mode, changes]).toEqual(['low', 'forced', ['low']]);
  });

  describe('setAutomatic', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('judges frames again from high after a tier was chosen by hand', () => {
      const { q, changes } = make(null);
      q.setTier('low');
      q.setAutomatic();
      expect([q.tier, q.mode, changes]).toEqual(['high', 'auto', ['low', 'high']]);
      runSlow(q, 40, 100);
      expect([q.tier, changes]).toEqual(['medium', ['low', 'high', 'medium']]);
    });

    it('overrides a tier from the URL', () => {
      const { q } = make('low');
      q.setAutomatic();
      expect([q.tier, q.mode]).toEqual(['high', 'auto']);
    });

    it('forgets the saved tier, so the next visit is automatic too', () => {
      const saved = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => saved.get(k) ?? null,
        setItem: (k: string, v: string) => void saved.set(k, v),
        removeItem: (k: string) => void saved.delete(k),
      });
      const { q } = make(null);
      q.setTier('medium');
      expect([...saved.values()]).toEqual(['medium']);
      q.setAutomatic();
      expect(saved.size).toBe(0);
      expect(make(null).q.mode).toBe('auto');
    });

    it('does not throw when storage is blocked', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      });
      const { q } = make(null);
      q.setTier('low');
      expect(() => q.setAutomatic()).not.toThrow();
      expect(q.mode).toBe('auto');
    });

    it('leaves a frozen scene frozen', () => {
      const { q, changes } = make(null, true);
      q.setTier('low');
      q.setAutomatic();
      run(q, 80, 1000);
      expect([q.tier, q.mode, changes]).toEqual(['high', 'still', ['low', 'high']]);
    });
  });
});
