import { describe, expect, it, vi } from 'vitest';
import { bindTap } from './tap';

type Handler = (e: never) => void;

function setup() {
  const handlers = new Map<string, Handler>();
  const el = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }),
    addEventListener: (type: string, h: Handler) => void handlers.set(type, h),
    removeEventListener: (type: string, h: Handler) => void (handlers.get(type) === h && handlers.delete(type)),
  };
  let clock = 0;
  const tap = vi.fn();
  const hover = vi.fn();
  const unbind = bindTap(el as unknown as HTMLElement, { tap, hover }, () => clock);
  const fire = (type: string, e: object = {}) => handlers.get(type)?.(e as never);
  return {
    tap,
    hover,
    unbind,
    handlers,
    fire,
    wait: (ms: number) => (clock += ms),
  };
}

const mouse = (x: number, y: number, extra: object = {}) => ({
  pointerType: 'mouse',
  pointerId: 1,
  button: 0,
  buttons: 1,
  shiftKey: false,
  clientX: x,
  clientY: y,
  ...extra,
});
const finger = (id: number, x: number, y: number) => ({ pointerType: 'touch', pointerId: id, clientX: x, clientY: y });

describe('a click', () => {
  it('is a press and release in the same place, found in normalised device coordinates', () => {
    const { tap, fire } = setup();
    fire('pointerdown', mouse(750, 125));
    fire('pointerup', mouse(750, 125));
    expect(tap).toHaveBeenCalledWith({ at: { x: 0.5, y: 0.5 }, touch: false });
  });

  it('survives a wobble but not a drag', () => {
    const { tap, fire } = setup();
    fire('pointerdown', mouse(100, 100));
    fire('pointermove', mouse(103, 102));
    fire('pointerup', mouse(103, 102));
    expect(tap).toHaveBeenCalledTimes(1);
    fire('pointerdown', mouse(100, 100));
    fire('pointermove', mouse(130, 100));
    fire('pointerup', mouse(100, 100));
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('is not a long press, a right button or a shift-drag’s release', () => {
    const { tap, fire, wait } = setup();
    fire('pointerdown', mouse(100, 100));
    wait(700);
    fire('pointerup', mouse(100, 100));
    fire('pointerdown', mouse(100, 100, { button: 2 }));
    fire('pointerup', mouse(100, 100, { button: 2 }));
    fire('pointerdown', mouse(100, 100, { shiftKey: true }));
    fire('pointerup', mouse(100, 100, { shiftKey: true }));
    expect(tap).not.toHaveBeenCalled();
  });
});

describe('a tap', () => {
  it('allows a finger more wobble than a mouse', () => {
    const { tap, fire } = setup();
    fire('pointerdown', finger(1, 100, 100));
    fire('pointermove', finger(1, 108, 100));
    fire('pointerup', finger(1, 108, 100));
    expect(tap).toHaveBeenCalledWith(expect.objectContaining({ touch: true }));
  });

  it('is not made by the fingers of a pinch', () => {
    const { tap, fire } = setup();
    fire('pointerdown', finger(1, 100, 100));
    fire('pointerdown', finger(2, 300, 100));
    fire('pointerup', finger(2, 300, 100));
    fire('pointerup', finger(1, 100, 100));
    expect(tap).not.toHaveBeenCalled();
    fire('pointerdown', finger(3, 100, 100));
    fire('pointerup', finger(3, 100, 100));
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('is not made by a cancelled touch', () => {
    const { tap, fire } = setup();
    fire('pointerdown', finger(1, 100, 100));
    fire('pointercancel', finger(1, 100, 100));
    fire('pointerup', finger(1, 100, 100));
    expect(tap).not.toHaveBeenCalled();
  });
});

describe('hovering', () => {
  it('reports the mouse over the canvas with no button down, and leaving it', () => {
    const { hover, fire } = setup();
    fire('pointermove', mouse(500, 250, { buttons: 0 }));
    expect(hover).toHaveBeenCalledWith({ x: 0, y: 0 });
    fire('pointerleave');
    expect(hover).toHaveBeenLastCalledWith(null);
  });

  it('stays quiet during a drag', () => {
    const { hover, fire } = setup();
    fire('pointerdown', mouse(500, 250));
    fire('pointermove', mouse(520, 250));
    expect(hover).not.toHaveBeenCalled();
  });
});

describe('unbinding', () => {
  it('removes every listener', () => {
    const { unbind, handlers } = setup();
    expect(handlers.size).toBe(5);
    unbind();
    expect(handlers.size).toBe(0);
  });
});
