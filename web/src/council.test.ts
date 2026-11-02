import { describe, expect, it } from 'vitest';
import { councilView, recallText, type CouncilEvent, type Standing } from './council';

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
