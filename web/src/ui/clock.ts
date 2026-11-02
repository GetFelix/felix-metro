// The clock in the top right: HH:MM, with a digit that changes rolling to its new value.
// Only the digits that change move. `#clock`'s text stays the plain time, so a script or a screen reader reads it as one.

/** Rolling forward brings the new digit up from below; a clock going back brings it down from above. */
export type Roll = 1 | -1;

/** Which way to roll from `from` to `to`, both `HH:MM`: whichever way is shorter round the 24 hours. */
export function rollDirection(from: string, to: string): Roll {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const step = (minutes(to) - minutes(from) + 1440) % 1440;
  return step > 720 ? -1 : 1;
}

const isDigit = (c: string) => c >= '0' && c <= '9';

/** Whether `text` has digits and separators where `before` does, so it can be rolled into rather than rebuilt. */
export function sameShape(before: string, text: string): boolean {
  return before.length === text.length && [...text].every((c, i) => isDigit(c) === isDigit(before[i]!));
}

/** The positions of the digits that differ between two texts of the same shape. */
export function changedDigits(before: string, text: string): number[] {
  return [...text].flatMap((c, i) => (isDigit(c) && before[i] !== c ? [i] : []));
}

const quiet = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Make `el` a rolling clock. `reduced` says whether motion is off; it is read at every change. */
export function createClock(el: HTMLElement, reduced: () => boolean = quiet) {
  let shown = '';
  let cells: (HTMLElement | null)[] = [];

  const digit = (c: string) => {
    const cell = document.createElement('i');
    cell.className = 'digit';
    const cur = document.createElement('i');
    cur.className = 'cur';
    cur.textContent = c;
    cell.append(cur);
    return cell;
  };

  function build(text: string) {
    cells = [...text].map((c) => (isDigit(c) ? digit(c) : null));
    el.replaceChildren(...[...text].map((c, i) => cells[i] ?? c));
  }

  function roll(cell: HTMLElement, from: string, to: string, dir: Roll) {
    const cur = cell.firstElementChild as HTMLElement;
    cur.textContent = to;
    if (reduced()) return;
    cur.dataset.old = from;
    cell.style.setProperty('--dir', String(dir));
    // Taking the class off and putting it back restarts the animation when the digit changes again mid-roll.
    cell.classList.remove('roll');
    void cell.offsetWidth;
    cell.classList.add('roll');
    // The clip that hides the digit leaving only lasts for the roll.
    cur.onanimationend = () => cell.classList.remove('roll');
  }

  return {
    set(text: string) {
      if (text === shown) return;
      const before = shown;
      shown = text;
      if (!sameShape(before, text)) return build(text);
      const dir = rollDirection(before, text);
      for (const i of changedDigits(before, text)) roll(cells[i]!, before[i]!, text[i]!, dir);
    },
  };
}

let view: ReturnType<typeof createClock> | null = null;

/** Show `text` in the page's `#clock`. */
export function showClock(text: string) {
  view ??= createClock(document.getElementById('clock')!);
  view.set(text);
}
