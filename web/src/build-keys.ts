// The keys the building tools answer to, as data, in the same shape as the camera's: the page reads the keyboard from
// this table and the key list in the UI (`web/src/ui/keys.ts`) is built from it, so the two cannot drift.
import { isTyping } from './camera-keys';

export type BuildAction = 'build' | 'demolish' | 'rotate' | 'previous' | 'next' | 'cancel';

export interface BuildKey {
  action: BuildAction;
  /** `KeyboardEvent.key` values that trigger it, lower case. */
  keys: readonly string[];
  /** What the key caps read, one for each of `keys`. */
  keycaps: readonly string[];
  /** What it does, in the words the key list shows. */
  label: string;
}

// `[` and `]` need AltGr on some layouts, so the comma and the full stop do the same.
export const BUILD_KEYS: readonly BuildKey[] = [
  { action: 'build', keys: ['b'], keycaps: ['B'], label: 'Pick the build tool, or put it away' },
  { action: 'demolish', keys: ['x'], keycaps: ['X'], label: 'Pick the demolish tool, or put it away' },
  { action: 'rotate', keys: ['r'], keycaps: ['R'], label: 'Turn the building a quarter turn' },
  { action: 'previous', keys: ['[', ','], keycaps: ['[', ','], label: 'Choose the previous building' },
  { action: 'next', keys: [']', '.'], keycaps: [']', '.'], label: 'Choose the next building' },
  { action: 'cancel', keys: ['escape'], keycaps: ['Esc'], label: 'Put the tool away' },
];

const BY_KEY = new Map(BUILD_KEYS.flatMap((row) => row.keys.map((key) => [key, row.action] as const)));

/**
 * What a key press asks of the building tools, or null when it is not theirs: held with a modifier, a repeat, typed
 * into a field, or pressed under an open sheet.
 */
export function buildAction(
  e: { key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target?: unknown },
  sheetOpen: boolean,
): BuildAction | null {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || sheetOpen || isTyping(e.target)) return null;
  if (typeof e.key !== 'string') return null;
  return BY_KEY.get(e.key.toLowerCase()) ?? null;
}
