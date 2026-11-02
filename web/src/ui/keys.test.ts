import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAMERA_GESTURES, CAMERA_KEYS } from '../camera-keys';
import { SHORTCUTS, isHelpKey, isPlayKey, isTypingTarget } from './keys';

const flat = SHORTCUTS.flatMap((g) => g.rows.flatMap((r) => r.keys.flat()));

describe('the key list', () => {
  it('has groups, each with rows, each row with a key and an action', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const group of SHORTCUTS) {
      expect(group.title).not.toBe('');
      expect(group.rows.length).toBeGreaterThan(0);
      for (const row of group.rows) {
        expect(row.action).not.toBe('');
        expect(row.keys.length).toBeGreaterThan(0);
        for (const chord of row.keys) {
          expect(chord.length).toBeGreaterThan(0);
          for (const key of chord) expect(key).not.toBe('');
        }
      }
    }
  });

  it('names each group once', () => {
    const titles = SHORTCUTS.map((g) => g.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('lists the keys of today', () => {
    for (const key of ['←', '→', '↑', '↓', 'Shift', 'Page Up', 'Page Down', 'Home', 'End', 'Space', 'Esc', '?', 'Tab'])
      expect(flat).toContain(key);
  });

  it('has a row for every camera key and gesture', () => {
    const actions = SHORTCUTS.flatMap((g) => g.rows.map((r) => r.action));
    for (const key of CAMERA_KEYS) {
      expect(flat).toContain(key.keycap);
      expect(actions).toContain(key.label);
    }
    for (const gesture of CAMERA_GESTURES) expect(flat).toContain(gesture.input);
  });

  // The timeline answers to the keys in its handler; a key added there without a row here fails this.
  it('has a row for every key the timeline handles', () => {
    const names: Record<string, string> = {
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
      PageUp: 'Page Up',
      PageDown: 'Page Down',
      Home: 'Home',
      End: 'End',
    };
    const source = readFileSync(new URL('../timeline.ts', import.meta.url), 'utf8');
    const handled = [...source.matchAll(/e\.key === '(\w+)'/g)].map((m) => m[1]!);
    expect(handled.length).toBeGreaterThan(0);
    for (const key of handled) expect(flat, `no row for ${key}`).toContain(names[key] ?? key);
  });
});

describe('isHelpKey', () => {
  const press = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it('is the question mark', () => {
    expect(isHelpKey(press('?'))).toBe(true);
    expect(isHelpKey(press('/'))).toBe(false);
    expect(isHelpKey(press('h'))).toBe(false);
  });

  it('leaves the browser and system shortcuts alone', () => {
    expect(isHelpKey(press('?', { ctrlKey: true }))).toBe(false);
    expect(isHelpKey(press('?', { metaKey: true }))).toBe(false);
    expect(isHelpKey(press('?', { altKey: true }))).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('is true for text fields, text areas and editable content', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for buttons, sliders, radios and the page itself', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('isPlayKey', () => {
  const press = (key = ' ', mods: Partial<Record<'repeat' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
    key,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });
  // A target whose closest() finds only the tags it is given, like a control inside the page.
  const inside = (...tags: string[]) => ({ closest: (selector: string) => tags.find((t) => selector.includes(t)) });

  it('is Space on the page or on the timeline', () => {
    expect(isPlayKey(press(), null, false)).toBe(true);
    expect(isPlayKey(press(), inside('div'), false)).toBe(true);
  });

  it('leaves Space to a button, a field or a list', () => {
    for (const tag of ['button', 'input', 'select', 'textarea'])
      expect(isPlayKey(press(), inside(tag), false)).toBe(false);
  });

  it('is not Space held down, with a modifier, or under an open sheet', () => {
    expect(isPlayKey(press(' ', { repeat: true }), null, false)).toBe(false);
    expect(isPlayKey(press(' ', { ctrlKey: true }), null, false)).toBe(false);
    expect(isPlayKey(press(' ', { metaKey: true }), null, false)).toBe(false);
    expect(isPlayKey(press(' ', { altKey: true }), null, false)).toBe(false);
    expect(isPlayKey(press(), null, true)).toBe(false);
    expect(isPlayKey(press('a'), null, false)).toBe(false);
  });
});

describe('isTypingTarget for date and time fields', () => {
  it('is true for every kind a person types into', () => {
    for (const type of ['datetime-local', 'month', 'week'])
      expect(isTypingTarget({ tagName: 'INPUT', type })).toBe(true);
  });
});
