// The city picker in the brand chip: the chip opens a list of the registry's cities, each a link to its page.
import { citySize, displayName, type CityEntry } from './registry';

export interface Picker {
  update(cities: CityEntry[]): void;
}

/** The page address for a city, keeping the other parameters. A size the page cannot learn goes in `?districts`. */
function hrefFor(name: string, size: number, defaultSize: number): string {
  const url = new URL(location.href);
  if (size > 0 && size !== defaultSize) url.searchParams.set('districts', String(size));
  else url.searchParams.delete('districts');
  url.hash = encodeURIComponent(name);
  return url.pathname + url.search + url.hash;
}

/** Wire the picker to the page's `#brand-button`, `#chevron` and `#cities`; `current` is the city on screen. */
export function createPicker(current: string, defaultSize: number): Picker {
  const button = document.getElementById('brand-button') as HTMLButtonElement;
  const chevron = document.getElementById('chevron')!;
  const list = document.getElementById('cities')!;

  const open = (show: boolean) => {
    list.classList.toggle('hidden', !show);
    button.setAttribute('aria-expanded', String(show));
  };
  button.addEventListener('click', () => open(list.classList.contains('hidden')));
  document.addEventListener('pointerdown', (e) => {
    if (!document.getElementById('brand')!.contains(e.target as Node)) open(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.classList.contains('hidden')) {
      open(false);
      button.focus();
    }
  });

  return {
    update(cities) {
      const byName = new Map(cities.map((c) => [c.name, c]));
      list.replaceChildren(
        ...cities.map((city) => {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = hrefFor(city.name, citySize(city, byName), defaultSize);
          link.textContent = displayName(city.name);
          if (city.name === current) link.setAttribute('aria-current', 'page');
          if (city.parent) {
            const note = document.createElement('small');
            note.textContent = `from ${displayName(city.parent)}`;
            link.append(note);
          }
          item.append(link);
          return item;
        }),
      );
      button.disabled = cities.length === 0;
      chevron.classList.toggle('hidden', cities.length === 0);
    },
  };
}
