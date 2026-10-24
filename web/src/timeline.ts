// The timeline bar: the span the city still holds, days as bands, an hour tick for every city hour, the live tip at the
// right end and a handle that can be dragged or stepped with the arrow keys. The maths is plain functions; the bar
// itself only reports where the person put the handle and draws where it is told.
import { TICKS_PER_DAY, TICKS_PER_HOUR, cityTime } from './clock';

/** An arrow key moves the handle 15 city minutes; with shift, or on page up and down, an hour. */
export const STEP_TICKS = TICKS_PER_HOUR / 4;

/** The ticks the bar spans: the first moment that can be shown and the newest. */
export interface Range {
  oldest: number;
  newest: number;
}

export const clampTick = (range: Range, tick: number): number =>
  Math.min(range.newest, Math.max(range.oldest, Math.round(tick)));

/** The tick under a position along the bar, 0 at the oldest end and 1 at the newest. */
export function tickAtFraction(range: Range, fraction: number): number {
  return clampTick(range, range.oldest + fraction * (range.newest - range.oldest));
}

/** One city day: the bar never spans less, so a young city's live head creeps along a fixed scale. */
export const MIN_SPAN = TICKS_PER_DAY;

/** What the bar draws: its scale (`oldest` to `newest`) and where the live head sits on it. */
export interface Span extends Range {
  live: number;
}

/** The scale for a city holding `oldest` up to the live tip. Past the tip the bar shows time that has not happened. */
export function barSpan(oldest: number, tip: number): Span {
  const live = Math.max(tip, oldest + 1);
  return { oldest, newest: Math.max(live, oldest + MIN_SPAN), live };
}

/**
 * The span the bar maps the pointer through. A drag holds the span it began with: if the scale moved under a held
 * pointer, every move would read a different tick and the seeks would chase it. Updates during a drag are kept for
 * after the release.
 */
export function createSpanHold() {
  let latest = barSpan(0, 1);
  let held: Span | null = null;
  return {
    set(span: Span) {
      latest = span;
    },
    get current(): Span {
      return held ?? latest;
    },
    /** The span the drag began with, or null when none is held. */
    get held(): Span | null {
      return held;
    },
    hold() {
      held = latest;
    },
    release() {
      held = null;
    },
  };
}

/**
 * Whether a press starts a drag. Any primary press on the bar does, the live head included: the head sits at the
 * right end and a press on it is how the handle is picked up while live.
 */
export const startsDrag = (button: number): boolean => button === 0;

/** The tick under a position along the bar, never past the live head. */
export const tickAtPointer = (span: Span, fraction: number): number =>
  Math.min(span.live, tickAtFraction(span, fraction));

/** One step from `from`: 15 city minutes, or an hour when `big`. */
export function stepTick(range: Range, from: number, direction: 1 | -1, big: boolean): number {
  return clampTick(range, from + direction * (big ? TICKS_PER_HOUR : STEP_TICKS));
}

/** How long before the newest moment a tick is, in city time: `3 h 12 m ago`. */
export function agoText(ticks: number): string {
  // A tick is 15 city seconds.
  const minutes = Math.floor(Math.max(0, ticks) / 4);
  if (minutes < 1) return 'just now';
  return minutes < 60 ? `${minutes} m ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} m ago`;
}

/** A tick in words for a screen reader: `Day 3, 14:15`. */
export function momentText(tick: number): string {
  const { day, hour } = cityTime(tick);
  const hh = String(Math.floor(hour)).padStart(2, '0');
  const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
  return `Day ${day}, ${hh}:${mm}`;
}

export interface Band {
  day: number;
  /** The tick the day starts at, which can be before the oldest. */
  from: number;
  to: number;
}

/** The days the range touches, whole days, to be clipped by the bar. */
export function dayBands(range: Range): Band[] {
  const out: Band[] = [];
  for (let d = Math.floor(range.oldest / TICKS_PER_DAY); d * TICKS_PER_DAY <= range.newest; d++) {
    out.push({ day: d + 1, from: d * TICKS_PER_DAY, to: (d + 1) * TICKS_PER_DAY });
  }
  return out;
}

export interface Mark {
  tick: number;
  /** Every sixth hour. */
  major: boolean;
}

/** The city hours inside the range; past four days only the major ones, so the bar stays readable. */
export function hourMarks(range: Range): Mark[] {
  const out: Mark[] = [];
  const crowded = (range.newest - range.oldest) / TICKS_PER_HOUR > 96;
  for (let h = Math.ceil(range.oldest / TICKS_PER_HOUR); h * TICKS_PER_HOUR <= range.newest; h++) {
    const major = h % 6 === 0;
    if (major || !crowded) out.push({ tick: h * TICKS_PER_HOUR, major });
  }
  return out;
}

export interface TimelineHandlers {
  /** The handle was put at `tick` by the pointer (`drag` while it moves, `end` on release) or by Home (`key`). */
  onMove(tick: number, phase: 'drag' | 'end' | 'key'): void;
  /** An arrow key or page key asked for a step. */
  onStep(direction: 1 | -1, big: boolean): void;
  /** End, or a click on the live tip. */
  onLive(): void;
  /** The bar is in use (pointer over it, focus in it, or a drag), or no longer is. */
  onEngage(engaged: boolean): void;
}

export interface TimelineView extends Range {
  /** The retained range has been read, so `oldest` is the real one; until then the bar ignores a press. */
  ready: boolean;
  /** Where the handle is. */
  at: number;
  /** The handle is at the live tip. */
  live: boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement) => {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.append(e);
  return e;
};

