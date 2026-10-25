import { describe, expect, it } from 'vitest';
import { parseParams } from './params';

describe('parseParams', () => {
  it('defaults to a running scene with the overlay and no forced tier', () => {
    expect(parseParams('')).toEqual({
      frozenHour: null,
      still: false,
      tier: null,
      ui: true,
      hud: false,
      slow: 0,
      layout: 'city',
      seed: 'harbor',
      districts: 2,
      live: true,
      gateway: null,
      at: null,
      trace: false,
      capture: false,
    });
  });

  it('hands the render clock to the clip script only together with ?trace', () => {
    expect(parseParams('?capture&trace').capture).toBe(true);
    expect(parseParams('?capture').capture).toBe(false);
    expect(parseParams('?trace').capture).toBe(false);
  });

  it('follows the gateway unless told not to, and takes another gateway’s address', () => {
    expect(parseParams('?live=0').live).toBe(false);
    expect(parseParams('?live=1').live).toBe(true);
    expect(parseParams('?gateway=ws://127.0.0.1:8787/ws').gateway).toBe('ws://127.0.0.1:8787/ws');
  });

  it('reads the frozen hour, still, tier, ui and hud flags', () => {
    expect(parseParams('?t=17.8&still&tier=low&ui=0&hud&slow=40')).toMatchObject({
      frozenHour: 17.8,
      still: true,
      tier: 'low',
      ui: false,
      hud: true,
      slow: 40,
    });
  });

  it('keeps the overlay for any ui value but 0', () => {
    expect(parseParams('?ui=1').ui).toBe(true);
  });

  it('ignores an unknown tier', () => {
    expect(parseParams('?tier=ultra').tier).toBeNull();
  });

  it('draws the generated city unless asked for the frame, with the seed from the hash', () => {
    expect(parseParams('?layout=frame').layout).toBe('frame');
    expect(parseParams('', '#pinecrest')).toMatchObject({ layout: 'city', seed: 'pinecrest' });
    expect(parseParams('?districts=3').districts).toBe(3);
    expect(parseParams('?districts=0').districts).toBe(2);
    expect(parseParams('?districts=99').districts).toBe(16);
  });

  it('takes a tick to open the city at, and only a whole one', () => {
    expect(parseParams('?at=1234').at).toBe(1234);
    expect(parseParams('').at).toBeNull();
    for (const bad of ['?at=', '?at=-5', '?at=1.5', '?at=soon']) expect(parseParams(bad).at).toBeNull();
    // `t` stays the frozen hour.
    expect(parseParams('?t=18.5&at=40')).toMatchObject({ frozenHour: 18.5, at: 40 });
  });
});
