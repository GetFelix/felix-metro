// The card that says who built the building under the pointer, with a link that shows it going up. Plain DOM, built once.

export interface Card {
  /** Show `text`, and `link` after it when there is one, near the viewport point `at`. */
  show(text: string, link: { label: string; run: () => void } | null, at: { x: number; y: number }): void;
  hide(): void;
  readonly visible: boolean;
}

/** Gap between the pointer and the card, so the card does not sit under it. */
const OFFSET = 14;
const MARGIN = 8;

/**
 * Build the card into `parent`. `over` and `out` are told when the pointer enters or leaves the card, so a hover that
 * moved from the building onto the card does not end.
 */
export function createCard(parent: HTMLElement, over: () => void, out: () => void): Card {
  const el = document.createElement('div');
  el.className = 'attribution';
  el.id = 'attribution';
  el.setAttribute('role', 'status');
  el.hidden = true;
  const text = document.createElement('span');
  const dot = document.createElement('span');
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = ' · ';
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'attribution-link';
  el.append(text, dot, link);
  parent.append(el);
  el.addEventListener('pointerenter', over);
  el.addEventListener('pointerleave', out);
  let run: (() => void) | null = null;
  link.addEventListener('click', () => run?.());
  return {
    get visible() {
      return !el.hidden;
    },
    show(line, action, at) {
      text.textContent = line;
      run = action?.run ?? null;
      link.textContent = action?.label ?? '';
      link.hidden = dot.hidden = action === null;
      el.hidden = false;
      // Placed below and to the right of the pointer, or the other side of it where that would leave the screen.
      const { width, height } = el.getBoundingClientRect();
      const left = at.x + OFFSET + width > innerWidth - MARGIN ? at.x - OFFSET - width : at.x + OFFSET;
      const top = at.y + OFFSET + height > innerHeight - MARGIN ? at.y - OFFSET - height : at.y + OFFSET;
      el.style.left = `${Math.max(MARGIN, left)}px`;
      el.style.top = `${Math.max(MARGIN, top)}px`;
    },
    hide() {
      el.hidden = true;
      run = null;
    },
  };
}
