// The key list: every key the page answers to, as data. A feature that adds a key adds a row here.

import { BUILD_KEYS } from '../build-keys';
import { CAMERA_GESTURES, CAMERA_KEYS } from '../camera-keys';

/** One way of doing something: keys pressed together, such as `['Shift', '←']`. */
export type Chord = readonly string[];

export interface Shortcut {
  /** The ways to do it; any one will do. */
  keys: readonly Chord[];
  /** What it does, in plain words. */
  action: string;
}

export interface ShortcutGroup {
  title: string;
  /** When these keys apply, if not always. */
  when?: string;
  rows: readonly Shortcut[];
}

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Timeline',
    when: 'Click the timeline, or press Tab until it is selected.',
    rows: [
      { keys: [['←'], ['↓']], action: 'Go back 15 minutes' },
      { keys: [['→'], ['↑']], action: 'Go forward 15 minutes' },
      { keys: [['Shift', '←'], ['Page Down']], action: 'Go back an hour' },
      { keys: [['Shift', '→'], ['Page Up']], action: 'Go forward an hour' },
      { keys: [['Home']], action: 'Jump to the earliest moment' },
      { keys: [['End']], action: 'Back to live' },
    ],
  },
  {
    title: 'View',
    // Built from the camera's own tables, so the list cannot drift from the keys the camera reads.
    rows: CAMERA_KEYS.map((key) => ({ keys: [[key.keycap]], action: key.label })),
  },
  {
    title: 'Mouse and touch',
    rows: CAMERA_GESTURES.map((gesture) => ({ keys: [[gesture.input]], action: gesture.label })),
  },
  {
    title: 'Playback',
    when: 'Looking at an earlier moment, or J from the live city. Space does nothing while a button is focused.',
    rows: [
      { keys: [['Space']], action: 'Play or pause an earlier moment' },
      { keys: [['L']], action: 'Play forward; each press doubles the speed (up to 8x), or slows a rewind' },
      {
        keys: [['J']],
        action:
          'Rewind; each press doubles the speed (up to 8x), or slows a forward play; from the live city, step back first',
      },
      { keys: [['K']], action: 'Stop' },
    ],
  },
  {
    title: 'Building',
    when: 'In the live city, on a sign-in that may build. Click or tap a lot to use the tool.',
    // Built from the tools' own table, like the camera's.
    rows: BUILD_KEYS.map((key) => ({ keys: [[key.keycap]], action: key.label })),
  },
  {
    title: 'Anywhere',
    rows: [
      { keys: [['H']], action: 'Hide every control for a clean view; press H or Esc to bring them back' },
      { keys: [['M']], action: 'Turn the sound on or off' },
      { keys: [['?']], action: 'Show this list' },
      { keys: [['Esc']], action: 'Close a menu or panel' },
      { keys: [['Tab'], ['Shift', 'Tab']], action: 'Move to the next or previous control' },
    ],
  },
];

/** What `?` is: shift and the slash key on most keyboards, so shift is allowed and the other modifiers are not. */
export function isHelpKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey;
}

const TEXT_INPUTS = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

/** Whether a key pressed at `target` is going into text, so a shortcut must leave it alone. */
export function isTypingTarget(
  target: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
}

/**
 * Whether a key press plays or pauses an earlier moment. Space keeps its own job on a button, a field or a list,
 * but not on the timeline, which has no use for it, and not under an open sheet.
 */
export function isPlayKey(
  e: { key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  target: { closest(selector: string): unknown } | null | undefined,
  sheetOpen: boolean,
): boolean {
  if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || sheetOpen) return false;
  return !target?.closest('button, input, select, textarea, a[href]');
}

/** Draw `groups` into `into`: a heading and a table of keys and actions for each. */
export function renderKeys(into: HTMLElement, groups: readonly ShortcutGroup[] = SHORTCUTS): void {
  into.replaceChildren(
    ...groups.map((group) => {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = group.title;
      section.append(heading);
      if (group.when) {
        const when = document.createElement('p');
        when.className = 'when';
        when.textContent = group.when;
        section.append(when);
      }
      const table = document.createElement('table');
      table.setAttribute('aria-label', group.title);
      for (const row of group.rows) {
        const tr = table.insertRow();
        const keys = tr.insertCell();
        keys.className = 'combo';
        row.keys.forEach((chord, i) => {
          if (i > 0) keys.append(' or ');
          chord.forEach((key, j) => {
            if (j > 0) keys.append('+');
            const cap = document.createElement('kbd');
            cap.textContent = key;
            keys.append(cap);
          });
        });
        tr.insertCell().textContent = row.action;
      }
      section.append(table);
      return section;
    }),
  );
}
