// The building tools' controls: a build and a demolish button beside the settings button, and under them, while a tool
// is held, a panel to pick the building, turn it and read what became of the last thing sent. What the tools do is
// `placement.ts`; this is the markup and the keys.
import { buildAction } from '../build-keys';
import { families } from '../build';
import { PHOTO_CLASS } from './photo';
import type { Placement, Tool } from '../placement';
import { note } from './toast';

const HOUSE = `<path d="M3 17V9l7-5 7 5v8z"/>`;
const BUILD_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HOUSE}<path d="M10 9v5M7.5 11.5h5"/></svg>`;
const DEMOLISH_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HOUSE}<path d="M7.5 9.5l5 5M12.5 9.5l-5 5"/></svg>`;
const TURN_ICON = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 10a6 6 0 11-2-4.5"/><path d="M16 3v3.5h-3.5"/></svg>`;

export const BUILD_LABEL = 'Build';
export const DEMOLISH_LABEL = 'Demolish';
export const HINTS: Record<Tool, string> = {
  build: 'Click or tap a bare lot on the cleared ground to build.',
  demolish: 'Click or tap a building on the cleared ground to take it down.',
};
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
  button.innerHTML = icon;
  return button;
}

/** Put the controls in `tools`, the row under the clock, and the panel after it. */
export function createBuildBar(tools: HTMLElement, placement: Placement, sheetOpen: () => boolean): BuildBar {
  const build = toolButton('build-button', BUILD_LABEL, 'B', BUILD_ICON);
  const demolish = toolButton('demolish-button', DEMOLISH_LABEL, 'X', DEMOLISH_ICON);
  tools.prepend(build, demolish);

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
    <p class="build-status" id="build-status" role="status" aria-live="polite"></p>`;
  tools.closest('.corner')!.append(panel);

  const select = panel.querySelector<HTMLSelectElement>('#build-kind')!;
  const turn = panel.querySelector<HTMLButtonElement>('#build-turn')!;
  const hint = panel.querySelector<HTMLElement>('#build-hint')!;
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

  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let shownStatus = '';
  const showStatus = () => {
    const s = placement.status;
    const text = s.state === 'idle' ? '' : s.text;
    if (text === shownStatus) return;
    shownStatus = text;
    status.textContent = text;
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
    panel.hidden = tool === null;
    buildOnly.hidden = tool !== 'build';
    hint.textContent = tool ? HINTS[tool] : '';
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
    note(text);
  };

  const pick = (tool: Tool) => {
    const why = placement.unavailable();
    if (why) return say(why);
    placement.select(tool);
  };
  build.addEventListener('click', () => pick('build'));
  demolish.addEventListener('click', () => pick('demolish'));
  turn.addEventListener('click', () => placement.rotate());
  select.addEventListener('change', () => {
    placement.setKind(Number(select.value));
    // A focused list keeps the building keys from the page.
    select.blur();
  });

  addEventListener('keydown', (e) => {
    const action = buildAction(e, sheetOpen());
    if (!action || document.body.classList.contains(PHOTO_CLASS)) return;
    if (action === 'cancel') {
      if (placement.tool === null) return;
      placement.select(null);
    } else if (action === 'build' || action === 'demolish') {
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
      // An earlier moment, a lost connection: the tool in hand is no use, and the person should know why it went.
      if (why && placement.tool) {
        placement.drop();
        say(why);
      }
    },
  };
}
