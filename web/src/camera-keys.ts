// What moves the camera, as data: the page reads the keyboard from the first table, and the key list in the UI shows both.

/** What a key does. The first group is held down to keep moving; `reset` happens once per press. */
export type CameraAction =
  | 'panForward'
  | 'panBack'
  | 'panLeft'
  | 'panRight'
  | 'rotateLeft'
  | 'rotateRight'
  | 'zoomIn'
  | 'zoomOut'
  | 'reset';

export interface CameraKey {
  action: CameraAction;
  /** `KeyboardEvent.key` values that trigger it, lower case. */
  keys: readonly string[];
  /** What the key cap reads. */
  keycap: string;
  /** What it does, in the words the key list shows. */
  label: string;
}

export const CAMERA_KEYS: readonly CameraKey[] = [
  { action: 'panForward', keys: ['w'], keycap: 'W', label: 'Move the view forward' },
  { action: 'panLeft', keys: ['a'], keycap: 'A', label: 'Move the view left' },
  { action: 'panBack', keys: ['s'], keycap: 'S', label: 'Move the view back' },
  { action: 'panRight', keys: ['d'], keycap: 'D', label: 'Move the view right' },
  { action: 'rotateLeft', keys: ['q'], keycap: 'Q', label: 'Turn the view left' },
  { action: 'rotateRight', keys: ['e'], keycap: 'E', label: 'Turn the view right' },
  { action: 'zoomIn', keys: ['+', '='], keycap: '+', label: 'Zoom in' },
  { action: 'zoomOut', keys: ['-', '_'], keycap: '-', label: 'Zoom out' },
  { action: 'reset', keys: ['0'], keycap: '0', label: 'Back to the starting view' },
];

/** The pointer and touch controls, for the same list. */
export const CAMERA_GESTURES: readonly { input: string; label: string }[] = [
  { input: 'Drag', label: 'Turn and tilt the view' },
  { input: 'Right-drag or Shift-drag', label: 'Move the view' },
  { input: 'Scroll or pinch', label: 'Zoom toward the pointer' },
  { input: 'One finger', label: 'Turn and tilt the view' },
  { input: 'Two fingers', label: 'Move the view, and pinch to zoom' },
];

const BY_KEY = new Map(CAMERA_KEYS.flatMap((row) => row.keys.map((key) => [key, row.action] as const)));

/** What a key press does to the camera, or null when it is not one of the camera's keys or something else owns it. */
export function actionFor(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target?: unknown;
}): CameraAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return null;
  return keyAction(e.key);
}

/** The action a key is bound to, with no other checks: a key let go must stop its motion even if Ctrl is down by then. */
export function keyAction(key: string): CameraAction | null {
  return BY_KEY.get(key.toLowerCase()) ?? null;
}

/** Whether keys typed at `target` belong to a text field and not to the page. */
export function isTyping(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
