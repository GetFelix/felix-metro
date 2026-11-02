import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraRig } from './camera';
import { bindInput } from './camera-input';

type Handler = (e: never) => void;

/** A canvas and a window that only record their listeners, so a test can fire events by hand. */
function setup() {
  const dom = new Map<string, Handler>();
  const win = new Map<string, Handler>();
  const captured = new Set<number>();
  const el = {
    style: { touchAction: '' },
    clientHeight: 500,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
    addEventListener: (type: string, h: Handler) => void dom.set(type, h),
    removeEventListener: (type: string, h: Handler) => void (dom.get(type) === h && dom.delete(type)),
    setPointerCapture: vi.fn((id: number) => void captured.add(id)),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => void captured.delete(id)),
  };
  vi.stubGlobal('addEventListener', (type: string, h: Handler) => void win.set(type, h));
  vi.stubGlobal('removeEventListener', (type: string, h: Handler) => void (win.get(type) === h && win.delete(type)));
  const rig = {
    enabled: true,
    orbit: vi.fn(),
    grab: vi.fn(),
    zoomAt: vi.fn(),
    hold: vi.fn(),
    reset: vi.fn(),
    releaseAll: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  const unbind = bindInput(rig as unknown as CameraRig, el as unknown as HTMLElement);
  const fire = (to: Map<string, Handler>, type: string, e: object) => to.get(type)?.(e as never);
  return {
    el,
    rig,
    unbind,
    dom,
    win,
    onDom: (type: string, e: object) => fire(dom, type, { preventDefault: vi.fn(), ...e }),
    onWin: (type: string, e: object) => fire(win, type, { preventDefault: vi.fn(), ...e }),
  };
}

const mouse = (extra: object = {}) => ({ pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1, ...extra });
const finger = (id: number, x: number, y: number) => ({ pointerType: 'touch', pointerId: id, clientX: x, clientY: y });
const key = (k: string, extra: object = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  ...extra,
});

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('the mouse', () => {
  it('turns on a left drag, a full turn per screen height', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', mouse({ clientX: 100, clientY: 100 }));
    onDom('pointermove', mouse({ clientX: 150, clientY: 120 }));
    const k = (Math.PI * 2) / 500;
    expect(rig.orbit).toHaveBeenCalledWith(-50 * k, -20 * k);
    expect(rig.grab).not.toHaveBeenCalled();
  });

  it('slides on a right drag or a Shift drag, holding the ground under the pointer', () => {
    for (const down of [mouse({ button: 2, buttons: 2 }), mouse({ shiftKey: true })]) {
      const { rig, onDom } = setup();
      onDom('pointerdown', { ...down, clientX: 500, clientY: 250 });
      onDom('pointermove', { ...down, clientX: 625, clientY: 250 });
      expect(rig.grab).toHaveBeenCalledWith({ x: 0, y: 0 }, { x: 0.25, y: 0 }, true);
      expect(rig.orbit).not.toHaveBeenCalled();
    }
  });

  it('ignores the middle button', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', mouse({ button: 1, buttons: 4, clientX: 1, clientY: 1 }));
    onDom('pointermove', mouse({ button: 1, buttons: 4, clientX: 50, clientY: 1 }));
    expect(rig.orbit).not.toHaveBeenCalled();
  });

  it('captures the pointer on press and releases it on release', () => {
    const { el, onDom } = setup();
    onDom('pointerdown', mouse({ clientX: 1, clientY: 1 }));
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    onDom('pointerup', mouse({ buttons: 0 }));
    expect(el.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('stops turning after release, and when a move arrives with no button down', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', mouse({ clientX: 10, clientY: 10 }));
    onDom('pointerup', mouse({ buttons: 0 }));
    onDom('pointermove', mouse({ clientX: 90, clientY: 10 }));
    expect(rig.orbit).not.toHaveBeenCalled();
    // The release happened outside the page: the next move says no button is down.
    onDom('pointerdown', mouse({ clientX: 10, clientY: 10 }));
    onDom('pointermove', mouse({ buttons: 0, clientX: 90, clientY: 10 }));
    onDom('pointermove', mouse({ clientX: 120, clientY: 10 }));
    expect(rig.orbit).not.toHaveBeenCalled();
  });

  it('does nothing while the rig is disabled, and carries on from the new place when it is enabled again', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', mouse({ clientX: 100, clientY: 100 }));
    rig.enabled = false;
    onDom('pointermove', mouse({ clientX: 300, clientY: 100 }));
    expect(rig.orbit).not.toHaveBeenCalled();
    rig.enabled = true;
    onDom('pointermove', mouse({ clientX: 310, clientY: 100 }));
    expect(rig.orbit).toHaveBeenCalledWith(-10 * ((Math.PI * 2) / 500), -0);
  });

  it('does not start a drag while the rig is disabled', () => {
    const { rig, el, onDom } = setup();
    rig.enabled = false;
    onDom('pointerdown', mouse({ clientX: 1, clientY: 1 }));
    expect(el.setPointerCapture).not.toHaveBeenCalled();
  });

  it('keeps the browser from showing a context menu', () => {
    const { onDom } = setup();
    const preventDefault = vi.fn();
    onDom('contextmenu', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });
});

