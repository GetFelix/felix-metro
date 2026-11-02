// Tells a click or tap on the canvas from the start of a drag, so the page can pick what is under it without the
// camera's own drags picking anything. The camera's input is bound separately and sees the same events.
import type { Ndc } from './camera-math';

/** Pixels the pointer may wander and still be a click; a finger is less steady than a mouse. */
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 12;
/** A press held longer than this is not a click. */
const TAP_MS = 600;

export interface Tap {
  /** Where, in normalised device coordinates. */
  at: Ndc;
  touch: boolean;
}

export interface TapHandlers {
  /** A press and release in the same place, with no other pointer down. */
  tap(tap: Tap): void;
  /** The mouse moved over the canvas with no button down, or left it (null). */
  hover?(at: Ndc | null): void;
}

/** Listen on `dom`. Returns a function that stops listening. */
export function bindTap(dom: HTMLElement, on: TapHandlers, now: () => number = () => performance.now()): () => void {
  let down: { id: number; x: number; y: number; at: number; touch: boolean } | null = null;
  const pointers = new Set<number>();

  const ndc = (x: number, y: number): Ndc => {
    const r = dom.getBoundingClientRect();
    return { x: ((x - r.left) / r.width) * 2 - 1, y: 1 - ((y - r.top) / r.height) * 2 };
  };

  const onDown = (e: PointerEvent) => {
    const touch = e.pointerType !== 'mouse';
    // A mouse has one pointer; a stale id from a release the page missed must not block the next click.
    if (!touch) pointers.clear();
    pointers.add(e.pointerId);
    // A second finger, or a mouse button that is not the main one or is the pan modifier, is not a click.
    if (pointers.size > 1 || (!touch && (e.button !== 0 || e.shiftKey))) {
      down = null;
      return;
    }
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, at: now(), touch };
  };
  const onMove = (e: PointerEvent) => {
    if (down?.id === e.pointerId) {
      const slop = down.touch ? TOUCH_SLOP : MOUSE_SLOP;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop) down = null;
    } else if (e.pointerType === 'mouse' && e.buttons === 0) on.hover?.(ndc(e.clientX, e.clientY));
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    const d = down;
    if (!d || d.id !== e.pointerId) return;
    down = null;
    if (now() - d.at <= TAP_MS) on.tap({ at: ndc(e.clientX, e.clientY), touch: d.touch });
  };
  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (down?.id === e.pointerId) down = null;
  };
  const onLeave = () => on.hover?.(null);

  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('pointerleave', onLeave);
  return () => {
    dom.removeEventListener('pointerdown', onDown);
    dom.removeEventListener('pointermove', onMove);
    dom.removeEventListener('pointerup', onUp);
    dom.removeEventListener('pointercancel', onCancel);
    dom.removeEventListener('pointerleave', onLeave);
  };
}
