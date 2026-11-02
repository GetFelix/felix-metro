import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brownNoise, createAmbient, type PageVisibility } from './ambient';
import { mixAt } from './ambient-mix';

// Just enough of the Web Audio API for the sound to build its graph, recording what it asks for.
class Param {
  value = 0;
  targets: number[] = [];
  setTargetAtTime(v: number) {
    this.targets.push(v);
  }
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class Node {
  gain = new Param();
  frequency = new Param();
  Q = new Param();
  type = '';
  buffer: unknown = null;
  loop = false;
  started = 0;
  connect(to: unknown) {
    return to;
  }
  start() {
    this.started++;
  }
  stop() {}
}
let made: FakeContext[] = [];
class FakeContext {
  sampleRate = 8000;
  currentTime = 0;
  state = 'suspended';
  /** What `resume` does: the browser lets it run, or leaves it suspended as it does without a gesture. */
  allowed = true;
  destination = new Node();
  nodes: Node[] = [];
  resumed = 0;
  suspended = 0;
  closed = 0;
  constructor() {
    made.push(this);
  }
  private node() {
    const n = new Node();
    this.nodes.push(n);
    return n;
  }
  createGain = () => this.node();
  createOscillator = () => this.node();
  createBiquadFilter = () => this.node();
  createBufferSource = () => this.node();
  createBuffer = (_channels: number, length: number) => {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  };
  resume = () => {
    this.resumed++;
    if (this.allowed) this.state = 'running';
    return Promise.resolve();
  };
  suspend = () => {
    this.suspended++;
    this.state = 'suspended';
    return Promise.resolve();
  };
  close = () => (this.closed++, Promise.resolve());
  targets = () => this.nodes.flatMap((n) => n.gain.targets);
  sources = () => this.nodes.filter((n) => n.buffer !== null && n.started > 0).length;
}
const open = () => new FakeContext() as unknown as AudioContext;

function page() {
  const listeners: (() => void)[] = [];
  const visibility: PageVisibility & { shown: boolean; change(shown: boolean): void } = {
    shown: true,
    hidden() {
      return !visibility.shown;
    },
    onChange: (cb) => void listeners.push(cb),
    change(shown) {
      visibility.shown = shown;
      listeners.forEach((cb) => cb());
    },
  };
  return visibility;
}

beforeEach(() => {
  made = [];
});
afterEach(() => vi.useRealTimers());

describe('the ambient sound', () => {
  it('makes no audio context until it is switched on', () => {
    const ambient = createAmbient(open, page());
    ambient.setHour(3);
    ambient.whoosh();
    ambient.disable();
    expect(made).toHaveLength(0);
    expect(ambient.on).toBe(false);
  });

  it('makes one context however often it is switched on and off', () => {
    const ambient = createAmbient(open, page());
    expect(ambient.enable()).toBe(true);
    ambient.disable();
    expect(ambient.enable()).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0]!.resumed).toBe(2);
    expect(ambient.on).toBe(true);
  });

  it('follows the hour', () => {
    const ambient = createAmbient(open, page());
    // Not the hour it starts at, so the first assertion is about what `setHour` did.
    ambient.setHour(2);
    ambient.enable();
    expect(made[0]!.targets()).toContain(mixAt(2).crickets);
    ambient.setHour(13);
    expect(made[0]!.targets()).toContain(mixAt(13).traffic);
  });

  it('whooshes only while it is on', () => {
    const ambient = createAmbient(open, page());
    ambient.enable();
    const before = made[0]!.sources();
    ambient.whoosh();
    expect(made[0]!.sources()).toBe(before + 1);
    ambient.disable();
    ambient.whoosh();
    expect(made[0]!.sources()).toBe(before + 1);
  });

