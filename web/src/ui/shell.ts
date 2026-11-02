// The overlay's controls that are not tied to the city: the settings button and its sheet, the key list and the tip
// for a first visit. Plain DOM, built once.
import type { Quality } from '../quality';
import { createHint, createMemory, listenForInteraction } from './hint';
import { isHelpKey, isTypingTarget, renderKeys } from './keys';
import { CHOICES, choose, runningText, selectedChoice, type Choice } from './settings';
import { createSheet } from './sheet';
import { toast } from './toast';

export interface Shell {
  readonly isOpen: boolean;
  openSettings(): void;
  openKeys(): void;
  close(): void;
  /** Bring the sheet's quality options up to date with the controller, after it chose a tier on its own. */
  refresh(): void;
  /** Show the first-visit tip if it is due; false when it was shown before or is showing. */
  offerHint(): boolean;
}

const GEAR = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" aria-hidden="true"><path d="M3 6h5M12 6h5M3 14h2M9 14h8"/><circle cx="10" cy="6" r="2"/><circle cx="7" cy="14" r="2"/></svg>`;

const CLOSE = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>`;

const SHEET = `
  <section data-view="settings">
    <header>
      <h2 id="settings-title">Settings</h2>
      <button type="button" class="icon-button" data-close aria-label="Close settings">${CLOSE}</button>
    </header>
    <fieldset class="choices">
      <legend>Quality</legend>
      ${CHOICES.map(
        (c) => `<label class="choice"><input type="radio" name="quality" value="${c.value}" />
          <span><b>${c.label}</b><small>${c.hint}</small></span></label>`,
      ).join('')}
    </fieldset>
    <p class="running" data-running></p>
    <button type="button" class="text-button" data-open-keys>Keyboard shortcuts<kbd>?</kbd></button>
  </section>
  <section data-view="keys" hidden>
    <header>
      <button type="button" class="icon-button" data-back aria-label="Back to settings">
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l-6 6 6 6"/></svg>
      </button>
      <h2 id="keys-title">Keyboard shortcuts</h2>
      <button type="button" class="icon-button" data-close aria-label="Close shortcuts">${CLOSE}</button>
    </header>
    <div class="keys" data-keys></div>
  </section>`;

/** Build the controls into the page. Nothing here changes the city; the quality options go through `quality`. */
export function createShell(quality: Quality): Shell {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.id = 'settings-button';
  button.title = 'Settings';
  button.setAttribute('aria-label', 'Settings');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'sheet');
  button.innerHTML = GEAR;
  document.querySelector('.corner')!.append(button);

  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.hidden = true;
  const root = document.createElement('div');
  root.className = 'sheet';
  root.id = 'sheet';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = SHEET;
  document.body.append(scrim, root);

  const view = (name: string) => root.querySelector<HTMLElement>(`[data-view="${name}"]`)!;
  const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="quality"]')];
  const running = root.querySelector<HTMLElement>('[data-running]')!;
  renderKeys(root.querySelector<HTMLElement>('[data-keys]')!);

  const refresh = () => {
    const picked = selectedChoice(quality);
    for (const r of radios) r.checked = r.value === picked;
    running.textContent = runningText(quality);
    running.hidden = running.textContent === '';
  };
  for (const r of radios) {
    r.addEventListener('change', () => {
      if (r.checked) choose(quality, r.value as Choice);
      refresh();
    });
  }

  const sheet = createSheet(root, scrim, () => button.setAttribute('aria-expanded', 'false'));
  const show = (name: 'settings' | 'keys') => {
    view('settings').hidden = name !== 'settings';
    view('keys').hidden = name !== 'keys';
    root.setAttribute('aria-labelledby', `${name}-title`);
    return () =>
      name === 'settings'
        ? (radios.find((r) => r.checked) ?? radios[0]!)
        : root.querySelector<HTMLElement>('[data-back]');
  };
  // Funds and the council sit above the gear, so the sheet opens just under wherever the gear is.
  const place = () => {
    const top = Math.round(button.getBoundingClientRect().bottom) + 8;
    root.style.top = `${top}px`;
    root.style.maxHeight = `calc(100dvh - ${top + 16}px)`;
  };
  const openSettings = () => {
    refresh();
    place();
    button.setAttribute('aria-expanded', 'true');
    sheet.open(show('settings'));
  };
  const openKeys = () => {
    place();
    button.setAttribute('aria-expanded', 'true');
    sheet.open(show('keys'));
  };

  button.addEventListener('click', () => (sheet.isOpen ? sheet.close() : openSettings()));
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', sheet.close));
  root.querySelector('[data-open-keys]')!.addEventListener('click', openKeys);
  root.querySelector('[data-back]')!.addEventListener('click', openSettings);
  addEventListener('keydown', (e) => {
    if (e.repeat || !isHelpKey(e) || isTypingTarget(e.target as HTMLElement | null)) return;
    e.preventDefault();
    openKeys();
  });

  const hint = createHint({
    memory: createMemory(),
    show: (text, ms) => toast(text, ms, true),
    onInteraction: listenForInteraction,
  });

  return {
    get isOpen() {
      return sheet.isOpen;
    },
    openSettings,
    openKeys,
    close: sheet.close,
    refresh,
    offerHint: hint.offer,
  };
}
