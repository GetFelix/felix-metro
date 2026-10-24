// Dev page for CI: one lot going up or coming down, drawn at a tick given in the URL, reached the way a seek, a
// forward run or a rewind would reach it. All routes must draw the same picture, which scripts/check-construction.mjs
// compares with a reference render.
//   ?mode=build|demolish  ?tick=104  ?via=forward|seek|back  ?tier=low
import * as THREE from 'three';
import init, { generate } from './core/felix_metro_core.js';
import { CityState, NO_BUILDING, type TickEvent, type TickRecord, type Trips } from './city';
import { parseCity } from './layout';
import { createCity } from './scene';
import { createPost, passesFor } from './post';
import { createRenderer } from './renderer';
import { fold, type SeekResult } from './seek';

declare global {
  interface Window {
    __ready?: boolean;
    __construction?: { active: number; rising: number; falling: number };
  }
}

/** The tick the lot's building is built or demolished at. */
const EVENT = 100;
const TRIPS: Trips = { trip: () => undefined };

function recordAt(district: number, tick: number, events: TickEvent[] = [], keyframe: TickRecord['keyframe'] = null) {
  return {
    kind: 'tick',
    epoch: 1,
    district,
    tick,
    speed: 4,
    keyframeOffset: 0,
    wallUs: 0,
    keyframe,
    events,
  } as TickRecord;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const tick = Number(params.get('tick') ?? '104');
  const demolish = params.get('mode') === 'demolish';
  const via = params.get('via') ?? 'forward';
  const tier = params.get('tier') === 'low' ? 'low' : 'medium';

  await init();
  const city = parseCity(generate('harbor', 2));
  // The commercial lot nearest the camera's corner, so nothing stands between it and the view.
  const lot = city.lots
    .filter((l) => (l.zone === 'downtown' || l.zone === 'commercial') && l.kind !== NO_BUILDING && l.id !== city.tower)
    .reduce((a, b) => (b.x + b.z > a.x + a.z ? b : a));
  // A skyscraper goes up where nothing stood; a demolition takes down what the city generated.
  const building = demolish ? { kind: lot.kind, rotation: lot.facing } : { kind: 16, rotation: lot.facing };
  const event: TickEvent = demolish
    ? { type: 'demolished', lot: lot.id, kind: building.kind, rotation: building.rotation }
    : { type: 'built', lot: lot.id, kind: building.kind, rotation: building.rotation };
  const districts = 4;
  const d = lot.district;

  /** The state at `to`, folded from tick 96 on or, via a seek, from a keyframe just after the event. */
  const stateAt = (to: number, route: string) => {
    const state = new CityState(city, TRIPS, districts);
    const other = (t: number) => [0, 1, 2, 3].filter((x) => x !== d).map((x) => recordAt(x, t));
    const gone = demolish
      ? [[lot.id, NO_BUILDING, 0] as [number, number, number]]
      : [[lot.id, building.kind, building.rotation] as [number, number, number]];
    if (route === 'seek') {
      // A keyframe one tick after the event lists the lot finished; the event is only in the records before it.
      const k = EVENT + 1;
      const districtsSeek = [0, 1, 2, 3].map((x) => ({
        records: [recordAt(x, k, [], x === d ? { buildings: gone } : { buildings: [] })].concat(
          Array.from({ length: Math.max(0, to - k) }, (_, i) => recordAt(x, k + 1 + i)),
        ),
        offset: 0,
        before: x === d ? [recordAt(x, EVENT, [event])] : [],
      }));
      fold(state, { tick: Math.max(to, k), requested: to, exact: true, districts: districtsSeek } as SeekResult);
      return state;
    }
    const empty = demolish ? { buildings: [] } : { buildings: [[lot.id, NO_BUILDING, 0] as [number, number, number]] };
    for (let t = 96; t <= to; t++) {
      state.apply(recordAt(d, t, t === EVENT ? [event] : [], t === 96 ? empty : null));
      for (const r of other(t)) state.apply(r);
    }
    return state;
  };

  const renderer = createRenderer(tier);
  const initial = new Map([[lot.id, demolish ? building : { kind: NO_BUILDING, rotation: 0 }]]);
  const { scene, construction, lots, glows, setTime, setLot } = await createCity(renderer, tier, city, false, initial);
  let state = stateAt(tick, via === 'back' ? 'forward' : via);
  if (via === 'back') state = stateAt(tick + 6, 'forward');
  // The lot as the state has it; a lot not yet built, or already gone, has nothing standing.
  const standingAt = (s: CityState) => s.built.get(lot.id) ?? null;
  const show = async (s: CityState) => setLot(lot.id, standingAt(s));
  await show(state);
  if (via === 'back') {
    // Rewind: the way main does, a state folded afresh to the earlier tick replaces the one on screen.
    state = stateAt(tick, 'forward');
    await show(state);
  }

  const [cx, cz] = lots.centre(lot.id);
  const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(cx + 3.2, 3.4, cz + 4.2);
  const target = new THREE.Vector3(cx, 0.5, cz);
  camera.lookAt(target);
  const post = createPost(renderer, scene, camera, passesFor(tier), glows);
  construction.setEffects(tier !== 'low');
  setTime(Number(params.get('t') ?? '12'), post.bloom);

  // A falling building is drawn as it is asked for, so give its models time to arrive before the first frame.
  construction.update(tick, state.rising, state.falling);
  for (let i = 0; i < 200 && demolish && progressInside(tick) && lots.ghosts(lot.id).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  construction.update(tick, state.rising, state.falling);
  post.render(target);
  window.__construction = { active: construction.active, rising: state.rising.size, falling: state.falling.size };
  window.__ready = true;
}

const progressInside = (tick: number) => tick > EVENT && tick < EVENT + 8;

main().catch((e) => {
  console.error('the construction page could not start', e);
  document.body.dataset.error = String(e);
});
