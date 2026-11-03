import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_BUILDING, ROAD_ADDED, ROAD_REMOVED } from './city';
import { decodeRecord, initSync } from './core/felix_metro_core.js';
import { GatewayError } from './gateway';
import {
  ANSWER_MS,
  Placement,
  notRunning,
  whyNot,
  type Blocked,
  type CommandLink,
  type PlacementDeps,
  type SignedIn,
} from './placement';

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./core/felix_metro_core_bg.wasm', import.meta.url)) });
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const stand: SignedIn = { user: 'viewer', standIn: true, city: 'harbor' };

const decode = (bytes: Uint8Array) => JSON.parse(decodeRecord(bytes));

/** Lot 0 is a house outside the development area; 1 and 2 are bare ground inside it. Lot 1 faces east. */
function setup(over: Partial<PlacementDeps> = {}) {
  const sent: Uint8Array[] = [];
  const built = new Map<number, { kind: number; rotation: number }>();
  const state = { tip: true, blocked: null as Blocked | null, fail: null as Error | null };
  const link: CommandLink = {
    name: 'Ana',
    signedIn: stand,
    blocked: () => state.blocked,
    send: async (bytes) => {
      if (state.fail) throw state.fail;
      sent.push(bytes);
    },
  };
  let id = 100;
  const placement = new Placement({
    ground: () => ({
      city: {
        development: [1, 2],
        lots: [19, NO_BUILDING, NO_BUILDING].map((kind, lot) => ({ id: lot, kind })) as never,
      },
      built,
    }),
    link,
    atTip: () => state.tip,
    wantsLive: true,
    facing: (lot) => (lot === 1 ? 1 : 0),
    newId: () => id++,
    ...over,
  });
  return { placement, sent, built, state };
}

describe('when the tools can be used', () => {
  it('needs a live city, a page at the live tip and a sign-in that may build', () => {
    const base = { link: null, atTip: () => true, wantsLive: true };
    expect(whyNot(base)).toBe('Building needs a live city.');
    const link = { name: 'Ana', signedIn: stand, blocked: () => null as Blocked | null, send: async () => {} };
    expect(whyNot({ ...base, link, wantsLive: false })).toBe('Building needs a live city.');
    expect(whyNot({ ...base, link, atTip: () => false })).toBe('Go back to live to build.');
    expect(whyNot({ ...base, link: { ...link, blocked: () => 'viewer' } })).toBe(
      'Signed in as viewer, who can only watch. Open ?as=mayor in a new tab to build.',
    );
    expect(whyNot({ ...base, link: { ...link, blocked: () => 'down' } })).toMatch(/out of reach/);
    expect(whyNot({ ...base, link })).toBeNull();
  });

  it('tells a viewer on a real provider which role builds, with no ?as link', () => {
    const base = { atTip: () => true, wantsLive: true };
    const real: SignedIn = { user: 'Ana', standIn: false, city: 'harbor_bridge-closed' };
    const link = { name: 'Ana', signedIn: real, blocked: () => 'viewer' as Blocked | null, send: async () => {} };
    expect(whyNot({ ...base, link })).toBe(
      'Signed in as Ana, who can only watch. Building here needs the build role, role:metro-harbor-build.',
    );
    const { placement } = setup({ link });
    expect(placement.fix()).toBeNull();
  });

  it('names a fork by its lineage in the command to start it', () => {
    expect(notRunning('harbor_bridge')).toBe(
      'Harbor~bridge is not running. Start it with dev/city.sh harbor~bridge (./city.sh harbor~bridge in the release bundle).',
    );
  });

  it('links ?as=mayor only on the stand-in', () => {
    expect(setup().placement.fix()).toEqual({ label: '?as=mayor', user: 'mayor' });
  });

  it('says a city the sim has not started is not running, and how to start it', () => {
    const base = { atTip: () => true, wantsLive: true };
    const link = {
      name: 'Ana',
      signedIn: { ...stand, user: 'mayor', city: 'pier' },
      blocked: () => 'idle' as Blocked | null,
      send: async () => {},
    };
    expect(whyNot({ ...base, link })).toBe(
      'Pier is not running. Start it with dev/city.sh pier (./city.sh pier in the release bundle).',
    );
  });

  it('will not pick a tool while blocked, and puts it away if the page leaves the tip', () => {
    const { placement, state } = setup();
    state.tip = false;
    expect(placement.select('build')).toBe(false);
    expect(placement.tool).toBeNull();
    state.tip = true;
    expect(placement.select('build')).toBe(true);
    expect(placement.tool).toBe('build');
    placement.drop();
    expect(placement.tool).toBeNull();
  });

  it('puts a tool away by picking it again, and swaps one for the other', () => {
    const { placement } = setup();
    placement.select('build');
    placement.select('demolish');
    expect(placement.tool).toBe('demolish');
    placement.select('demolish');
    expect(placement.tool).toBeNull();
  });
});

