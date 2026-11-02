import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from './attribution';
import { LINGER_MS, createLotHover, type LotHover, type Say } from './lot-hover';

type Shown = { text: string; link: string | null; at: { x: number; y: number } };

function setup(over: { hidden?: boolean } = {}) {
  const canvas = new EventTarget();
  const lots = new Map<string, number>([
    ['10,10', 7],
    ['20,20', 8],
  ]);
  const says = new Map<number, Say>([
    [7, { parts: { before: 'Built by ', name: 'Ana', after: ' · Day 2, 09:12' }, goUp: 1000 }],
    [8, { parts: { before: 'Here since the start', name: '', after: '' }, goUp: null }],
  ]);
  const card = { shown: null as Shown | null, run: null as (() => void) | null, visible: false, hid: 0 };
  const fake: Card = {
    get visible() {
      return card.visible;
    },
    show(parts, link, at) {
      card.visible = true;
      card.run = link?.run ?? null;
      card.shown = { text: parts.before + parts.name + parts.after, link: link?.label ?? null, at };
    },
    hide() {
      card.visible = false;
      card.hid++;
    },
  };
  const state = { hidden: over.hidden ?? false };
  const went: number[] = [];
  const hover: LotHover = createLotHover({
    canvas,
    pick: (x, y) => lots.get(`${x},${y}`) ?? null,
    say: (lot) => says.get(lot) ?? null,
    card: fake,
    goUp: (tick) => went.push(tick),
    hidden: () => state.hidden,
  });
  const fire = (type: string, p: Record<string, unknown>) => {
    const e = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      buttons: 0,
      ...p,
    });
    canvas.dispatchEvent(e);
    return e;
  };
  return { fire, card, hover, state, went, lots, says };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => vi.useRealTimers());

