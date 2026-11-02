import { describe, expect, it } from 'vitest';
import type { Tier } from '../params';
import { createQuality } from '../quality';
import { CHOICES, choose, labelOf, runningText, selectedChoice } from './settings';

const make = (url: Tier | null = null, still = false) => {
  const changes: Tier[] = [];
  return { q: createQuality({ url, still, onChange: (t) => changes.push(t) }), changes };
};

describe('the options', () => {
  it('are Automatic, High, Medium and Low, in that order', () => {
    expect(CHOICES.map((c) => c.label)).toEqual(['Automatic', 'High', 'Medium', 'Low']);
    expect(CHOICES.map((c) => c.value)).toEqual(['auto', 'high', 'medium', 'low']);
  });

  it('each say what they do', () => {
    for (const c of CHOICES) expect(c.hint.length).toBeGreaterThan(10);
  });
});

describe('selectedChoice', () => {
  it('is Automatic until a tier is chosen', () => {
    expect(selectedChoice(make().q)).toBe('auto');
    expect(selectedChoice(make(null, true).q)).toBe('auto');
  });

  it('is the tier from the address or a hand choice', () => {
    expect(selectedChoice(make('medium').q)).toBe('medium');
    const { q } = make();
    q.setTier('low');
    expect(selectedChoice(q)).toBe('low');
  });
});

describe('choose', () => {
  it('sets a tier by hand', () => {
    const { q, changes } = make();
    choose(q, 'low');
    expect([q.tier, q.mode, changes]).toEqual(['low', 'forced', ['low']]);
  });

  it('goes back to Automatic from a tier chosen by hand', () => {
    const { q } = make();
    choose(q, 'low');
    choose(q, 'auto');
    expect([q.tier, q.mode, selectedChoice(q)]).toEqual(['high', 'auto', 'auto']);
  });
});

describe('runningText', () => {
  it('names the tier Automatic is on, and says nothing for a chosen one', () => {
    const { q } = make();
    expect(runningText(q)).toBe('Right now it is on High.');
    choose(q, 'medium');
    expect(runningText(q)).toBe('');
  });

  it('labels every tier', () => {
    expect(labelOf('medium')).toBe('Medium');
  });
});
