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

/** Words in a message that open `href` in a new tab. */
export interface MessageLink {
  label: string;
  href: string;
}

/** Put `text` in `el`, with `link.label`, where the text has it, as a link to a new tab. */
export function setMessage(el: HTMLElement, text: string, link?: MessageLink | null): void {
  const at = link ? text.indexOf(link.label) : -1;
  if (!link || at < 0) {
    el.textContent = text;
    return;
  }
  const a = document.createElement('a');
  a.href = link.href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = link.label;
  el.replaceChildren(text.slice(0, at), a, text.slice(at + link.label.length));
}

/** Show `text` for `ms`, or until removed when `ms` is null; `hint` is a tip, not news of something that went wrong. */
export function toast(text: string, ms: number | null, hint = false, link?: MessageLink | null): Toast {
  const el = document.createElement('p');
  el.className = hint ? 'toast hint' : 'toast';
  setMessage(el, text, link);
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
export function note(text: string, link?: MessageLink | null): void {
  toast(text, NOTE_MS, false, link);
}
