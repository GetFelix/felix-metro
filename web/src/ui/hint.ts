// The tip shown once on a first visit. What it says, how long it stays, and the memory that it was shown; the toast
// itself and the page's events are handed in so this runs without a page.
import type { Toast } from './toast';

export const HINT_TEXT = 'Drag the timeline to go back in time';
export const HINT_MS = 8000;

const KEY = 'felix-metro.hint';

export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether the tip was shown on an earlier visit, kept in local storage. Storage can be blocked, which reads as not shown. */
export function createMemory(open: () => HintStorage = () => localStorage) {
  return {
    seen(): boolean {
      try {
        return open().getItem(KEY) === '1';
      } catch {
        return false;
      }
    },
    remember(): void {
      try {
        open().setItem(KEY, '1');
      } catch {
        // The tip is then shown again next visit, which beats failing here.
      }
    },
  };
}

export interface HintDeps {
  memory: { seen(): boolean; remember(): void };
  show(text: string, ms: number): Toast;
  /** Call `cb` once the person first touches the page; returns a way to stop listening. */
  onInteraction(cb: () => void): () => void;
}

/** The pointer, the keyboard and the wheel are all ways of using the page. */
export function listenForInteraction(cb: () => void): () => void {
  const events = ['pointerdown', 'keydown', 'wheel'] as const;
  const off = () => events.forEach((e) => removeEventListener(e, cb, true));
  events.forEach((e) => addEventListener(e, cb, { capture: true, passive: true }));
  return off;
}

/** The tip, shown at most once on this page and once ever on this browser. `offer` shows it if it is due. */
export function createHint(deps: HintDeps) {
  let offered = false;
  return {
    offer(): boolean {
      if (offered || deps.memory.seen()) return false;
      offered = true;
      deps.memory.remember();
      const shown = deps.show(HINT_TEXT, HINT_MS);
      let stop: (() => void) | null = null;
      stop = deps.onInteraction(() => {
        stop?.();
        shown.remove();
      });
      return true;
    },
  };
}
