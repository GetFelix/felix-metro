// Photo mode: `H` hides every control so the city can be looked at, or captured, bare. `H` or `Esc` brings them back.
import { isTypingTarget } from './keys';

export interface Photo {
  readonly on: boolean;
  toggle(): void;
}

/** Whether a key press asks for photo mode: a plain `H`, not into a field and not under an open sheet. */
export function isPhotoKey(
  e: { key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  target: Parameters<typeof isTypingTarget>[0],
  sheetOpen: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'h' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || sheetOpen) return false;
  return !isTypingTarget(target);
}

/** The class on `<body>` that the styles hide the overlay by. */
export const PHOTO_CLASS = 'photo';

export function createPhoto(sheetOpen: () => boolean): Photo {
  const set = (on: boolean) => document.body.classList.toggle(PHOTO_CLASS, on);
  const photo: Photo = {
    get on() {
      return document.body.classList.contains(PHOTO_CLASS);
    },
    toggle() {
      set(!photo.on);
    },
  };
  addEventListener('keydown', (e) => {
    if (photo.on && e.key === 'Escape') return set(false);
    if (!isPhotoKey(e, e.target as HTMLElement | null, sheetOpen())) return;
    e.preventDefault();
    photo.toggle();
  });
  return photo;
}
