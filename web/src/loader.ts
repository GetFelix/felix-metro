// The loading screen: a grid of district blocks that fill in as each district catches up, and one line of text.
import { displayName } from './registry';

export interface Loader {
  /** Fill the block of a district. */
  ready(district: number): void;
  /** Take the screen away, fading it when `fade`. */
  done(fade: boolean): void;
}

/** A loader for a city of `side` by `side` districts, in the page's `#loader`. */
export function createLoader(root: HTMLElement, side: number, city: string): Loader {
  const grid = root.querySelector<HTMLElement>('.loader-grid')!;
  grid.style.setProperty('--side', String(side));
  const blocks = Array.from({ length: side * side }, () => {
    const block = document.createElement('i');
    grid.append(block);
    return block;
  });
  root.querySelector('p')!.textContent = `Loading ${displayName(city)}…`;
  root.classList.remove('hidden');
  return {
    ready: (district) => blocks[district]?.classList.add('on'),
    done(fade) {
      if (!fade) return root.classList.add('hidden');
      root.classList.add('done');
      setTimeout(() => root.classList.add('hidden'), 700);
    },
  };
}