describe('touch', () => {
  it('turns with one finger', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', finger(1, 100, 100));
    onDom('pointermove', finger(1, 120, 100));
    expect(rig.orbit).toHaveBeenCalledTimes(1);
  });

  it('slides and zooms with two, by how far the fingers spread', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', finger(1, 400, 250));
    onDom('pointerdown', finger(2, 600, 250));
    onDom('pointermove', finger(2, 850, 250));
    // The middle moved from 500 to 625 and the spread from 200 to 450.
    expect(rig.grab).toHaveBeenCalledWith({ x: 0, y: 0 }, { x: 0.25, y: 0 }, true);
    expect(rig.zoomAt).toHaveBeenCalledWith({ x: 0.25, y: 0 }, 200 / 450);
    expect(rig.orbit).not.toHaveBeenCalled();
  });

  it('does not call a pinch’s wobble a move of the view', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', finger(1, 400, 250));
    onDom('pointerdown', finger(2, 600, 250));
    onDom('pointermove', finger(2, 640, 252));
    expect(rig.grab).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), false);
    // The middle drifted 20 px so far; another 20 is a slide.
    onDom('pointermove', finger(2, 680, 252));
    expect(rig.grab).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), true);
  });

  it('does not jump when a second finger lands or lifts', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', finger(1, 100, 100));
    onDom('pointermove', finger(1, 110, 100));
    rig.orbit.mockClear();
    onDom('pointerdown', finger(2, 700, 100));
    onDom('pointermove', finger(2, 700, 100));
    const [a, b] = rig.grab.mock.calls.at(-1)!;
    expect(a).toEqual(b);
    onDom('pointerup', finger(2, 700, 100));
    onDom('pointermove', finger(1, 112, 100));
    expect(rig.orbit).toHaveBeenCalledTimes(1);
    expect(rig.orbit.mock.calls[0]![0]).toBeCloseTo(-2 * ((Math.PI * 2) / 500));
  });

  it('turns again with the finger left after the other lifts', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', finger(1, 100, 100));
    onDom('pointerdown', finger(2, 300, 100));
    onDom('pointerup', finger(1, 100, 100));
    onDom('pointermove', finger(2, 310, 100));
    expect(rig.orbit).toHaveBeenCalledTimes(1);
  });

  it('keeps the positions of a third finger up to date, so the next move after one lifts is a step', () => {
    const { rig, onDom } = setup();
    onDom('pointerdown', finger(1, 100, 100));
    onDom('pointerdown', finger(2, 300, 100));
    onDom('pointerdown', finger(3, 500, 100));
    // Three fingers apply nothing, but they keep moving.
    onDom('pointermove', finger(1, 400, 100));
    onDom('pointermove', finger(2, 600, 100));
    onDom('pointermove', finger(3, 800, 100));
    expect(rig.grab).not.toHaveBeenCalled();
    expect(rig.orbit).not.toHaveBeenCalled();
    onDom('pointerup', finger(3, 800, 100));
    onDom('pointermove', finger(2, 610, 100));
    // The pair is at 400 and 610 now: the middle moved 5 px, not the 250 px since the fingers went down.
    const [from, to] = rig.grab.mock.calls[0]!;
    expect(from.x).toBeCloseTo(0, 9);
    expect(to.x).toBeCloseTo(0.01, 9);
  });

  it('lets go of a finger on pointercancel', () => {
    const { rig, el, onDom } = setup();
    onDom('pointerdown', finger(1, 100, 100));
    onDom('pointercancel', finger(1, 100, 100));
    expect(el.releasePointerCapture).toHaveBeenCalledWith(1);
    onDom('pointermove', finger(1, 200, 100));
    expect(rig.orbit).not.toHaveBeenCalled();
  });

  it('turns the page off touch scrolling', () => {
    const { el } = setup();
    expect(el.style.touchAction).toBe('none');
  });
});

