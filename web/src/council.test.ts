import { afterEach, describe, expect, it, vi } from 'vitest';
import { councilSummary, councilView, recallText, renderCouncil, type CouncilEvent, type Standing } from './council';

const standing = (over: Partial<Standing> = {}): Standing => ({
  demand: 48,
  measure: 62,
  satisfaction: 77,
  unhappyDays: 0,
  ...over,
});

const event = (days: number, standings: Standing[]): CouncilEvent => ({
  type: 'council',
  days,
  patience: 3,
  standings,
});

const calm = [standing(), standing({ demand: 80, measure: 71, satisfaction: 88 }), standing({ demand: 5, measure: 4 })];

describe('councilView', () => {
  it('states each demand and how the last day went', () => {
    const view = councilView(event(2, calm), 1);
    expect(view.factions.map((f) => f.name)).toEqual(['Commuters', 'Harbor residents', 'Shops']);
    expect(view.factions[0]).toMatchObject({
      wants: 'Trips to work or school of 12 min or less',
      now: '15.5 min',
      satisfaction: 77,
    });
    expect(view.factions[1]?.now).toBe('71%');
    expect(view.recall).toBeNull();
  });

  it('shows the demands but no score before the first day is scored', () => {
    const view = councilView(event(0, calm), 1);
    expect(view.factions.every((f) => f.satisfaction === null && f.now === null)).toBe(true);
    expect(view.factions[2]?.wants).toBe('5 visits a day each');
  });

  it('calls the residents of a city with no shore just residents', () => {
    expect(councilView(event(1, calm), null).factions[1]?.name).toBe('Residents');
  });

  it('counts down from the faction that has been unhappy longest', () => {
    const standings = [standing({ unhappyDays: 1 }), calm[1]!, standing({ unhappyDays: 2 })];
    const { recall } = councilView(event(3, standings), 1);
    expect(recall).toEqual({ faction: 'Shops', daysLeft: 1 });
    expect(recallText(recall!)).toBe('Shops will recall the mayor in 1 day');
  });

  it('says so once the council has run out of patience', () => {
    const { recall } = councilView(event(5, [standing({ unhappyDays: 3 }), calm[1]!, calm[2]!]), 1);
    expect(recall).toEqual({ faction: 'Commuters', daysLeft: 0 });
    expect(recallText(recall!)).toBe('Commuters have recalled the mayor');
  });
});

describe('councilSummary', () => {
  it('names the faction that is worst off', () => {
    const standings = [standing(), standing({ satisfaction: 41 }), standing({ satisfaction: 90 })];
    expect(councilSummary(councilView(event(2, standings), 1))).toBe('Lowest: Harbor residents 41');
  });

  it('says nothing has been scored before the first day ends', () => {
    expect(councilSummary(councilView(event(0, calm), 1))).toBe('Not scored yet');
  });

  it('gives the recall warning over the scores', () => {
    const standings = [standing({ unhappyDays: 2, satisfaction: 30 }), calm[1]!, calm[2]!];
    expect(councilSummary(councilView(event(3, standings), 1))).toBe('Commuters will recall the mayor in 1 day');
  });
});

/** Just enough of an element for `renderCouncil`: the page has no DOM under test. */
class Fake {
  children: Fake[] = [];
  textContent = '';
  className = '';
  open = false;
  style: Record<string, string> = {};
  private readonly flags = new Set<string>();
  constructor(readonly tag: string) {}
  get firstElementChild(): Fake | null {
    return this.children[0] ?? null;
  }
  get classList() {
    return {
      toggle: (name: string, on: boolean) => void (on ? this.flags.add(name) : this.flags.delete(name)),
      contains: (name: string) => this.flags.has(name),
    };
  }
  append(...nodes: Fake[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Fake[]) {
    this.children = nodes;
  }
  all(tag: string): Fake[] {
    return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.all(tag)]);
  }
}

describe('renderCouncil', () => {
  afterEach(() => vi.unstubAllGlobals());
  const draw = (root: Fake, days: number, openFirst = false) => {
    vi.stubGlobal('document', { createElement: (tag: string) => new Fake(tag) });
    renderCouncil(root as unknown as HTMLElement, councilView(event(days, calm), 1), openFirst);
  };

  it('folds to one summary line unless it is told to start open', () => {
    const root = new Fake('div');
    draw(root, 2);
    expect(root.all('details')[0]?.open).toBe(false);
    expect(root.all('summary')[0]?.children[1]?.textContent).toBe('Lowest: Commuters 77');
  });

  it("keeps the player's choice across a redraw", () => {
    const root = new Fake('div');
    draw(root, 2, true);
    root.all('details')[0]!.open = false;
    draw(root, 3, true);
    expect(root.all('details')[0]?.open).toBe(false);
  });

  it('writes not scored yet instead of an empty bar before the first day', () => {
    const root = new Fake('div');
    draw(root, 0);
    const scores = root.all('li').map((li) => li.children[0]?.children[1]?.textContent);
    expect(scores).toEqual(['not scored yet', 'not scored yet', 'not scored yet']);
  });
});
