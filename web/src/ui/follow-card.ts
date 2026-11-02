// The card for the resident being followed: who they are, what they are doing now and their day. Plain DOM, built once.
import type { CardView } from '../follow';
import { isTypingTarget } from './keys';

const CLOSE = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>`;

export const STOP_LABEL = 'Stop following';

export interface FollowCard {
  /** Show `view`, or take the card away on null. */
  show(view: CardView | null): void;
}

/**
 * Whether a key press stops a follow: a plain Esc. Photo mode, an open sheet and the city menu use Esc to close
 * themselves first, so it is left to them.
 */
export function isStopKey(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  photoOn: boolean,
  sheetOpen: boolean,
  menuOpen: boolean,
): boolean {
  return e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !photoOn && !sheetOpen && !menuOpen;
}

/** Whether a key press asks to follow whoever is nearest the middle of the view: a plain F, not into a field. */
export function isFollowKey(
  e: { key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  target: Parameters<typeof isTypingTarget>[0],
  sheetOpen: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'f' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || sheetOpen) return false;
  return !isTypingTarget(target);
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
    <p class="doing" data-doing></p>
    <h3>Their day</h3>
    <ol data-day></ol>`;
  // A region that is always in the page, filled when the card shows: one inside a card that starts hidden is not read out.
  const announce = document.createElement('div');
  announce.className = 'sr-only';
  announce.setAttribute('role', 'status');
  document.body.append(announce);
  const at = (name: string) => root.querySelector<HTMLElement>(`[data-${name}]`)!;
  (document.getElementById('brand') ?? document.body.firstChild)!.before(root);
  at('stop').addEventListener('click', onStop);
  return {
    show(view) {
      // Taking away a card that holds focus would drop it to the page; the city button is the nearest place to put it.
      if (!view && root.contains(document.activeElement)) {
        document.querySelector<HTMLElement>('#brand-button:not(:disabled), #settings-button')?.focus();
      }
      root.hidden = view === null;
      announce.textContent = view ? `Following ${view.name}. ${view.doing}.` : '';
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
