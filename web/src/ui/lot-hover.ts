// Watches the pointer over the city and asks the card to say who built the building there. A mouse hovers; a finger
// taps. Nothing here stops or captures an event, so the camera's drags and pinches work the same with it on.
import type { Card } from './attribution';

/** What to say about a lot: the line, and the tick "See it go up" goes to when the building has a start. */
export interface Say {
  text: string;
  goUp: number | null;
}

export interface LotHoverOptions {
  canvas: EventTarget;
  /** The lot under a viewport point, or null. */
  pick(x: number, y: number): number | null;
  /** What the card says of a lot, or null when there is nothing to say. */
  say(lot: number): Say | null;
  card: Card;
  /** Take the page to `tick` and play it on. */
  goUp(tick: number): void;
  /** True while the overlay is out of the way, as in photo mode. */
  hidden(): boolean;
}

export interface LotHover {
  /** The card was entered or left; keeps the hover alive while the pointer is on the card. */
  onCard(inside: boolean): void;
  dispose(): void;
}

/** How long the card stays after the pointer leaves the building, so there is time to reach it. */
export const LINGER_MS = 350;
/** Picks are at most this far apart while the pointer moves. */
const PICK_EVERY_MS = 40;
/** A touch that moves further than this, or lasts longer than the tap time, is a drag. */
const TAP_SLOP = 8;
const TAP_MS = 500;

interface PointerLike {
  pointerType: string;
  pointerId: number;
  clientX: number;
  clientY: number;
  buttons: number;
}

export function createLotHover(o: LotHoverOptions): LotHover {
  let lot: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPick = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let onCard = false;
  /** The touches down now, so a second finger makes the gesture a pinch and not a tap. */
  const touches = new Map<number, { x: number; y: number; at: number; moved: boolean }>();

  const cancelHide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const hideNow = () => {
    cancelHide();
    // A move still waiting its turn would bring the card back over a drag.
    if (trailing) clearTimeout(trailing);
    trailing = null;
    lot = null;
    o.card.hide();
  };
  const hideSoon = () => {
    if (timer || !o.card.visible) return;
    timer = setTimeout(() => {
      timer = null;
      if (!onCard) hideNow();
    }, LINGER_MS);
  };
  const consider = (x: number, y: number) => {
    if (o.hidden()) return hideNow();
    const found = o.pick(x, y);
    if (found === null) return hideSoon();
    cancelHide();
    if (found === lot && o.card.visible) return;
    const say = o.say(found);
    if (!say) {
      lot = null;
      return hideSoon();
    }
    lot = found;
    const go = say.goUp;
    o.card.show(
      say.text,
      go === null
        ? null
        : {
            label: 'See it go up',
            run: () => {
              hideNow();
              o.goUp(go);
            },
          },
      { x, y },
    );
  };

  const move = (e: Event) => {
    const p = e as unknown as PointerLike;
    if (p.pointerType === 'touch') {
      const t = touches.get(p.pointerId);
      if (t && Math.hypot(p.clientX - t.x, p.clientY - t.y) > TAP_SLOP) t.moved = true;
      return;
    }
    // A button down is a camera drag.
    if (p.buttons !== 0) return;
    const now = performance.now();
    const run = () => {
      lastPick = performance.now();
      trailing = null;
      consider(p.clientX, p.clientY);
    };
    if (trailing) clearTimeout(trailing);
    trailing = null;
    if (now - lastPick >= PICK_EVERY_MS) run();
    else trailing = setTimeout(run, PICK_EVERY_MS - (now - lastPick));
  };
  const down = (e: Event) => {
    const p = e as unknown as PointerLike;
    if (p.pointerType === 'touch') {
      for (const t of touches.values()) t.moved = true;
      touches.set(p.pointerId, { x: p.clientX, y: p.clientY, at: performance.now(), moved: touches.size > 0 });
      return;
    }
    hideNow();
  };
  const up = (e: Event) => {
    const p = e as unknown as PointerLike;
    if (p.pointerType !== 'touch') return;
    const t = touches.get(p.pointerId);
    touches.delete(p.pointerId);
    if (!t || t.moved || performance.now() - t.at > TAP_MS || touches.size > 0) return;
    // A tap on a building opens the card, and a tap anywhere else closes it.
    if (o.hidden()) return hideNow();
    const found = o.pick(p.clientX, p.clientY);
    if (found === null || found === lot) return hideNow();
    consider(p.clientX, p.clientY);
  };
  const cancel = (e: Event) => {
    touches.delete((e as unknown as PointerLike).pointerId);
  };
  const leave = () => hideSoon();
  const away = () => hideNow();

  o.canvas.addEventListener('pointermove', move, { passive: true } as AddEventListenerOptions);
  o.canvas.addEventListener('pointerdown', down, { passive: true } as AddEventListenerOptions);
  o.canvas.addEventListener('pointerup', up, { passive: true } as AddEventListenerOptions);
  o.canvas.addEventListener('pointercancel', cancel, { passive: true } as AddEventListenerOptions);
  o.canvas.addEventListener('pointerleave', leave, { passive: true } as AddEventListenerOptions);
  o.canvas.addEventListener('wheel', away, { passive: true } as AddEventListenerOptions);

  return {
    onCard(inside) {
      onCard = inside;
      if (inside) cancelHide();
      else hideSoon();
    },
    dispose() {
      hideNow();
      if (trailing) clearTimeout(trailing);
      o.canvas.removeEventListener('pointermove', move);
      o.canvas.removeEventListener('pointerdown', down);
      o.canvas.removeEventListener('pointerup', up);
      o.canvas.removeEventListener('pointercancel', cancel);
      o.canvas.removeEventListener('pointerleave', leave);
      o.canvas.removeEventListener('wheel', away);
    },
  };
}
