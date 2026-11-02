import { beforeEach, describe, expect, it } from 'vitest';
import { createAmbient } from './ambient';
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
  destination = new Node();
  nodes: Node[] = [];
  resumed = 0;
  suspended = 0;
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
  createBuffer = (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) });
  resume = () => (this.resumed++, Promise.resolve());
  suspend = () => (this.suspended++, Promise.resolve());
  targets = () => this.nodes.flatMap((n) => n.gain.targets);
  sources = () => this.nodes.filter((n) => n.buffer !== null && n.started > 0).length;
}
const open = () => new FakeContext() as unknown as AudioContext;

beforeEach(() => {
  made = [];
});

describe('the ambient sound', () => {
  it('makes no audio context until it is switched on', () => {
    const ambient = createAmbient(open);
    ambient.setHour(3);
    ambient.whoosh();
    ambient.disable();
    expect(made).toHaveLength(0);
    expect(ambient.on).toBe(false);
  });

  it('makes one context however often it is switched on and off', () => {
    const ambient = createAmbient(open);
    expect(ambient.enable()).toBe(true);
    ambient.disable();
    expect(ambient.enable()).toBe(true);
    expect(made).toHaveLength(1);
    expect(made[0]!.resumed).toBe(2);
    expect(ambient.on).toBe(true);
  });

  it('follows the hour', () => {
    const ambient = createAmbient(open);
    ambient.enable();
    ambient.setHour(12);
    expect(made[0]!.targets()).toContain(mixAt(12).traffic);
    ambient.setHour(0);
    expect(made[0]!.targets()).toContain(mixAt(0).crickets);
  });

  it('whooshes only while it is on', () => {
    const ambient = createAmbient(open);
    ambient.enable();
    const before = made[0]!.sources();
    ambient.whoosh();
    expect(made[0]!.sources()).toBe(before + 1);
    ambient.disable();
    ambient.whoosh();
    expect(made[0]!.sources()).toBe(before + 1);
  });

  it('refuses without throwing when the browser will not give it audio', () => {
    let tries = 0;
    const ambient = createAmbient(() => {
      tries++;
      throw new Error('blocked');
    });
    expect(ambient.enable()).toBe(false);
    expect(ambient.on).toBe(false);
    expect(() => {
      ambient.setHour(5);
      ambient.whoosh();
      ambient.disable();
    }).not.toThrow();
    expect(ambient.enable()).toBe(false);
    expect(tries).toBe(1);
  });
});
