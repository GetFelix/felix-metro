// The ambient sound, made with the Web Audio API. Day is filtered noise for traffic, night is a field recording of
// crickets (one small Ogg file, see prototype/assets/CREDITS.md), and a rewind is a swept noise burst. The browser only
// lets a page start audio from a click or key press, so nothing here exists until `enable` is called from one.
import { mixAt, nextSwell, startOffset } from './soundscape-mix';

export interface Soundscape {
  /** Whether the sound is switched on. */
  readonly on: boolean;
  /** Start the sound. Call it from a click or key press. False when the browser has no audio or refuses it. */
  enable(): boolean;
  /**
   * Whether the audio is running, a moment after `enable`. False when the browser did not count the click or key press
   * as a gesture and left the context suspended, so the caller can try again on the next one.
   */
  settled(): Promise<boolean>;
  disable(): void;
  /** The hour of the city, 0 to 24; the mix follows it. */
  setHour(hour: number): void;
  /** A short sweep for going back in time. Silent while the sound is off. */
  whoosh(): void;
}

type ContextFactory = () => AudioContext;

/** Fetches and decodes the night recording. Rejects when the file is missing; the page then has no crickets. */
type ClipLoader = (ctx: AudioContext) => Promise<AudioBuffer>;

const CRICKETS_URL = 'assets/audio/night-crickets.ogg';

const fetchCrickets: ClipLoader = async (ctx) => {
  const res = await fetch(CRICKETS_URL);
  if (!res.ok) throw new Error(`${CRICKETS_URL}: ${res.status}`);
  return ctx.decodeAudioData(await res.arrayBuffer());
};

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
/** How loud the recording plays at full night, before the master level. */
const CRICKETS_LEVEL = 0.5;

/**
 * Two seconds of brown noise, which loops without a click; brown noise is the low rumble a street makes. The walk runs
 * on past the end, and the start is faded from that run-on into the walk, so the step from the last sample back to the
 * first is as small as any other.
 */
export function brownNoise(ctx: Pick<AudioContext, 'sampleRate' | 'createBuffer'>): AudioBuffer {
  const length = ctx.sampleRate * 2;
  const seam = Math.floor(ctx.sampleRate * 0.05);
  const walk = new Float32Array(length + seam);
  let last = 0;
  for (let i = 0; i < walk.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    walk[i] = last * 3.5;
  }
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  data.set(walk.subarray(0, length));
  for (let i = 0; i < seam; i++) {
    const t = i / seam;
    data[i] = walk[i]! * t + walk[length + i]! * (1 - t);
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

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  traffic: GainNode;
  crickets: GainNode;
  /** Wanders the crickets' level so the recording never sounds like the same bar twice. */
  texture: GainNode;
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
  // The recording sits well under the traffic bed; it is a texture, not a feature.
  const level = ctx.createGain();
  level.gain.value = CRICKETS_LEVEL;
  level.connect(crickets);
  const texture = ctx.createGain();
  texture.gain.value = 1;
  texture.connect(level);

  return { ctx, master, traffic, crickets, texture, hum, hiss: whiteNoise(ctx) };
}

/** What the ambient sound needs to know about the page being on screen. */
export interface PageVisibility {
  hidden(): boolean;
  onChange(cb: () => void): void;
}

const pageVisibility = (): PageVisibility | null =>
  typeof document === 'undefined'
    ? null
    : { hidden: () => document.hidden, onChange: (cb) => document.addEventListener('visibilitychange', cb) };

/** How long to wait for a context to start running before taking it that the browser did not count the gesture. */
const START_MS = 300;

/** The sound, created lazily: no AudioContext exists until the first `enable`. */
export function createSoundscape(
  open: ContextFactory = pageAudio,
  visibility: PageVisibility | null = pageVisibility(),
  loadClip: ClipLoader = fetchCrickets,
  random: () => number = Math.random,
): Soundscape {
  let graph: Graph | null = null;
  let on = false;
  let hour = 12;
  let watching = false;
  let parked: ReturnType<typeof setTimeout> | undefined;
  let starting: Promise<boolean> = Promise.resolve(false);
  let wander: ReturnType<typeof setTimeout> | undefined;
  let heard = false;

  // The recording loops from a random point, and its level drifts at random gaps, so a long night has no fixed beat.
  const drift = (g: Graph) => {
    const { gap, level } = nextSwell(random);
    g.texture.gain.setTargetAtTime(level, g.ctx.currentTime, gap / 3);
    wander = setTimeout(() => drift(g), gap * 1000);
  };

  const hear = (g: Graph) => {
    if (heard) return;
    heard = true;
    loadClip(g.ctx).then(
      (clip) => {
        if (graph !== g) return;
        const source = g.ctx.createBufferSource();
        source.buffer = clip;
        source.loop = true;
        // A soft roll-off keeps the highest insects from glinting.
        const soft = g.ctx.createBiquadFilter();
        soft.type = 'lowpass';
        soft.frequency.value = 6500;
        source.connect(soft).connect(g.texture);
        source.start(0, startOffset(random, clip.duration));
      },
      // No file, no crickets; the night is traffic and quiet, and the next `enable` tries again.
      () => {
        heard = false;
      },
    );
  };

  const mix = () => {
    if (!graph || !on) return;
    const { ctx, traffic, crickets } = graph;
    const levels = mixAt(hour);
    traffic.gain.setTargetAtTime(levels.traffic, ctx.currentTime, EASE);
    crickets.gain.setTargetAtTime(levels.crickets, ctx.currentTime, EASE);
  };

  const resume = (ctx: AudioContext) =>
    Promise.race([ctx.resume().catch(() => {}), new Promise((done) => setTimeout(done, START_MS))]).then(
      () => ctx.state === 'running',
    );

  // A hidden tab makes no sound, and iOS can interrupt a context; both come back when the page does.
  const watch = () => {
    if (watching || !visibility) return;
    watching = true;
    visibility.onChange(() => {
      if (!graph || !on) return;
      const { ctx } = graph;
      if (visibility.hidden()) void ctx.suspend().catch(() => {});
      else if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    });
  };

  return {
    get on() {
      return on;
    },
    enable() {
      try {
        clearTimeout(parked);
        if (!graph) {
          const ctx = open();
          try {
            graph = build(ctx);
          } catch (err) {
            void ctx.close?.().catch(() => {});
            throw err;
          }
        }
        watch();
        starting = resume(graph.ctx);
        on = true;
        hear(graph);
        clearTimeout(wander);
        drift(graph);
        graph.master.gain.setTargetAtTime(MASTER, graph.ctx.currentTime, FADE);
        mix();
        return true;
      } catch {
        // The next attempt may do better, so nothing is remembered about this one.
        graph = null;
        on = false;
        heard = false;
        return false;
      }
    },
    settled: () => starting,
    disable() {
      on = false;
      clearTimeout(wander);
      if (!graph) return;
      const { ctx, master } = graph;
      try {
        master.gain.setTargetAtTime(0, ctx.currentTime, FADE);
        // Park the context once the fade is out, so a muted page spends nothing.
        clearTimeout(parked);
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