describe('the wheel', () => {
  const zoomFactor = (rig: ReturnType<typeof setup>['rig']) => rig.zoomAt.mock.calls[0]![1] as number;

  it('zooms toward the pointer and keeps the page from scrolling', () => {
    const { rig, onDom } = setup();
    const preventDefault = vi.fn();
    onDom('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, clientX: 750, clientY: 125, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(rig.zoomAt).toHaveBeenCalledWith({ x: 0.5, y: 0.5 }, Math.exp(100 * 0.0015));
  });

  it('turns lines and pages into pixels, so a notched wheel and a smooth one agree', () => {
    const a = setup();
    a.onDom('wheel', { deltaY: 3, deltaMode: 1, ctrlKey: false, clientX: 0, clientY: 0 });
    expect(zoomFactor(a.rig)).toBeCloseTo(Math.exp(48 * 0.0015));
    const b = setup();
    b.onDom('wheel', { deltaY: 0.1, deltaMode: 2, ctrlKey: false, clientX: 0, clientY: 0 });
    expect(zoomFactor(b.rig)).toBeCloseTo(Math.exp(50 * 0.0015));
  });

  it('caps one event, so a flung wheel does not cross the whole range', () => {
    const { rig, onDom } = setup();
    onDom('wheel', { deltaY: 5000, deltaMode: 0, ctrlKey: false, clientX: 0, clientY: 0 });
    expect(zoomFactor(rig)).toBeCloseTo(Math.exp(240 * 0.0015));
    onDom('wheel', { deltaY: -5000, deltaMode: 0, ctrlKey: false, clientX: 0, clientY: 0 });
    expect(rig.zoomAt.mock.calls[1]![1]).toBeCloseTo(Math.exp(-240 * 0.0015));
  });

  it('zooms faster for a pinch, which arrives as a wheel with Ctrl held', () => {
    const { rig, onDom } = setup();
    onDom('wheel', { deltaY: 5, deltaMode: 0, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(zoomFactor(rig)).toBeCloseTo(Math.exp(5 * 0.01));
  });

  it('still stops the page scrolling while disabled, but does not zoom', () => {
    const { rig, onDom } = setup();
    rig.enabled = false;
    const preventDefault = vi.fn();
    onDom('wheel', { deltaY: 10, deltaMode: 0, ctrlKey: false, clientX: 0, clientY: 0, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(rig.zoomAt).not.toHaveBeenCalled();
  });
});

describe('a Safari trackpad pinch', () => {
  it('zooms by the change in the running scale and keeps the page from zooming', () => {
    const { rig, onDom } = setup();
    const preventDefault = vi.fn();
    onDom('gesturestart', { scale: 1, preventDefault });
    onDom('gesturechange', { scale: 2, clientX: 500, clientY: 250, preventDefault });
    onDom('gesturechange', { scale: 4, clientX: 500, clientY: 250, preventDefault });
    onDom('gestureend', { preventDefault });
    expect(rig.zoomAt.mock.calls).toEqual([
      [{ x: 0, y: 0 }, 0.5],
      [{ x: 0, y: 0 }, 0.5],
    ]);
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });

  it('does not zoom while disabled, and stops listening when unbound', () => {
    const { rig, onDom, dom, unbind } = setup();
    rig.enabled = false;
    onDom('gesturechange', { scale: 2, clientX: 0, clientY: 0 });
    expect(rig.zoomAt).not.toHaveBeenCalled();
    unbind();
    expect(dom.has('gesturechange')).toBe(false);
  });
});

describe('keys', () => {
  it('holds a camera key while it is down and lets it go on keyup', () => {
    const { rig, onWin } = setup();
    onWin('keydown', key('w'));
    expect(rig.hold).toHaveBeenCalledWith('panForward', true);
    onWin('keyup', key('W'));
    expect(rig.hold).toHaveBeenCalledWith('panForward', false);
  });

  it('keeps the browser from acting on a camera key, and leaves other keys alone', () => {
    const { rig, onWin } = setup();
    const preventDefault = vi.fn();
    onWin('keydown', key('ArrowLeft', { preventDefault }));
    expect(preventDefault).not.toHaveBeenCalled();
    onWin('keydown', key('d', { preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(rig.hold).toHaveBeenCalledTimes(1);
  });

  it('resets once per press, not on key repeat', () => {
    const { rig, onWin } = setup();
    onWin('keydown', key('0'));
    onWin('keydown', key('0', { repeat: true }));
    expect(rig.reset).toHaveBeenCalledTimes(1);
  });

  it('ignores keys typed into a text field but not into a checkbox', () => {
    const { rig, onWin } = setup();
    onWin('keydown', key('w', { target: { tagName: 'INPUT', type: 'text' } }));
    expect(rig.hold).not.toHaveBeenCalled();
    onWin('keydown', key('w', { target: { tagName: 'INPUT', type: 'checkbox' } }));
    expect(rig.hold).toHaveBeenCalledWith('panForward', true);
  });

  it('does not move on keys while disabled', () => {
    const { rig, onWin } = setup();
    rig.enabled = false;
    onWin('keydown', key('w'));
    expect(rig.hold).not.toHaveBeenCalled();
  });

  it('lets go of every key when Cmd or Ctrl goes down, since the browser drops the keyup of a key released under it', () => {
    for (const mod of ['metaKey', 'ctrlKey']) {
      const { rig, onWin } = setup();
      onWin('keydown', key('w'));
      expect(rig.releaseAll).not.toHaveBeenCalled();
      onWin('keydown', key('Meta', { [mod]: true }));
      expect(rig.releaseAll).toHaveBeenCalledTimes(1);
    }
  });

  it('lets go of every key when the window loses focus', () => {
    const { rig, onWin } = setup();
    onWin('blur', {});
    expect(rig.releaseAll).toHaveBeenCalledTimes(1);
  });

  it('survives a key event with no key, as autofill sends', () => {
    const { rig, onWin } = setup();
    expect(() => onWin('keyup', { ctrlKey: false, metaKey: false, altKey: false })).not.toThrow();
    expect(() => onWin('keydown', { ctrlKey: false, metaKey: false, altKey: false })).not.toThrow();
    expect(rig.hold).not.toHaveBeenCalled();
  });
});

describe('unbind', () => {
  it('removes every listener', () => {
    const { dom, win, unbind } = setup();
    expect(dom.size).toBeGreaterThan(0);
    expect(win.size).toBe(3);
    unbind();
    expect(dom.size).toBe(0);
    expect(win.size).toBe(0);
  });
});
