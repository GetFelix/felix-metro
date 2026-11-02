import { describe, expect, it } from 'vitest';
import type { Ambient } from '../ambient';
import { UNAVAILABLE_TEXT, createSoundMemory, createSoundSwitch, isSoundKey, type SoundStorage } from './sound';

const storage = (): SoundStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

function fakeAmbient(works = true) {
  const a = {
    on: false,
    enabled: 0,
    enable: () => {
      a.enabled++;
      a.on = works;
      return works;
    },
    disable: () => void (a.on = false),
    setHour: () => {},
    whoosh: () => {},
  };
  return a satisfies Ambient & { enabled: number };
}

function setup(opts: { remembered?: boolean; works?: boolean; blocked?: boolean } = {}) {
  const store = storage();
  if (opts.remembered !== undefined) store.data.set('felix-metro.sound', opts.remembered ? '1' : '0');
  const memory = createSoundMemory(() =>
    opts.blocked
      ? {
          getItem: () => {
            throw new Error('blocked');
          },
          setItem: () => {
            throw new Error('blocked');
          },
        }
      : store,
  );
  const ambient = fakeAmbient(opts.works ?? true);
  const told: string[] = [];
  const changes: boolean[] = [];
  let gesture: (() => void) | null = null;
  const sw = createSoundSwitch({
    ambient,
    memory,
    tell: (t) => told.push(t),
    onGesture: (cb) => {
      gesture = cb;
      return () => (gesture = null);
    },
    onChange: (on) => changes.push(on),
  });
  return { sw, ambient, store, told, changes, touch: () => gesture?.(), waiting: () => gesture !== null };
}

describe('the sound switch', () => {
  it('is off, and makes no audio, until it is toggled', () => {
    const { sw, ambient, changes, waiting } = setup();
    expect(sw.on).toBe(false);
    expect(ambient.enabled).toBe(0);
    expect(changes).toEqual([false]);
    expect(waiting()).toBe(false);
  });

  it('turns on and off, and remembers', () => {
    const { sw, ambient, store, changes } = setup();
    sw.toggle();
    expect(sw.on).toBe(true);
    expect(ambient.on).toBe(true);
    expect(store.data.get('felix-metro.sound')).toBe('1');
    sw.toggle();
    expect(sw.on).toBe(false);
    expect(ambient.on).toBe(false);
    expect(store.data.get('felix-metro.sound')).toBe('0');
    expect(changes).toEqual([false, true, false]);
  });

  it('says so and stays off when the browser has no audio', () => {
    const { sw, told, changes, store } = setup({ works: false });
    sw.toggle();
    expect(sw.on).toBe(false);
    expect(told).toEqual([UNAVAILABLE_TEXT]);
    expect(changes.at(-1)).toBe(false);
    expect(store.data.get('felix-metro.sound')).toBe('0');
  });

  it('works with storage blocked', () => {
    const { sw, ambient } = setup({ blocked: true });
    expect(() => sw.toggle()).not.toThrow();
    expect(ambient.on).toBe(true);
  });

  it('shows sound left on as on, and starts it at the first click or key', () => {
    const { sw, ambient, touch, waiting } = setup({ remembered: true });
    expect(sw.on).toBe(true);
    expect(ambient.enabled).toBe(0);
    expect(waiting()).toBe(true);
    touch();
    expect(ambient.on).toBe(true);
  });

  it('switches sound left on off when the button is used before any other click', () => {
    const { sw, ambient, waiting, store } = setup({ remembered: true });
    sw.toggle();
    expect(sw.on).toBe(false);
    expect(ambient.enabled).toBe(0);
    expect(waiting()).toBe(false);
    expect(store.data.get('felix-metro.sound')).toBe('0');
  });

  it('gives up quietly when the first click cannot start the sound', () => {
    const { sw, touch, told, changes } = setup({ remembered: true, works: false });
    touch();
    expect(sw.on).toBe(false);
    expect(told).toEqual([]);
    expect(changes.at(-1)).toBe(false);
  });
});

describe('the sound key', () => {
  const press = (over: object = {}) => ({
    key: 'm',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...over,
  });
  it('is M alone', () => {
    expect(isSoundKey(press())).toBe(true);
    expect(isSoundKey(press({ key: 'M' }))).toBe(true);
    expect(isSoundKey(press({ key: 'n' }))).toBe(false);
    expect(isSoundKey(press({ metaKey: true }))).toBe(false);
    expect(isSoundKey(press({ ctrlKey: true }))).toBe(false);
    expect(isSoundKey(press({ repeat: true }))).toBe(false);
  });
  it('leaves typing alone', () => {
    expect(isSoundKey(press({ target: { tagName: 'INPUT', type: 'text' } }))).toBe(false);
    expect(isSoundKey(press({ target: { tagName: 'BUTTON' } }))).toBe(true);
  });
  it('does not clash with the camera or shuttle keys', async () => {
    const { CAMERA_KEYS } = await import('../camera-keys');
    expect(CAMERA_KEYS.flatMap((k) => k.keys)).not.toContain('m');
    const { shuttleKey } = await import('../shuttle');
    expect(shuttleKey({ key: 'm', ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });
});
