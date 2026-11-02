import { describe, expect, it } from 'vitest';
import { BUILD_KEYS, buildAction } from './build-keys';
import { CAMERA_KEYS } from './camera-keys';

const press = (key: string, over: Partial<Parameters<typeof buildAction>[0]> = {}) => ({
  key,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...over,
});

describe('buildAction', () => {
  it('reads each key of the table', () => {
    for (const row of BUILD_KEYS) for (const key of row.keys) expect(buildAction(press(key), false)).toBe(row.action);
  });

  it('ignores case, so Caps Lock and Shift do not matter', () => {
    expect(buildAction(press('B'), false)).toBe('build');
    expect(buildAction(press('Escape'), false)).toBe('cancel');
  });

  it('leaves a key alone with a modifier, held down, under a sheet or typed into a field', () => {
    expect(buildAction(press('b', { ctrlKey: true }), false)).toBeNull();
    expect(buildAction(press('b', { metaKey: true }), false)).toBeNull();
    expect(buildAction(press('b', { altKey: true }), false)).toBeNull();
    expect(buildAction(press('b', { repeat: true }), false)).toBeNull();
    expect(buildAction(press('b'), true)).toBeNull();
    expect(buildAction(press('b', { target: { tagName: 'INPUT', type: 'text' } }), false)).toBeNull();
    expect(buildAction(press('b', { target: { tagName: 'SELECT' } }), false)).toBeNull();
  });

  it('ignores keys that are not its own', () => {
    expect(buildAction(press('q'), false)).toBeNull();
    expect(buildAction(press('Shift'), false)).toBeNull();
  });
});

describe('the table', () => {
  it('takes no key the camera, the playback or photo mode uses', () => {
    const taken = new Set([...CAMERA_KEYS.flatMap((k) => k.keys), 'j', 'k', 'l', 'h', 'm', ' ', '?']);
    for (const row of BUILD_KEYS) for (const key of row.keys) expect(taken.has(key), key).toBe(false);
  });

  it('has each key once', () => {
    const keys = BUILD_KEYS.flatMap((k) => k.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