describe('the preview', () => {
  it('says whether the tool fits the lot, in the sim’s terms', () => {
    const { placement, built } = setup();
    placement.select('build');
    expect(placement.preview(1)).toMatchObject({ lot: 1, check: { ok: true } });
    expect(placement.preview(0)?.check.ok).toBe(false);
    built.set(2, { kind: 20, rotation: 0 });
    expect(placement.preview(2)?.check.ok).toBe(false);
    placement.select('demolish');
    expect(placement.preview(2)?.check.ok).toBe(true);
    expect(placement.preview(1)?.check.ok).toBe(false);
  });

  it('has none without a tool or a lot', () => {
    const { placement } = setup();
    expect(placement.preview(1)).toBeNull();
    placement.select('build');
    expect(placement.preview()).toBeNull();
  });

  it('faces the street until the builder turns it, then turns from there', () => {
    const { placement } = setup();
    placement.select('build');
    expect(placement.preview(1)?.rotation).toBe(1);
    expect(placement.preview(2)?.rotation).toBe(0);
    placement.hover(1);
    placement.rotate();
    expect(placement.preview(1)?.rotation).toBe(2);
    expect(placement.preview(2)?.rotation).toBe(2);
    for (let i = 0; i < 3; i++) placement.rotate();
    expect(placement.preview(1)?.rotation).toBe(1);
  });

  it('steps through the kinds and wraps', () => {
    const { placement } = setup();
    const first = placement.kind;
    placement.step(1);
    expect(placement.kind).toBe(first + 1);
    placement.setKind(0);
    placement.step(-1);
    expect(placement.kind).toBe(37);
  });

  it('tells listeners when the hovered lot changes, and only then', () => {
    const { placement } = setup();
    let calls = 0;
    placement.onChange(() => calls++);
    placement.hover(1);
    placement.hover(1);
    expect(calls).toBe(1);
  });
});

describe('sending', () => {
  it('sends a build for the lot, kind and way it faces', async () => {
    const { placement, sent } = setup();
    placement.select('build');
    placement.setKind(23);
    expect(await placement.commit(1)).toBeNull();
    expect(decode(sent[0]!)).toEqual({
      kind: 'command',
      id: 100,
      name: 'Ana',
      command: { type: 'build', lot: 1, kind: 23, rotation: 1 },
    });
    expect(placement.pending).toBe(1);
    expect(placement.status).toMatchObject({ state: 'waiting' });
  });

  it('sends a demolish', async () => {
    const { placement, sent, built } = setup();
    built.set(2, { kind: 20, rotation: 0 });
    placement.select('demolish');
    await placement.commit(2);
    expect(decode(sent[0]!).command).toEqual({ type: 'demolish', lot: 2 });
  });

  it('sends nothing the sim would refuse, and says why', async () => {
    const { placement, sent } = setup();
    placement.select('build');
    expect(await placement.commit(0)).toBe('Only the cleared ground can be built on.');
    expect(sent).toHaveLength(0);
    expect(placement.sent).toBe(0);
    expect(placement.answered).toBe(1);
    expect(placement.status).toMatchObject({ state: 'refused', text: 'Only the cleared ground can be built on.' });
    expect(placement.pending).toBe(0);
  });

  it('sends nothing when the page is not at the live tip', async () => {
    const { placement, sent, state } = setup();
    placement.select('build');
    state.tip = false;
    expect(await placement.commit(1)).toBe('Go back to live to build.');
    expect(sent).toHaveLength(0);
  });

  it('holds a lot while its command is out, so a second click does not send a second', async () => {
    const { placement, sent } = setup();
    placement.select('build');
    await placement.commit(1);
    expect(placement.preview(1)?.check).toEqual({ ok: false, why: 'Your last change here is still going through.' });
    expect(await placement.commit(1)).toBe('Your last change here is still going through.');
    expect(sent).toHaveLength(1);
    await placement.commit(2);
    expect(sent).toHaveLength(2);
  });

  it('reports a command that could not be sent, and lets the lot be tried again', async () => {
    const { placement, state } = setup();
    placement.select('build');
    state.fail = new GatewayError('publish_failed', 'no');
    expect(await placement.commit(1)).toBe('That could not be sent. Try again in a moment.');
    expect(placement.pending).toBe(0);
    state.fail = new GatewayError('forbidden', 'no');
    expect(await placement.commit(1)).toBe(
      'Signed in as viewer, who can only watch. Open ?as=mayor in a new tab to build.',
    );
    state.fail = null;
    expect(await placement.commit(1)).toBeNull();
  });
});

