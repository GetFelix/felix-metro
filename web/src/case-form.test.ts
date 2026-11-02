import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseSection } from './case-form';
import type { Investigation } from './case';

class Fake {
  children: Fake[] = [];
  textContent = '';
  className = '';
  value = '';
  disabled = false;
  type = '';
  private readonly listeners: Array<() => void> = [];
  constructor(readonly tag: string) {}
  append(...nodes: Fake[]) {
    this.children.push(...nodes);
  }
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  }
  click() {
    for (const fn of this.listeners) fn();
  }
  all(tag: string): Fake[] {
    return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.all(tag)]);
  }
  allBy(match: (c: Fake) => boolean): Fake[] {
    return this.children.flatMap((c) => [...(match(c) ? [c] : []), ...c.allBy(match)]);
  }
}

const inv: Investigation = {
  seed: 'ember',
  day: 0,
  hour: 7,
  street: 'Alder',
  purpose: 'work',
  hintFrom: 6,
  neighbour: 'Oak',
};

function draw() {
  vi.stubGlobal('document', { createElement: (tag: string) => new Fake(tag) });
  const root = caseSection(inv, ['Wharf', 'Oak', 'Alder']) as unknown as Fake;
  const [street, hour, purpose] = root.all('select');
  return {
    root,
    street: street!,
    hour: hour!,
    purpose: purpose!,
    check: root.all('button')[0]!,
    verdict: root.allBy((c) => c.className === 'verdict')[0]!,
    status: root.children[0]!.all('span')[0]!,
  };
}

describe('caseSection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the streets in order, every hour and every purpose, each after a blank choice', () => {
    const { root, street, hour, purpose } = draw();
    expect(root.className).toBe('case');
    expect(street.all('option').map((o) => o.textContent)).toEqual(['Choose', 'Alder', 'Oak', 'Wharf']);
    expect(hour.all('option')).toHaveLength(25);
    expect(hour.all('option')[8]?.textContent).toBe('7 am to 8 am');
    expect(purpose.all('option').map((o) => o.value)).toEqual(['', 'home', 'work', 'school', 'shop', 'leisure']);
  });

  it('shows the hints, never the answer', () => {
    const { root } = draw();
    const clues = root
      .allBy((c) => c.className === 'clues')[0]!
      .all('li')
      .map((li) => li.textContent);
    expect(clues).toEqual(['It was between 6 am and 8 am.', 'Oak crosses the street.']);
  });

  it('does not count a check with a choice missing', () => {
    const { street, check, verdict, status } = draw();
    street.value = 'Alder';
    check.click();
    expect(verdict.textContent).toBe('Choose a street, an hour and a purpose.');
    expect(status.textContent).toBe('Open');
  });

  it('counts a wrong answer, says only that it is wrong, and lets the player try again', () => {
    const { street, hour, purpose, check, verdict, status } = draw();
    [street.value, hour.value, purpose.value] = ['Oak', '7', 'work'];
    check.click();
    expect(verdict.textContent).toBe('Not all three are right. Watch the day again.');
    expect(status.textContent).toBe('Open, 1 try');
    expect(check.disabled).toBe(false);
  });

  it('closes the case on the right answer and locks the choices', () => {
    const { street, hour, purpose, check, verdict, status } = draw();
    [street.value, hour.value, purpose.value] = ['Oak', '7', 'work'];
    check.click();
    street.value = 'Alder';
    check.click();
    expect(verdict.textContent).toBe('Case closed. All three are right.');
    expect(status.textContent).toBe('Solved in 2 tries');
    expect(status.className).toBe('won');
    expect([check, street, hour, purpose].every((c) => c.disabled)).toBe(true);
  });

  it('reads hour 0 as a choice, not as no choice', () => {
    const { street, hour, purpose, check, verdict } = draw();
    [street.value, hour.value, purpose.value] = ['Alder', '0', 'work'];
    check.click();
    expect(verdict.textContent).toBe('Not all three are right. Watch the day again.');
  });
});
