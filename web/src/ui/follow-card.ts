// The card for the resident being followed: who they are, what they are doing now and their day. Plain DOM, built once.
import type { CardView } from '../follow';

const CLOSE = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>`;

export const STOP_LABEL = 'Stop following';

export interface FollowCard {
  /** Show `view`, or take the card away on null. */
  show(view: CardView | null): void;
}

/**
 * Whether a key press stops a follow: a plain Esc. Photo mode and an open sheet use Esc to close themselves first,
 * so it is left to them.
 */
export function isStopKey(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  photoOn: boolean,
  sheetOpen: boolean,
): boolean {
  return e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !photoOn && !sheetOpen;
}

/** Put the card in the page, above the city chip's menu so that menu is never covered. `onStop` runs on its button. */
export function createFollowCard(onStop: () => void): FollowCard {
  const root = document.createElement('aside');
  root.className = 'chip follow';
  root.id = 'follow';
  root.hidden = true;
  root.setAttribute('aria-label', 'The resident being followed');
  root.innerHTML = `
    <header>
      <div><b data-name></b><small data-kind></small></div>
      <button type="button" class="icon-button" data-stop title="${STOP_LABEL}" aria-label="${STOP_LABEL}">${CLOSE}</button>
    </header>
    <p class="doing" data-doing role="status"></p>
    <h3>Their day</h3>
    <ol data-day></ol>`;
  const at = (name: string) => root.querySelector<HTMLElement>(`[data-${name}]`)!;
  (document.getElementById('brand') ?? document.body.firstChild)!.before(root);
  at('stop').addEventListener('click', onStop);
  return {
    show(view) {
      root.hidden = view === null;
      if (!view) return;
      root.dataset.resident = String(view.resident);
      at('name').textContent = view.name;
      at('kind').textContent = view.kind;
      at('doing').textContent = view.doing;
      at('day').replaceChildren(
        ...view.rows.map((row, i) => {
          const li = document.createElement('li');
          if (i === view.current) li.setAttribute('aria-current', 'true');
          const what = document.createElement('span');
          what.textContent = row.place ? `${row.label}, ${row.place}` : row.label;
          const until = document.createElement('time');
          until.textContent = `until ${row.until}`;
          li.append(what, until);
          return li;
        }),
      );
    },
  };
}