describe('what became of a command', () => {
  it('reads an applied build and a refused one from the command event', async () => {
    const { placement } = setup();
    placement.select('build');
    await placement.commit(1);
    placement.result(100, 0);
    expect(placement.status).toEqual({ state: 'done', text: 'Built.' });
    expect(placement.pending).toBe(0);
    expect(placement.answered).toBe(1);
    await placement.commit(2);
    placement.result(101, 3);
    expect(placement.status).toEqual({ state: 'refused', text: 'Someone built there first.' });
  });

  it('says taken down for a demolish', async () => {
    const { placement, built } = setup();
    built.set(2, { kind: 20, rotation: 0 });
    placement.select('demolish');
    await placement.commit(2);
    placement.result(100, 0);
    expect(placement.status).toEqual({ state: 'done', text: 'Taken down.' });
  });

  it('ignores commands it did not send', async () => {
    const { placement } = setup();
    placement.select('build');
    await placement.commit(1);
    placement.result(555, 3);
    expect(placement.answered).toBe(0);
    expect(placement.status).toMatchObject({ state: 'waiting' });
    expect(placement.pending).toBe(1);
  });

  it('takes an answer that beats the publish’s own acknowledgement', async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { placement } = setup({
      link: { name: 'Ana', signedIn: stand, blocked: () => null, send: () => slow },
    });
    placement.select('build');
    const sending = placement.commit(1);
    placement.result(100, 0);
    release();
    await sending;
    expect(placement.status).toEqual({ state: 'done', text: 'Built.' });
  });

  it('says so when the city has not answered in a while, and frees the lot', async () => {
    const { placement } = setup();
    placement.select('build');
    await placement.commit(1);
    vi.advanceTimersByTime(ANSWER_MS + 1);
    expect(placement.status).toMatchObject({ state: 'refused', text: expect.stringContaining('not answered') });
    expect(placement.pending).toBe(0);
    expect(placement.preview(1)?.check.ok).toBe(true);
  });
});

