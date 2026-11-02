import { describe, expect, it } from 'vitest';
import { RATES, rateText, shuttle, shuttleKey, type ShuttleKey, type Transport } from './shuttle';

const press = (from: Transport, ...keys: ShuttleKey[]) => keys.reduce(shuttle, from);
const stopped: Transport = { rate: 1, paused: true };
const effective = (t: Transport) => (t.paused ? 0 : t.rate);

describe('shuttle', () => {
  it('starts forward at 1x with L and backward at 1x with J from a stop', () => {
    expect(shuttle(stopped, 'l')).toEqual({ rate: 1, paused: false });
    expect(shuttle(stopped, 'j')).toEqual({ rate: -1, paused: false });
    // A stop remembers a direction, but a fresh press starts over at 1x.
    expect(shuttle({ rate: -4, paused: true }, 'l')).toEqual({ rate: 1, paused: false });
  });

  it('goes a rung faster forward for each L, up to 8x', () => {
    const rates = [];
    let t = shuttle(stopped, 'l');
    for (let i = 0; i < 6; i++, t = shuttle(t, 'l')) rates.push(t.rate);
    expect(rates).toEqual([1, 2, 4, 8, 8, 8]);
  });

  it('goes a rung faster backward for each J, up to 8x', () => {
    const rates = [];
    let t = shuttle(stopped, 'j');
    for (let i = 0; i < 6; i++, t = shuttle(t, 'j')) rates.push(t.rate);
    expect(rates).toEqual([-1, -2, -4, -8, -8, -8]);
  });

  it('slows a rewind with L and a forward play with J, stopping before it turns round', () => {
    expect(press({ rate: -4, paused: false }, 'l')).toEqual({ rate: -2, paused: false });
    expect(effective(press({ rate: -1, paused: false }, 'l'))).toBe(0);
    expect(shuttle({ rate: -1, paused: true }, 'l')).toEqual({ rate: 1, paused: false });
    expect(press({ rate: 2, paused: false }, 'j')).toEqual({ rate: 1, paused: false });
  });

  it('reaches half speed from 1x with J, and stops below it', () => {
    expect(press({ rate: 1, paused: false }, 'j')).toEqual({ rate: 0.5, paused: false });
    expect(press({ rate: 0.5, paused: false }, 'j')).toEqual({ rate: 0.5, paused: true });
    expect(press({ rate: 0.5, paused: false }, 'l')).toEqual({ rate: 1, paused: false });
  });

  it('stops with K, keeping the rate for Space to resume', () => {
    expect(shuttle({ rate: -4, paused: false }, 'k')).toEqual({ rate: -4, paused: true });
    expect(shuttle({ rate: -4, paused: true }, 'k')).toEqual({ rate: -4, paused: true });
  });

  it('only ever lands on a rung of the ladder', () => {
    const keys: ShuttleKey[] = ['j', 'k', 'l'];
    const seen = new Set<number>();
    let t: Transport = { rate: 1, paused: false };
    for (let i = 0; i < 400; i++) {
      t = shuttle(t, keys[(i * 7 + (i >> 2)) % 3]!);
      seen.add(t.rate);
    }
    for (const r of seen) expect(RATES).toContain(r);
  });
});

describe('shuttleKey', () => {
  const key = (k: string, extra: object = {}) =>
    shuttleKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra });

  it('reads J, K and L in either case', () => {
    expect(['j', 'J', 'k', 'K', 'l', 'L'].map((k) => key(k))).toEqual(['j', 'j', 'k', 'k', 'l', 'l']);
  });

  it('leaves the keys the camera, the timeline and the page own alone', () => {
    for (const k of [
      'w',
      'a',
      's',
      'd',
      'q',
      'e',
      '+',
      '-',
      '0',
      'f',
      ' ',
      'ArrowLeft',
      'Home',
      'End',
      '?',
      'Escape',
    ]) {
      expect(key(k)).toBeNull();
    }
  });

  it('ignores a browser shortcut', () => {
    expect(key('l', { ctrlKey: true })).toBeNull();
    expect(key('l', { metaKey: true })).toBeNull();
    expect(key('j', { altKey: true })).toBeNull();
  });

  it('ignores keys typed into a field', () => {
    expect(key('k', { target: { tagName: 'INPUT' } })).toBeNull();
    expect(key('k', { target: { tagName: 'textarea' } })).toBeNull();
    expect(key('k', { target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
    expect(key('k', { target: { tagName: 'BUTTON' } })).toBe('k');
    // A range or checkbox takes no typed text, so the keys still work with one focused.
    expect(key('k', { target: { tagName: 'INPUT', type: 'range' } })).toBe('k');
  });
});

describe('rateText', () => {
  it('names a pace and a direction', () => {
    expect(rateText(0.5)).toBe('0.5x');
    expect(rateText(4)).toBe('4x');
    expect(rateText(-2)).toBe('Rewind 2x');
  });
});
