import { describe, expect, it } from 'vitest';
import { actionFor, CAMERA_GESTURES, CAMERA_KEYS, isTyping, keyAction } from './camera-keys';

const press = (key: string, extra: Partial<Parameters<typeof actionFor>[0]> = {}) =>
  actionFor({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe('the key table', () => {
  it('gives every row a cap, a label and keys, and no key twice', () => {
    const seen = new Set<string>();
    for (const row of CAMERA_KEYS) {
      expect(row.keycap).not.toBe('');
      expect(row.label).not.toBe('');
      expect(row.keys.length).toBeGreaterThan(0);
      for (const k of row.keys) {
        expect(k).toBe(k.toLowerCase());
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('leaves the keys the rest of the page owns alone', () => {
    const taken = [
      'f',
      ' ',
      'arrowleft',
      'arrowright',
      'arrowup',
      'arrowdown',
      'escape',
      'home',
      'end',
      'pageup',
      'pagedown',
    ];
    for (const k of taken) expect(keyAction(k)).toBeNull();
  });

  it('describes the pointer and touch controls too', () => {
    expect(CAMERA_GESTURES.length).toBeGreaterThan(0);
    for (const g of CAMERA_GESTURES) expect(g.input && g.label).toBeTruthy();
  });
});

describe('actionFor', () => {
  it('reads each bound key, either case', () => {
    expect(press('w')).toBe('panForward');
    expect(press('W')).toBe('panForward');
    expect(press('a')).toBe('panLeft');
    expect(press('s')).toBe('panBack');
    expect(press('d')).toBe('panRight');
    expect(press('q')).toBe('rotateLeft');
    expect(press('e')).toBe('rotateRight');
    expect(press('+')).toBe('zoomIn');
    expect(press('=')).toBe('zoomIn');
    expect(press('-')).toBe('zoomOut');
    expect(press('0')).toBe('reset');
  });

  it('ignores a key with Ctrl, Meta or Alt held', () => {
    expect(press('w', { ctrlKey: true })).toBeNull();
    expect(press('0', { metaKey: true })).toBeNull();
    expect(press('-', { altKey: true })).toBeNull();
  });

  it('ignores keys typed into a text field', () => {
    expect(press('w', { target: { tagName: 'INPUT' } })).toBeNull();
    expect(press('w', { target: { tagName: 'textarea' } })).toBeNull();
    expect(press('w', { target: { tagName: 'SELECT' } })).toBeNull();
    expect(press('w', { target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
    expect(press('w', { target: { tagName: 'BUTTON' } })).toBe('panForward');
    expect(press('w', { target: null })).toBe('panForward');
  });
});

describe('isTyping', () => {
  it('is false for nothing', () => {
    expect(isTyping(undefined)).toBe(false);
  });
});