describe('the road tool', () => {
  /** Nodes 0 and 1 at the ends of a row of cleared ground; node 2 off in a corner. Core says 0 for 0 to 1 only. */
  function roads(over: Partial<PlacementDeps> = {}) {
    const roadMap = new Map<number, { change: number; a: number; b: number }>();
    const t = setup({
      ground: () => ({
        city: {
          development: [0, 1],
          nodes: [
            [0, 0],
            [3, 0],
            [9, 9],
          ],
          lots: [
            { id: 0, x: 1, z: 0, kind: NO_BUILDING, doorSegment: 0 },
            { id: 1, x: 2, z: 0, kind: NO_BUILDING, doorSegment: 0 },
          ] as never,
        },
        built: new Map(),
        roads: roadMap,
      }),
      roadCheck: (a, b) => (Math.min(a, b) === 0 && Math.max(a, b) === 1 ? 0 : 22),
      ...over,
    });
    t.placement.select('road');
    return { ...t, roadMap };
  }

  it('picks the first end, shows the road to the second and sends it', async () => {
    const { placement, sent } = roads();
    placement.hoverRoad({ node: 0, segment: null });
    expect(placement.roadPreview()).toEqual({ kind: 'start', a: 0, check: { ok: true } });
    expect(await placement.commitRoad()).toBeNull();
    expect(placement.roadStart).toBe(0);
    expect(sent).toHaveLength(0);
    placement.hoverRoad({ node: 1, segment: null });
    expect(placement.roadPreview()).toEqual({ kind: 'lay', a: 0, b: 1, check: { ok: true } });
    expect(await placement.commitRoad()).toBeNull();
    expect(decode(sent[0]!)).toMatchObject({ id: 100, name: 'Ana', command: { type: 'placeRoad', a: 0, b: 1 } });
    expect(placement.roadStart).toBeNull();
    expect(placement.status).toEqual({ state: 'waiting', text: 'Waiting for the city…' });
    placement.result(100, 0);
    expect(placement.status).toEqual({ state: 'done', text: 'Road laid.' });
  });

  it('shows a refused road in red with the reason, and sends nothing', async () => {
    const { placement, sent } = roads();
    placement.hoverRoad({ node: 0, segment: null });
    await placement.commitRoad();
    placement.hoverRoad({ node: 2, segment: null });
    const preview = placement.roadPreview()!;
    expect(preview).toMatchObject({ kind: 'lay', check: { ok: false, why: expect.stringMatching(/straight/) } });
    expect(await placement.commitRoad()).toMatch(/straight/);
    expect(sent).toHaveLength(0);
    // The first end stays, so another second end can be tried.
    expect(placement.roadStart).toBe(0);
  });

  it('drops the first end on Esc, and puts the tool away on a second', () => {
    const { placement } = roads();
    placement.hoverRoad({ node: 0, segment: null });
    void placement.commitRoad();
    placement.cancel();
    expect(placement.roadStart).toBeNull();
    expect(placement.tool).toBe('road');
    placement.cancel();
    expect(placement.tool).toBeNull();
  });

  it('takes away a builder’s road under the pointer, and says why not for the city’s own', async () => {
    const { placement, sent, roadMap } = roads();
    roadMap.set(104, { change: ROAD_ADDED, a: 0, b: 1 });
    placement.hoverRoad({ node: 0, segment: 104 });
    expect(placement.roadPreview()).toEqual({ kind: 'remove', segment: 104, check: { ok: true } });
    expect(await placement.commitRoad()).toBeNull();
    expect(decode(sent[0]!)).toMatchObject({ command: { type: 'removeRoad', segment: 104 } });
    expect(placement.roadPreview()!.check).toMatchObject({
      ok: false,
      why: expect.stringMatching(/still going through/),
    });
    placement.result(100, 26);
    expect(placement.status.state === 'refused' && placement.status.text).toMatch(/builder laid/);
    roadMap.set(104, { change: ROAD_REMOVED, a: 0, b: 1 });
    expect(placement.roadPreview()!.check).toMatchObject({ ok: false, why: expect.stringMatching(/own streets/) });
  });

  it('holds a road while it goes through, so a second click does not send it again', async () => {
    const { placement, sent } = roads();
    for (const node of [0, 1]) {
      placement.hoverRoad({ node, segment: null });
      await placement.commitRoad();
    }
    for (const node of [1, 0]) {
      placement.hoverRoad({ node, segment: null });
      await placement.commitRoad();
    }
    expect(sent).toHaveLength(1);
    expect(placement.status).toMatchObject({ state: 'refused', text: expect.stringMatching(/still going through/) });
  });

  it('refuses every road without core to ask, and is off with the other tools away from the tip', async () => {
    const { placement, state } = roads({ roadCheck: undefined });
    placement.hoverRoad({ node: 0, segment: null });
    await placement.commitRoad();
    placement.hoverRoad({ node: 1, segment: null });
    expect(placement.roadPreview()!.check.ok).toBe(false);
    state.tip = false;
    expect(await placement.commitRoad()).toBe('Go back to live to build.');
  });
});
