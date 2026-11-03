// The building tools' controls: build, demolish and road buttons beside the settings button, and under them, while a
// tool is held, a panel to pick the building, turn it and read what became of the last thing sent. What the tools do is
// `placement.ts`; this is the markup and the keys.
import { signedInAs } from '../auth';
import { buildAction } from '../build-keys';
import { families } from '../build';
import { PHOTO_CLASS } from './photo';
import type { Placement, Tool } from '../placement';
import { note, setMessage, type MessageLink } from './toast';

const HOUSE = `<path d="M3 17V9l7-5 7 5v8z"/>`;
const BUILD_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HOUSE}<path d="M10 9v5M7.5 11.5h5"/></svg>`;
const DEMOLISH_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HOUSE}<path d="M7.5 9.5l5 5M12.5 9.5l-5 5"/></svg>`;
const ROAD_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17L8 3M14 17L12 3M10 4.5v2M10 9v2M10 13.5v2"/></svg>`;
const TURN_ICON = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 10a6 6 0 11-2-4.5"/><path d="M16 3v3.5h-3.5"/></svg>`;

export const BUILD_LABEL = 'Build';
export const DEMOLISH_LABEL = 'Demolish';
export const ROAD_LABEL = 'Road';
export const HINTS: Record<Tool, string> = {
  build: 'Click or tap a bare lot on the cleared ground to build.',
  demolish:
    'Click a building on the cleared ground to take it down. On a touch screen, tap it to pick it and tap again to confirm.',
  road: 'Click a crossing, then another in the same row or column, to lay a road over the cleared ground. Click a road a builder laid to take it away; the city’s own streets stay. On a touch screen, tap again to confirm.',
};
/** The road tool's hint once the first end is picked. */
export const ROAD_SECOND = 'Now pick the other end, in the same row or column. Esc starts again.';
/** How long "Built." stays before the line goes quiet. */
const DONE_MS = 4000;
/** The same reason is not shown again within this long. */
const SAY_AGAIN_MS = 3000;

export interface BuildBar {
  /** Bring the buttons and panel up to date: call it each frame, it changes the page only when something differs. */
  sync(): void;
}

function toolButton(id: string, label: string, key: string, icon: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.id = id;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-controls', 'build-panel');
  button.dataset.key = key;
  button.setAttribute('aria-keyshortcuts', key);
  button.innerHTML = icon;
  return button;
}

