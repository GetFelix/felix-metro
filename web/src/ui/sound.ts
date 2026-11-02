// The sound button and its M key. The choice is kept in local storage; the audio itself is `ambient.ts`.
import type { Ambient } from '../ambient';
import { isTypingTarget } from './keys';

export const UNAVAILABLE_TEXT = 'Sound is not available in this browser';

const KEY = 'felix-metro.sound';

export interface SoundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether sound was left on last visit. Storage can be blocked, which reads as off. */
export function createSoundMemory(open: () => SoundStorage = () => localStorage) {
  return {
    on(): boolean {
      try {
        return open().getItem(KEY) === '1';
      } catch {
        return false;
      }
    },
    remember(on: boolean): void {
      try {
        open().setItem(KEY, on ? '1' : '0');
      } catch {
        // The choice is then forgotten next visit, which beats failing here.
      }
    },
  };
}

export interface SoundDeps {
  ambient: Ambient;
  memory: { on(): boolean; remember(on: boolean): void };
  /** Say something short on screen. */
  tell(text: string): void;
  /** Call `cb` on the next click or key press that is not the button's own; returns a way to stop listening. */
  onGesture(cb: () => void): () => void;
  /** The button's state changed: `on` is whether sound is wanted. */
  onChange(on: boolean): void;
}

/**
 * The on and off of the sound. A browser lets audio start only from a click or key press, so sound left on last visit
 * shows as on and starts at the first one; the button itself, or M, switches it off instead.
 */
export function createSoundSwitch(deps: SoundDeps) {
  const { ambient, memory } = deps;
  let wanted = memory.on();
  let stopWaiting: (() => void) | null = null;

  const arm = () => {
    stopWaiting = deps.onGesture(() => {
      stopWaiting = null;
      if (!wanted) return;
      if (!ambient.enable()) {
        wanted = false;
        deps.onChange(false);
      }
    });
  };
  if (wanted) arm();
  deps.onChange(wanted);

  return {
    get on() {
      return wanted;
    },
    toggle(): void {
      stopWaiting?.();
      stopWaiting = null;
      if (wanted) {
        wanted = false;
        ambient.disable();
      } else if (ambient.enable()) {
        wanted = true;
      } else {
        deps.tell(UNAVAILABLE_TEXT);
      }
      memory.remember(wanted);
      deps.onChange(wanted);
    },
  };
}

/** Whether a key press is the sound key: M alone, and not while typing. */
export function isSoundKey(e: {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target?: unknown;
}): boolean {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (isTypingTarget(e.target as Parameters<typeof isTypingTarget>[0])) return false;
  return e.key.toLowerCase() === 'm';
}

const SPEAKER = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8v4h3l4 3V5L6 8z"/>
  <path class="waves" d="M13 7.5a3.5 3.5 0 0 1 0 5M15.5 5a7 7 0 0 1 0 10"/><path class="mute" d="M13 8l4 4M17 8l-4 4"/></svg>`;

export interface Sound {
  /** Switch the sound on or off, as the button does. */
  toggle(): void;
  /** Play the rewind sweep if the sound is on. */
  whoosh(): void;
}

/**
 * Add the sound button to `into`, for the M key to work from anywhere. `blocked` says when keys belong to something
 * else, such as an open sheet.
 */
export function createSound(
  ambient: Ambient,
  into: HTMLElement,
  tell: (text: string) => void,
  blocked: () => boolean,
): Sound {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.id = 'sound-button';
  button.title = 'Sound (M)';
  button.setAttribute('aria-label', 'Sound');
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-keyshortcuts', 'M');
  button.innerHTML = SPEAKER;
  into.append(button);

  const sound = createSoundSwitch({
    ambient,
    memory: createSoundMemory(),
    tell,
    onChange: (on) => button.setAttribute('aria-pressed', String(on)),
    onGesture: (cb) => {
      const run = (e: Event) => {
        if (button.contains(e.target as Node) || (e instanceof KeyboardEvent && isSoundKey(e))) return;
        off();
        cb();
      };
      // Pointer up and key down are the gestures a browser accepts for starting audio.
      const off = () => {
        removeEventListener('pointerup', run, true);
        removeEventListener('keydown', run, true);
      };
      addEventListener('pointerup', run, true);
      addEventListener('keydown', run, true);
      return off;
    },
  });
  button.addEventListener('click', sound.toggle);
  addEventListener('keydown', (e) => {
    if (blocked() || !isSoundKey(e)) return;
    e.preventDefault();
    sound.toggle();
  });
  return { toggle: sound.toggle, whoosh: ambient.whoosh };
}
