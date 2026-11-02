// Short messages above the timeline, in the page's `#toasts` region so a screen reader reads each as it arrives.

export interface Toast {
  /** Take the message away now. */
  remove(): void;
}

const REGION = 'toasts';

function region(): HTMLElement {
  let el = document.getElementById(REGION);
  if (!el) {
    el = document.createElement('div');
    el.id = REGION;
    el.className = 'toasts';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  return el;
}

/** Show `text` for `ms`, or until removed when `ms` is null; `hint` is a tip, not news of something that went wrong. */
export function toast(text: string, ms: number | null, hint = false): Toast {
  const el = document.createElement('p');
  el.className = hint ? 'toast hint' : 'toast';
  el.textContent = text;
  region().append(el);
  const timer = ms === null ? undefined : setTimeout(() => el.remove(), ms);
  return {
    remove() {
      clearTimeout(timer);
      el.remove();
    },
  };
}

/** How long a note stays. */
export const NOTE_MS = 6000;

/** A short word on screen for something that did not work out, gone after a few seconds. */
export function note(text: string): void {
  toast(text, NOTE_MS);
}
