// The stats panel: residents, who is on the road, and the buildings by kind, for the moment on screen. It is drawn
// from numbers handed in (see ../stats.ts) and says nothing about where they come from. Off until asked for, then
// remembered in local storage.
import { isTypingTarget } from './keys';
import { GROUPS, type CityStats } from '../stats';

const KEY = 'felix-metro.stats';

export interface StatsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether the panel was left on, kept in local storage. Storage can be blocked, which reads as off. */
export function createStatsMemory(open: () => StatsStorage = () => localStorage) {
  return {
    on(): boolean {
      try {
        return open().getItem(KEY) === '1';
      } catch {
        return false;
      }
    },
    set(on: boolean): void {
      try {
        open().setItem(KEY, on ? '1' : '0');
      } catch {
        // The choice then lasts for this visit only.
      }
    },
  };
}

/** Whether a key press asks for the stats: a plain `C`, not into a field and not under an open sheet. */
export function isStatsKey(
  e: { key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  target: Parameters<typeof isTypingTarget>[0],
  sheetOpen: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'c' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || sheetOpen) return false;
  return !isTypingTarget(target);
}

/** A count as the panel shows it: digit groups, or a dash when it is not known yet. */
export function figure(n: number | null): string {
  return n === null ? '-' : n.toLocaleString('en-US');
}

export interface StatsPanel {
  readonly on: boolean;
  set(on: boolean): void;
  toggle(): void;
  /** Told when the panel is turned on or off. */
  onChange(cb: (on: boolean) => void): void;
  /** Draw the numbers. Does nothing while the panel is off. */
  show(stats: CityStats): void;
}

/** `sheetOpen` says whether a sheet is over the page, which keeps the key from toggling underneath it. */
export function createStatsPanel(sheetOpen: () => boolean, memory = createStatsMemory()): StatsPanel {
  const root = document.createElement('aside');
  root.className = 'stats';
  root.id = 'stats';
  root.setAttribute('aria-label', 'City stats');
  root.innerHTML = `
    <dl>
      <div class="lead"><dt>Residents</dt><dd data-stat="population"></dd></div>
      <div class="lead"><dt>On the road</dt><dd data-stat="road"></dd></div>
      <div class="sub"><dt>In cars</dt><dd data-stat="cars"></dd></div>
      <div class="sub"><dt>On foot</dt><dd data-stat="walkers"></dd></div>
    </dl>
    <h2>Buildings</h2>
    <dl>
      ${GROUPS.map((g) => `<div><dt>${g.label}</dt><dd data-stat="${g.id}"></dd></div>`).join('')}
    </dl>`;
  document.body.append(root);

  const cells = new Map([...root.querySelectorAll<HTMLElement>('[data-stat]')].map((el) => [el.dataset.stat!, el]));
  const listeners: ((on: boolean) => void)[] = [];
  let on = memory.on();
  root.hidden = !on;

  const put = (name: string, value: number | null) => {
    const el = cells.get(name)!;
    const text = figure(value);
    // Runs several times a second; most of the numbers stay put.
    if (el.textContent !== text) el.textContent = text;
  };

  const panel: StatsPanel = {
    get on() {
      return on;
    },
    set(next) {
      if (next === on) return;
      on = next;
      root.hidden = !on;
      memory.set(on);
      for (const cb of listeners) cb(on);
    },
    toggle: () => panel.set(!on),
    onChange: (cb) => void listeners.push(cb),
    show(stats) {
      if (!on) return;
      const road = stats.cars === null || stats.walkers === null ? null : stats.cars + stats.walkers;
      put('population', stats.population);
      put('road', road);
      put('cars', stats.cars);
      put('walkers', stats.walkers);
      for (const g of GROUPS) put(g.id, stats.buildings[g.id]);
    },
  };

  addEventListener('keydown', (e) => {
    if (!isStatsKey(e, e.target as HTMLElement | null, sheetOpen())) return;
    e.preventDefault();
    panel.toggle();
  });
  return panel;
}