  it('refuses without throwing when the browser will not give it audio, and tries again next time', () => {
    let tries = 0;
    let blocked = true;
    const ambient = createAmbient(() => {
      tries++;
      if (blocked) throw new Error('blocked');
      return open();
    }, page());
    expect(ambient.enable()).toBe(false);
    expect(ambient.on).toBe(false);
    expect(() => {
      ambient.setHour(5);
      ambient.whoosh();
      ambient.disable();
    }).not.toThrow();
    blocked = false;
    expect(ambient.enable()).toBe(true);
    expect(tries).toBe(2);
  });

  it('closes a context whose graph it could not build', () => {
    const ambient = createAmbient(() => {
      const ctx = new FakeContext();
      ctx.createGain = () => {
        throw new Error('no gain');
      };
      return ctx as unknown as AudioContext;
    }, page());
    expect(ambient.enable()).toBe(false);
    expect(made[0]!.closed).toBe(1);
  });
});

describe('suspending', () => {
  it('suspends the context once the fade out is done', () => {
    vi.useFakeTimers();
    const ambient = createAmbient(open, page());
    ambient.enable();
    ambient.disable();
    expect(made[0]!.suspended).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(made[0]!.suspended).toBe(1);
  });

  it('does not suspend a context that was switched back on during the fade', () => {
    vi.useFakeTimers();
    const ambient = createAmbient(open, page());
    ambient.enable();
    ambient.disable();
    vi.advanceTimersByTime(1000);
    ambient.enable();
    vi.advanceTimersByTime(5000);
    expect(made[0]!.suspended).toBe(0);
    expect(made[0]!.state).toBe('running');
  });

  it('keeps one pending suspend however often it is switched off', () => {
    vi.useFakeTimers();
    const ambient = createAmbient(open, page());
    ambient.enable();
    ambient.disable();
    ambient.disable();
    vi.advanceTimersByTime(5000);
    expect(made[0]!.suspended).toBe(1);
  });

  it('suspends while the page is hidden and resumes when it is shown, only while on', () => {
    const visibility = page();
    const ambient = createAmbient(open, visibility);
    ambient.enable();
    visibility.change(false);
    expect(made[0]!.suspended).toBe(1);
    visibility.change(true);
    expect(made[0]!.state).toBe('running');
    ambient.disable();
    const resumed = made[0]!.resumed;
    visibility.change(false);
    visibility.change(true);
    expect(made[0]!.resumed).toBe(resumed);
  });

  it('resumes an interrupted context when the page is shown', () => {
    const visibility = page();
    const ambient = createAmbient(open, visibility);
    ambient.enable();
    made[0]!.state = 'interrupted';
    const resumed = made[0]!.resumed;
    visibility.change(true);
    expect(made[0]!.resumed).toBe(resumed + 1);
  });
});

describe('starting', () => {
  it('says the audio is running once the browser lets it', async () => {
    const ambient = createAmbient(open, page());
    ambient.enable();
    expect(await ambient.settled()).toBe(true);
  });

  it('says it is not when the browser leaves the context suspended', async () => {
    vi.useFakeTimers();
    const ambient = createAmbient(() => {
      const ctx = new FakeContext();
      ctx.allowed = false;
      return ctx as unknown as AudioContext;
    }, page());
    ambient.enable();
    const settled = ambient.settled();
    await vi.advanceTimersByTimeAsync(400);
    expect(await settled).toBe(false);
    expect(ambient.on).toBe(true);
  });
});

describe('the traffic loop', () => {
  // A walk the same every time, so the check does not depend on luck.
  const seeded = (seed: number) => {
    let x = seed;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x / 4294967296;
    });
  };
  afterEach(() => vi.restoreAllMocks());

  it('steps from its last sample to its first no further than anywhere else in it', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      seeded(seed);
      const ctx = new FakeContext();
      const data = brownNoise(ctx as unknown as AudioContext).getChannelData(0);
      let largest = 0;
      for (let i = 1; i < data.length; i++) largest = Math.max(largest, Math.abs(data[i]! - data[i - 1]!));
      expect(Math.abs(data[0]! - data[data.length - 1]!), `seed ${seed}`).toBeLessThanOrEqual(largest);
      vi.restoreAllMocks();
    }
  });
});