/** Put the controls in `tools`, the row under the clock, and the panel after it. */
export function createBuildBar(tools: HTMLElement, placement: Placement, sheetOpen: () => boolean): BuildBar {
  const build = toolButton('build-button', BUILD_LABEL, 'B', BUILD_ICON);
  const demolish = toolButton('demolish-button', DEMOLISH_LABEL, 'X', DEMOLISH_ICON);
  const road = toolButton('road-button', ROAD_LABEL, 'Y', ROAD_ICON);
  tools.prepend(build, demolish, road);

  const panel = document.createElement('div');
  panel.className = 'chip build-panel';
  panel.id = 'build-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="build-row" data-build-only>
      <label class="sr-only" for="build-kind">Building</label>
      <select id="build-kind"></select>
      <button type="button" class="icon-button" id="build-turn" aria-label="Turn the building" title="Turn the building (R)">${TURN_ICON}</button>
    </div>
    <p class="build-hint" id="build-hint"></p>
    <p class="build-why" id="build-why"></p>
    <p class="build-status" id="build-status" role="status" aria-live="polite"></p>`;
  tools.closest('.corner')!.append(panel);

  const select = panel.querySelector<HTMLSelectElement>('#build-kind')!;
  const turn = panel.querySelector<HTMLButtonElement>('#build-turn')!;
  const hint = panel.querySelector<HTMLElement>('#build-hint')!;
  const reasonLine = panel.querySelector<HTMLElement>('#build-why')!;
  const status = panel.querySelector<HTMLElement>('#build-status')!;
  const buildOnly = panel.querySelector<HTMLElement>('[data-build-only]')!;
  for (const family of families()) {
    const group = document.createElement('optgroup');
    group.label = family.title;
    for (const choice of family.choices) {
      const option = document.createElement('option');
      option.value = String(choice.kind);
      option.textContent = choice.label;
      group.append(option);
    }
    select.append(group);
  }

  const messageLink = (): MessageLink | null => {
    const fix = placement.fix();
    return fix && { label: fix.label, href: signedInAs(location.href, fix.user) };
  };

  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let shownStatus = '';
  const showStatus = () => {
    const s = placement.status;
    const text = s.state === 'idle' ? '' : s.text;
    if (text === shownStatus) return;
    shownStatus = text;
    setMessage(status, text, messageLink());
    status.dataset.state = s.state;
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = null;
    if (s.state === 'done') {
      doneTimer = setTimeout(() => {
        shownStatus = '';
        status.textContent = '';
      }, DONE_MS);
    }
  };

  const render = () => {
    const tool = placement.tool;
    build.setAttribute('aria-pressed', String(tool === 'build'));
    demolish.setAttribute('aria-pressed', String(tool === 'demolish'));
    road.setAttribute('aria-pressed', String(tool === 'road'));
    panel.hidden = tool === null;
    buildOnly.hidden = tool !== 'build';
    hint.textContent = tool === 'road' && placement.roadStart !== null ? ROAD_SECOND : tool ? HINTS[tool] : '';
    // The road ghost is red for many reasons, so the panel says which.
    const ghost = placement.roadPreview();
    const reason = ghost && !ghost.check.ok ? ghost.check.why : '';
    if (reasonLine.textContent !== reason) reasonLine.textContent = reason;
    reasonLine.hidden = reason === '';
    select.value = String(placement.kind);
    showStatus();
  };
  placement.onChange(render);

  const label = (button: HTMLButtonElement, name: string, reason: string | null) => {
    const text = reason ?? `${name} (${button.dataset.key})`;
    const off = String(reason !== null);
    if (button.title === text && button.getAttribute('aria-disabled') === off) return;
    button.title = text;
    button.setAttribute('aria-disabled', off);
    button.classList.toggle('off', reason !== null);
  };

  // A key held or pressed twice would stack the same reason on screen.
  let said = { text: '', at: 0 };
  const say = (text: string) => {
    const now = performance.now();
    if (text === said.text && now - said.at < SAY_AGAIN_MS) return;
    said = { text, at: now };
    note(text, messageLink());
  };

  const pick = (tool: Tool) => {
    const why = placement.unavailable();
    if (why) return say(why);
    placement.select(tool);
  };
  build.addEventListener('click', () => pick('build'));
  demolish.addEventListener('click', () => pick('demolish'));
  road.addEventListener('click', () => pick('road'));
  turn.addEventListener('click', () => placement.rotate());
  select.addEventListener('change', () => {
    placement.setKind(Number(select.value));
    // A focused list keeps the building keys from the page.
    select.blur();
  });

  addEventListener('keydown', (e) => {
    const action = buildAction(e, sheetOpen());
    if (!action || document.body.classList.contains(PHOTO_CLASS)) return;
    // The city list took this Esc.
    if (action === 'cancel' && e.defaultPrevented) return;
    if (action === 'cancel') {
      if (placement.tool === null) return;
      placement.cancel();
    } else if (action === 'build' || action === 'demolish' || action === 'road') {
      pick(action);
    } else if (placement.tool === 'build') {
      if (action === 'rotate') placement.rotate();
      else placement.step(action === 'next' ? 1 : -1);
    } else return;
    e.preventDefault();
  });

  let lastWhy: string | null | undefined;
  render();
  return {
    sync() {
      const why = placement.unavailable();
      if (why === lastWhy) return;
      lastWhy = why;
      label(build, BUILD_LABEL, why);
      label(demolish, DEMOLISH_LABEL, why);
      label(road, ROAD_LABEL, why);
      // An earlier moment, a lost connection: the tool in hand is no use, and the person should know why it went.
      if (why && placement.tool) {
        placement.drop();
        say(why);
      }
    },
  };
}
