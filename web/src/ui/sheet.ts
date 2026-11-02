// A panel over the page: focus stays inside it, Esc or a click outside closes it, and focus goes back to where it was.

/** Where Tab should go from `active` among `order`, the controls of the panel: null when the browser's own step stays inside. */
export function trapTarget<T>(order: readonly T[], active: T | null, backwards: boolean): T | null {
  if (order.length === 0) return null;
  const at = active === null ? -1 : order.indexOf(active);
  if (at === -1) return backwards ? order[order.length - 1]! : order[0]!;
  if (backwards && at === 0) return order[order.length - 1]!;
  if (!backwards && at === order.length - 1) return order[0]!;
  return null;
}

const CONTROLS = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** The controls inside `root` that can take focus now. */
export function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
  );
}

export interface Sheet {
  readonly isOpen: boolean;
  /** Show the panel, remembering what had focus. `focus` picks the control to start on. */
  open(focus: () => HTMLElement | null): void;
  close(): void;
}

/** Wire `root` and its `scrim`, the layer behind it that catches clicks outside. `onClose` runs after it is hidden. */
export function createSheet(root: HTMLElement, scrim: HTMLElement, onClose: () => void = () => {}): Sheet {
  let opener: HTMLElement | null = null;
  let isOpen = false;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const to = trapTarget(focusable(root), document.activeElement as HTMLElement | null, e.shiftKey);
      if (to) {
        e.preventDefault();
        to.focus();
      }
    }
  };

  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.hidden = true;
    scrim.hidden = true;
    document.removeEventListener('keydown', onKey);
    const back = opener;
    opener = null;
    if (back?.isConnected) back.focus();
    onClose();
  }

  scrim.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    close();
  });

  return {
    get isOpen() {
      return isOpen;
    },
    open(focus) {
      if (!isOpen) {
        isOpen = true;
        opener = document.activeElement as HTMLElement | null;
        root.hidden = false;
        scrim.hidden = false;
        document.addEventListener('keydown', onKey);
      }
      focus()?.focus();
    },
    close,
  };
}