/** Build the bar inside `root`, which becomes the slider. */
export function createTimeline(root: HTMLElement, handlers: TimelineHandlers) {
  root.replaceChildren();
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', 'Moment in the city');
  const bands = el('div', 'bands', root);
  const track = el('div', 'strip', root);
  el('div', 'rail', track);
  const marks = el('div', 'marks', track);
  const tip = el('button', 'tip', track);
  tip.type = 'button';
  tip.tabIndex = -1;
  tip.title = 'Back to live';
  tip.setAttribute('aria-label', 'Back to live');
  el('div', 'knob', track);

  const hold = createSpanHold();
  let ready = false;
  let isLive = false;
  let built = '';
  let dragging = false;
  let hover = false;
  let focused = false;
  let engaged = false;
  const shown: Record<string, string> = {};
  const set = (name: string, value: string) => {
    if (shown[name] === value) return;
    shown[name] = value;
    root.style.setProperty(name, value);
  };

  const engage = () => {
    const now = hover || focused || dragging || pending !== null;
    if (now !== engaged) handlers.onEngage((engaged = now));
  };
  const fraction = (e: PointerEvent) => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
  };
  const move = (e: PointerEvent, phase: 'drag' | 'end') =>
    handlers.onMove(tickAtPointer(hold.current, fraction(e)), phase);

  // A press before the span is read waits for it (the read starts as the press engages the bar) instead of being
  // dropped or mapped through a one-tick placeholder.
  let pending: PointerEvent | null = null;
  const begin = (e: PointerEvent) => {
    dragging = true;
    hold.hold();
    root.focus({ preventScroll: true });
    engage();
    move(e, 'drag');
  };
  root.addEventListener('pointerdown', (e) => {
    if (!startsDrag(e.button)) return;
    // Off live, the head is the way back: a drag from it would release a few ticks short of live and seek there.
    if (e.target === tip && !isLive) {
      e.preventDefault();
      handlers.onLive();
      return;
    }
    root.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (!ready) {
      pending = e;
      engage();
      return;
    }
    begin(e);
  });
  root.addEventListener('pointermove', (e) => {
    if (pending) pending = e;
    else if (dragging) move(e, 'drag');
  });
  const release = (e: PointerEvent) => {
    if (pending) {
      pending = null;
      engage();
      return;
    }
    if (!dragging) return;
    dragging = false;
    move(e, 'end');
    hold.release();
    engage();
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('pointerenter', () => ((hover = true), engage()));
  root.addEventListener('pointerleave', () => ((hover = false), engage()));
  root.addEventListener('focusin', () => ((focused = true), engage()));
  root.addEventListener('focusout', () => ((focused = false), engage()));
  root.addEventListener('keydown', (e) => {
    // The keys act on the live span, a drag on the one it began with; they do not mix.
    if (dragging) return;
    const big = e.shiftKey;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') handlers.onStep(-1, big);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') handlers.onStep(1, big);
    else if (e.key === 'PageDown') handlers.onStep(-1, true);
    else if (e.key === 'PageUp') handlers.onStep(1, true);
    else if (e.key === 'Home') handlers.onMove(hold.current.oldest, 'key');
    else if (e.key === 'End') handlers.onLive();
    else return;
    e.preventDefault();
  });

  function rebuild(range: Span) {
    bands.replaceChildren();
    for (const b of dayBands(range)) {
      el('div', 'band', bands).style.cssText = `--from:${b.from};--to:${b.to}`;
      // A label on a sliver of a day would run into the next one.
      const seen = Math.min(b.to, range.newest) - Math.max(b.from, range.oldest);
      if (seen / (range.newest - range.oldest) < 0.08) continue;
      const label = el('span', 'day', bands);
      label.style.setProperty('--from', String(b.from));
      label.textContent = `Day ${b.day}`;
    }
    marks.replaceChildren();
    for (const m of hourMarks(range)) {
      const mark = el('i', m.major ? 'mark major' : 'mark', marks);
      mark.style.setProperty('--t', String(m.tick));
    }
  }

  return {
    /** Draw the bar for `view`. Cheap to call every frame: only what changed is written. */
    update(view: TimelineView) {
      ready = view.ready;
      isLive = view.live;
      if (ready && pending) {
        const e = pending;
        pending = null;
        hold.set(barSpan(view.oldest, view.newest));
        begin(e);
      }
      hold.set(barSpan(view.oldest, view.newest));
      const range = hold.current;
      const key = `${Math.floor(range.oldest / TICKS_PER_HOUR)}:${Math.floor(range.newest / TICKS_PER_HOUR)}`;
      if (key !== built) {
        built = key;
        rebuild(range);
      }
      const span = range.newest - range.oldest;
      const at = Math.min(range.live, clampTick(range, view.at));
      set('--oldest', String(range.oldest));
      set('--span', String(span));
      set('--p', `${(((at - range.oldest) / span) * 100).toFixed(3)}%`);
      set('--live', `${(((range.live - range.oldest) / span) * 100).toFixed(3)}%`);
      set('--at', String(at));
      if (shown.now !== String(at)) {
        shown.now = String(at);
        root.setAttribute('aria-valuemin', String(range.oldest));
        root.setAttribute('aria-valuemax', String(range.newest));
        root.setAttribute('aria-valuenow', String(at));
        root.setAttribute('aria-valuetext', view.live ? `${momentText(at)}, live` : momentText(at));
        root.dataset.at = String(at);
      }
      root.dataset.mode = view.live ? 'live' : 'past';
    },
    /** Show or hide the bar. */
    show(on: boolean) {
      root.classList.toggle('hidden', !on);
    },
    get dragging() {
      return dragging;
    },
    /** The span a drag in progress began with, or null. A release is judged against this, not the span now. */
    get held() {
      return hold.held;
    },
  };
}
