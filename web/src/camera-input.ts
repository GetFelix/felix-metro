// Turns mouse, trackpad, touch and keyboard events into moves on the camera. The maths lives in camera-math.ts.
import type { CameraRig } from './camera';
import { actionFor, keyAction } from './camera-keys';

/** Radians of turn per pixel of drag is a full turn per screen height, as Three.js's orbit controls have it. */
const TURN_PER_HEIGHT = Math.PI * 2;
/** Zoom per pixel of wheel travel; a pinch on a trackpad arrives as a wheel with Ctrl held and moves in small steps. */
const WHEEL_ZOOM = 0.0015;
const PINCH_ZOOM = 0.01;
const WHEEL_LIMIT = 240;

type Mode = 'orbit' | 'pan' | 'pinch';

/** Listen on `dom` for the pointer and on the window for keys. Returns a function that stops listening. */
export function bindInput(rig: CameraRig, dom: HTMLElement): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let mode: Mode | null = null;
  /** What the last move was measured from: one point, or the middle and spread of two fingers. */
  let from = { x: 0, y: 0, spread: 0 };

  const ndc = (x: number, y: number) => {
    const r = dom.getBoundingClientRect();
    return { x: ((x - r.left) / r.width) * 2 - 1, y: 1 - ((y - r.top) / r.height) * 2 };
  };
  const fingers = () => [...pointers.values()];
  const measure = () => {
    const [a, b] = fingers();
    if (!a) return { x: 0, y: 0, spread: 0 };
    if (!b) return { x: a.x, y: a.y, spread: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  // Touch decides by how many fingers are down, so a second finger landing switches from turning to moving.
  const touchMode = (): Mode | null => (pointers.size === 1 ? 'orbit' : pointers.size === 2 ? 'pinch' : null);

  const down = (e: PointerEvent) => {
    if (!rig.enabled) return;
    const touch = e.pointerType !== 'mouse';
    if (!touch && e.button !== 0 && e.button !== 2) return;
    if (!touch) pointers.clear();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    mode = touch ? touchMode() : e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
    from = measure();
    dom.setPointerCapture?.(e.pointerId);
    rig.dispatchEvent({ type: 'start' });
  };

  const move = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p || !mode || !rig.enabled) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) return up(e);
    [p.x, p.y] = [e.clientX, e.clientY];
    const now = measure();
    if (mode === 'orbit') {
      const k = TURN_PER_HEIGHT / dom.clientHeight;
      rig.orbit(-(now.x - from.x) * k, -(now.y - from.y) * k);
    } else {
      rig.grab(ndc(from.x, from.y), ndc(now.x, now.y));
      if (mode === 'pinch' && from.spread > 0 && now.spread > 0)
        rig.zoomAt(ndc(now.x, now.y), from.spread / now.spread);
    }
    from = now;
  };

  const up = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (dom.hasPointerCapture?.(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    mode = e.pointerType === 'mouse' ? null : touchMode();
    from = measure();
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!rig.enabled) return;
    // Lines and pages are turned into pixels so a notched wheel and a smooth one zoom alike.
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? dom.clientHeight : 1);
    const travel = Math.max(-WHEEL_LIMIT, Math.min(WHEEL_LIMIT, px));
    rig.zoomAt(ndc(e.clientX, e.clientY), Math.exp(travel * (e.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM)));
  };

  const keyDown = (e: KeyboardEvent) => {
    const action = actionFor(e);
    if (!action || !rig.enabled) return;
    e.preventDefault();
    if (action === 'reset') {
      if (e.repeat) return;
      rig.dispatchEvent({ type: 'start' });
      rig.reset();
    } else rig.hold(action, true);
  };
  const keyUp = (e: KeyboardEvent) => {
    const action = keyAction(e.key);
    if (action && action !== 'reset') rig.hold(action, false);
  };
  const letGo = () => rig.releaseAll();
  const noMenu = (e: Event) => e.preventDefault();

  dom.style.touchAction = 'none';
  dom.addEventListener('pointerdown', down);
  dom.addEventListener('pointermove', move);
  dom.addEventListener('pointerup', up);
  dom.addEventListener('pointercancel', up);
  dom.addEventListener('wheel', wheel, { passive: false });
  dom.addEventListener('contextmenu', noMenu);
  addEventListener('keydown', keyDown);
  addEventListener('keyup', keyUp);
  addEventListener('blur', letGo);

  return () => {
    dom.removeEventListener('pointerdown', down);
    dom.removeEventListener('pointermove', move);
    dom.removeEventListener('pointerup', up);
    dom.removeEventListener('pointercancel', up);
    dom.removeEventListener('wheel', wheel);
    dom.removeEventListener('contextmenu', noMenu);
    removeEventListener('keydown', keyDown);
    removeEventListener('keyup', keyUp);
    removeEventListener('blur', letGo);
  };
}
