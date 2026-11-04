// The card that says who built the building under the pointer, with a link that shows it going up. Plain DOM, built once.

/** The line on the card; a long `name` is cut short with an ellipsis and the rest stays whole. */
export interface Line {
  before: string;
  name: string;
  after: string;
}

export interface Card {
  /** Show `line`, and `link` after it when there is one, near the viewport point `at`. */
  show(line: Line, link: { label: string; run: () => void } | null, at: { x: number; y: number }): void;
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
  el.hidden = true;
  const part = (className: string) => {
    const span = document.createElement('span');
    span.className = className;
    return span;
  };
  const line = part('attribution-line');
  const before = part('attribution-before');
  const name = part('attribution-name');
  const after = part('attribution-after');
  line.append(before, name, after);
  const dot = part('attribution-dot');
  dot.setAttribute('aria-hidden', 'true');
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'attribution-link';
  el.append(line, dot, link);
  parent.append(el);
  el.addEventListener('pointerenter', over);
  el.addEventListener('pointerleave', out);
  let run: (() => void) | null = null;
  link.addEventListener('click', () => run?.());
  return {
    get visible() {
      return !el.hidden;
    },
    show(text, action, at) {
      before.textContent = text.before;
      name.textContent = text.name;
      // The whole name is in the tooltip, since the card may show only the start of it.
      name.title = text.name;
      after.textContent = text.after;
      run = action?.run ?? null;
      // Both stay out of the card's text when there is no link, so the text is the line alone.
      dot.textContent = action ? ' · ' : '';
      link.textContent = action?.label ?? '';
      link.hidden = action === null;
      el.hidden = false;
      // Measured from the corner, so where the card was last does not squeeze it.
      el.style.left = '0px';
      el.style.top = '0px';
      const { width, height } = el.getBoundingClientRect();
      // Placed below and to the right of the pointer, or the other side of it where that would leave the screen.
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
