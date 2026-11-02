// The ambient sound, made with the Web Audio API so the page ships no audio files. Day is filtered noise for traffic,
// night is pulsed tones for crickets, and a rewind is a swept noise burst. The browser only lets a page start audio
// from a click or key press, so nothing here exists until `enable` is called from one.
import { mixAt } from './ambient-mix';

export interface Ambient {
  /** Whether the sound is switched on. */
  readonly on: boolean;
  /** Start the sound. Call it from a click or key press. False when the browser has no audio or refuses it. */
  enable(): boolean;
  disable(): void;
  /** The hour of the city, 0 to 24; the mix follows it. */
  setHour(hour: number): void;
  /** A short sweep for going back in time. Silent while the sound is off. */
  whoosh(): void;
}

type ContextFactory = () => AudioContext;

/** A new context from the page's own audio; throws when the browser has none. */
function pageAudio(): AudioContext {
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('this browser has no audio');
  return new Ctor();
}

const MASTER = 0.5;
/** Seconds a layer takes to settle on a new level, so the hour never makes a step. */
const EASE = 1.2;
const FADE = 0.25;

/** Two seconds of brown noise, which loops without a click; brown noise is the low rumble a street makes. */
function brownNoise(ctx: AudioContext): AudioBuffer {
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  // Fade the ends into each other so the loop has no seam.
  const seam = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < seam; i++) {
    const t = i / seam;
    data[i] = data[i]! * t + data[length - seam + i]! * (1 - t);
  }
  return buffer;
}

/** Half a second of white noise, which has the high end a whoosh needs. */
function whiteNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate / 2), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  return buffer;
}

/** A tone that chirps: a carrier gated by a fast pulse, itself gated by a slow one. */
function cricket(ctx: AudioContext, into: AudioNode, pitch: number, pulse: number, burst: number): void {
  const carrier = ctx.createOscillator();
  carrier.frequency.value = pitch;
  const fast = ctx.createGain();
  const slow = ctx.createGain();
  fast.gain.value = 0.5;
  slow.gain.value = 0.5;
  for (const [rate, gain] of [
    [pulse, fast],
    [burst, slow],
  ] as const) {
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = rate;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(gain.gain);
    lfo.start();
  }
  carrier.connect(fast).connect(slow).connect(into);
  carrier.start();
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  traffic: GainNode;
  crickets: GainNode;
  hum: AudioBuffer;
  hiss: AudioBuffer;
}

function build(ctx: AudioContext): Graph {
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  const hum = brownNoise(ctx);

  const traffic = ctx.createGain();
  traffic.gain.value = 0;
  traffic.connect(master);
  const source = ctx.createBufferSource();
  source.buffer = hum;
  source.loop = true;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 420;
  // A slow swell, as passing cars come and go.
  const swell = ctx.createGain();
  swell.gain.value = 0.7;
  const drift = ctx.createOscillator();
  drift.frequency.value = 0.11;
  const driftDepth = ctx.createGain();
  driftDepth.gain.value = 0.3;
  drift.connect(driftDepth).connect(swell.gain);
  drift.start();
  source.connect(low).connect(swell).connect(traffic);
  source.start();

  const crickets = ctx.createGain();
  crickets.gain.value = 0;
  crickets.connect(master);
  const level = ctx.createGain();
  level.gain.value = 0.06;
  level.connect(crickets);
  cricket(ctx, level, 4300, 17, 1.3);
  cricket(ctx, level, 4750, 14, 0.9);

  return { ctx, master, traffic, crickets, hum, hiss: whiteNoise(ctx) };
}

/** The sound, created lazily: no AudioContext exists until the first `enable`. */
export function createAmbient(open: ContextFactory = pageAudio): Ambient {
  let graph: Graph | null = null;
  let on = false;
  let hour = 12;
  let refused = false;
  let parked: ReturnType<typeof setTimeout> | undefined;

  const mix = () => {
    if (!graph || !on) return;
    const { ctx, traffic, crickets } = graph;
    const levels = mixAt(hour);
    traffic.gain.setTargetAtTime(levels.traffic, ctx.currentTime, EASE);
    crickets.gain.setTargetAtTime(levels.crickets, ctx.currentTime, EASE);
  };

  return {
    get on() {
      return on;
    },
    enable() {
      if (refused) return false;
      try {
        clearTimeout(parked);
        graph ??= build(open());
        void graph.ctx.resume().catch(() => {});
        on = true;
        graph.master.gain.setTargetAtTime(MASTER, graph.ctx.currentTime, FADE);
        mix();
        return true;
      } catch {
        refused = true;
        graph = null;
        on = false;
        return false;
      }
    },
    disable() {
      on = false;
      if (!graph) return;
      const { ctx, master } = graph;
      try {
        master.gain.setTargetAtTime(0, ctx.currentTime, FADE);
        // Park the context once the fade is out, so a muted page spends nothing.
        parked = setTimeout(() => void ctx.suspend().catch(() => {}), 1500);
      } catch {
        // A context that has gone away is as quiet as we wanted.
      }
    },
    setHour(next) {
      hour = next;
      mix();
    },
    whoosh() {
      if (!graph || !on) return;
      try {
        const { ctx, master, hiss } = graph;
        const t = ctx.currentTime;
        const source = ctx.createBufferSource();
        source.buffer = hiss;
        source.loop = true;
        const sweep = ctx.createBiquadFilter();
        sweep.type = 'bandpass';
        sweep.Q.value = 1.4;
        sweep.frequency.setValueAtTime(2600, t);
        sweep.frequency.exponentialRampToValueAtTime(260, t + 0.7);
        const shape = ctx.createGain();
        shape.gain.setValueAtTime(0.0001, t);
        shape.gain.exponentialRampToValueAtTime(1.6, t + 0.08);
        shape.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        source.connect(sweep).connect(shape).connect(master);
        source.start(t);
        source.stop(t + 0.85);
      } catch {
        // A missed whoosh is not worth a message.
      }
    },
  };
}