describe('hovering with a mouse', () => {
  it('shows who built the building under the pointer, with the link', () => {
    const { fire, card } = setup();
    fire('pointermove', { clientX: 10, clientY: 10 });
    expect(card.shown).toEqual({ text: 'Built by Ana · Day 2, 09:12', link: 'See it go up', at: { x: 10, y: 10 } });
  });

  it('shows nothing over ground with nothing on it', () => {
    const { fire, card } = setup();
    fire('pointermove', { clientX: 1, clientY: 1 });
    expect(card.shown).toBeNull();
  });

  it('stays a moment after the pointer leaves, so the card can be reached, then goes', () => {
    const { fire, card } = setup();
    fire('pointermove', { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(100);
    fire('pointermove', { clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(LINGER_MS - 1);
    expect(card.visible).toBe(true);
    vi.advanceTimersByTime(2);
    expect(card.visible).toBe(false);
  });

  it('stays while the pointer is on the card', () => {
    const { fire, card, hover } = setup();
    fire('pointermove', { clientX: 10, clientY: 10 });
    fire('pointerleave', {});
    hover.onCard(true);
    vi.advanceTimersByTime(5 * LINGER_MS);
    expect(card.visible).toBe(true);
    hover.onCard(false);
    vi.advanceTimersByTime(LINGER_MS + 1);
    expect(card.visible).toBe(false);
  });

  it('goes the moment a button goes down, and does not come back during the drag', () => {
    const { fire, card } = setup();
    fire('pointermove', { clientX: 10, clientY: 10 });
    fire('pointerdown', { buttons: 1 });
    expect(card.visible).toBe(false);
    vi.advanceTimersByTime(100);
    fire('pointermove', { clientX: 10, clientY: 10, buttons: 1 });
    vi.advanceTimersByTime(100);
    expect(card.visible).toBe(false);
  });

  it('does not bring the card back for a move that was waiting when a button went down', () => {
    const { fire, card } = setup();
    fire('pointermove', { clientX: 1, clientY: 1 });
    fire('pointermove', { clientX: 10, clientY: 10 });
    fire('pointerdown', { buttons: 1 });
    vi.advanceTimersByTime(500);
    expect(card.visible).toBe(false);
  });

  it('never stops an event, so the camera still gets every one', () => {
    const { fire } = setup();
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'wheel']) {
      expect(fire(type, { clientX: 10, clientY: 10 }).defaultPrevented, type).toBe(false);
    }
  });

  it('shows nothing in photo mode', () => {
    const { fire, card, state } = setup({ hidden: true });
    fire('pointermove', { clientX: 10, clientY: 10 });
    expect(card.shown).toBeNull();
    state.hidden = false;
    vi.advanceTimersByTime(100);
    fire('pointermove', { clientX: 10, clientY: 10 });
    expect(card.shown).not.toBeNull();
  });

  it('hides the card and asks the page to go there when the link is used', () => {
    const { fire, card, went } = setup();
    fire('pointermove', { clientX: 10, clientY: 10 });
    card.run!();
    expect(went).toEqual([1000]);
    expect(card.visible).toBe(false);
  });

  it('gives a building with no known start a card without the link', () => {
    const { fire, card } = setup();
    fire('pointermove', { clientX: 20, clientY: 20 });
    expect(card.shown).toEqual({ text: 'Here since the start', link: null, at: { x: 20, y: 20 } });
  });
});

describe('tapping', () => {
  const touch = { pointerType: 'touch' };

  it('opens the card on a tap and closes it on a tap elsewhere', () => {
    const { fire, card } = setup();
    fire('pointerdown', { ...touch, clientX: 10, clientY: 10 });
    fire('pointerup', { ...touch, clientX: 10, clientY: 10 });
    expect(card.visible).toBe(true);
    fire('pointerdown', { ...touch, clientX: 1, clientY: 1 });
    fire('pointerup', { ...touch, clientX: 1, clientY: 1 });
    expect(card.visible).toBe(false);
  });

  it('does not open on a drag', () => {
    const { fire, card } = setup();
    fire('pointerdown', { ...touch, clientX: 30, clientY: 30 });
    fire('pointermove', { ...touch, clientX: 10, clientY: 10 });
    fire('pointerup', { ...touch, clientX: 10, clientY: 10 });
    expect(card.visible).toBe(false);
  });

  it('does not open on a pinch', () => {
    const { fire, card } = setup();
    fire('pointerdown', { ...touch, pointerId: 1, clientX: 10, clientY: 10 });
    fire('pointerdown', { ...touch, pointerId: 2, clientX: 50, clientY: 50 });
    fire('pointerup', { ...touch, pointerId: 2, clientX: 50, clientY: 50 });
    fire('pointerup', { ...touch, pointerId: 1, clientX: 10, clientY: 10 });
    expect(card.visible).toBe(false);
  });

  it('does not open on a long press', () => {
    const { fire, card } = setup();
    fire('pointerdown', { ...touch, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(900);
    fire('pointerup', { ...touch, clientX: 10, clientY: 10 });
    expect(card.visible).toBe(false);
  });
});

describe('a scene that changes under a card', () => {
  const show = (t: ReturnType<typeof setup>) => {
    t.fire('pointermove', { clientX: 10, clientY: 10 });
    expect(t.card.visible).toBe(true);
    vi.advanceTimersByTime(100);
  };

  it('hides the card when its building is demolished', () => {
    const t = setup();
    show(t);
    t.says.delete(7);
    t.hover.refresh();
    expect(t.card.visible).toBe(false);
  });

  it('rewrites the card when a seek changes who built the lot or when', () => {
    const t = setup();
    show(t);
    t.says.set(7, { parts: { before: 'Built by ', name: 'Bo', after: ' · Day 1, 08:00' }, goUp: 500 });
    t.hover.refresh();
    expect(t.card.shown).toEqual({ text: 'Built by Bo · Day 1, 08:00', link: 'See it go up', at: { x: 10, y: 10 } });
    t.card.run?.();
    expect(t.went).toEqual([500]);
  });

  it('hides the card when the camera moves the building from under the pointer', () => {
    const t = setup();
    show(t);
    t.lots.delete('10,10');
    t.hover.refresh();
    expect(t.card.visible).toBe(false);
  });

  it('keeps the card while the pointer is on it, since it is not over the city then', () => {
    const t = setup();
    show(t);
    t.hover.onCard(true);
    t.lots.delete('10,10');
    t.hover.refresh();
    expect(t.card.visible).toBe(true);
    t.says.delete(7);
    vi.advanceTimersByTime(100);
    t.hover.refresh();
    expect(t.card.visible).toBe(false);
  });

  it('leaves an unchanged card alone', () => {
    const t = setup();
    show(t);
    const shown = t.card.shown;
    vi.advanceTimersByTime(100);
    t.hover.refresh();
    expect(t.card.shown).toBe(shown);
    expect(t.card.visible).toBe(true);
  });
});
