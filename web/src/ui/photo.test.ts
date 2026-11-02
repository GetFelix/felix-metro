import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPhoto, isPhotoKey } from './photo';

const press = (key: string, extra: Partial<Record<'repeat' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
  key,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

describe('isPhotoKey', () => {
  it('is a plain H, either case', () => {
    expect(isPhotoKey(press('h'), null, false)).toBe(true);
    expect(isPhotoKey(press('H'), null, false)).toBe(true);
  });

  it('leaves H alone with a modifier, held down, in a field or under a sheet', () => {
    expect(isPhotoKey(press('h', { ctrlKey: true }), null, false)).toBe(false);
    expect(isPhotoKey(press('h', { metaKey: true }), null, false)).toBe(false);
    expect(isPhotoKey(press('h', { repeat: true }), null, false)).toBe(false);
    expect(isPhotoKey(press('h'), { tagName: 'INPUT', type: 'text' }, false)).toBe(false);
    expect(isPhotoKey(press('h'), null, true)).toBe(false);
    expect(isPhotoKey(press('j'), null, false)).toBe(false);
  });
});

// A page with just a body class list and a keydown listener the test fires by hand.
function page(sheetOpen = false) {
  const classes = new Set<string>();
  let onKey: ((e: unknown) => void) | undefined;
  vi.stubGlobal('document', {
    body: {
      classList: {
        contains: (c: string) => classes.has(c),
        toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)),
      },
    },
  });
  vi.stubGlobal('addEventListener', (type: string, fn: (e: unknown) => void) => {
    if (type === 'keydown') onKey = fn;
  });
  const photo = createPhoto(() => sheetOpen);
  const send = (key: string) => {
    const e = { ...press(key), target: null, preventDefault: vi.fn() };
    onKey!(e);
    return e;
  };
  return { photo, send };
}

afterEach(() => vi.unstubAllGlobals());

describe('photo mode', () => {
  it('H hides the controls and H or Esc brings them back', () => {
    const { photo, send } = page();
    expect(photo.on).toBe(false);
    send('h');
    expect(photo.on).toBe(true);
    send('h');
    expect(photo.on).toBe(false);
    send('h');
    send('Escape');
    expect(photo.on).toBe(false);
  });

  it('does not take Esc when it is off, and does not turn on under a sheet', () => {
    const { photo, send } = page();
    expect(send('Escape').preventDefault).not.toHaveBeenCalled();
    expect(photo.on).toBe(false);
    const open = page(true);
    open.send('h');
    expect(open.photo.on).toBe(false);
  });
});
