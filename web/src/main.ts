import * as THREE from 'three';
import { createCamera } from './camera';
import { createHud } from './hud';
import { parseParams, type Tier } from './params';
import { createPost, passesFor } from './post';
import { createQuality, settingsFor } from './quality';
import { createRenderer } from './renderer';
import { createCity, move } from './scene';
import init, { generate, Metro } from './core/felix_metro_core.js';
import { parseCity, type City } from './layout';
import { beforeSignIn, fetchOidc } from './auth';
import { CityState, type Building } from './city';
import { TickClock, cityTime } from './clock';
import { connectLive } from './live';
import { Traffic } from './traffic';

declare global {
  interface Window {
    /** True once the first frame is drawn with every model loaded. */
    __ready?: boolean;
    /** Tier history and GPU memory per tier, for the CI step-down check. Only set under ?slow or ?hud. */
    /** The live city's state, for the CI check and for looking at it from the console. */
    __live?: {
      tick: number;
      speed: number;
      voyages: number;
      /** Trips from the log that matched no route of their resident; zero when the sim and this page agree. */
      unplaced: number;
      /** Where each car and walker drawn now stands, in tiles from the middle of the map. */
      where(): { resident: number; car: boolean; x: number; z: number }[];
      /** Put the camera low beside the first car drawn. */
      closeUp(): boolean;
    };
    __quality?: {
      history: readonly Tier[];
      memory: { tier: Tier; textures: number; geometries: number }[];
    };
  }
}

/**
 * Sign in at the gateway and follow the city's log; `null` when nothing here answers like a gateway, or the city
 * cannot be joined, so the page still draws the city, without its people.
 */
async function follow(
  city: City,
  metro: Metro,
  name: string,
  districts: number,
  gateway: string | null,
  pill: HTMLElement,
): Promise<CityState | null> {
  const url = gateway ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const oidc = await fetchOidc(gateway ? url.replace(/^ws/, 'http').replace(/\/ws$/, '/') : location.origin + '/');
  if (!oidc) return null;
  const state = new CityState(city, metro, districts * districts);
  try {
    await connectLive({
      url,
      oidc,
      city: name,
      state,
      onStatus: (status) => {
        pill.textContent = status === 'live' ? 'LIVE' : 'Reconnecting…';
        pill.classList.toggle('late', status !== 'live');
      },
    });
  } catch (err) {
    console.warn('the live city is not available', err);
    return null;
  }
  pill.classList.remove('hidden');
  return state;
}

async function main() {
  const returned = beforeSignIn();
  const {
    frozenHour,
    still,
    tier: urlTier,
    ui,
    hud: showHud,
    slow,
    layout,
    seed,
    districts,
    live: wantLive,
    gateway,
  } = parseParams(returned?.search ?? location.search, returned?.hash ?? location.hash);
  if (!ui) document.querySelectorAll('.chip').forEach((e) => e.classList.add('hidden'));

  let post: ReturnType<typeof createPost> | null = null;
  let hour = 18.5;
  let apply: (tier: Tier) => void = () => {};
  const quality = createQuality({ url: urlTier, still, onChange: (t) => apply(t) });

  const renderer = createRenderer(quality.tier);
  let city: City | null = null;
  let state: CityState | null = null;
  const pill = document.getElementById('pill')!;
  if (layout === 'city') {
    await init();
    city = parseCity(generate(seed, districts));
    document.title = `Felix Metro: ${seed}`;
    document.getElementById('subtitle')!.textContent = seed;
    if (wantLive) state = await follow(city, new Metro(seed, districts), seed, districts, gateway, pill);
  }
  const span = city ? Math.max(1, city.tiles / 17) : 1;
  const { camera, controls } = city
    ? createCamera(renderer.domElement, span * 1.2, new THREE.Vector3())
    : createCamera(renderer.domElement);
  const drawn: ReadonlyMap<number, Building> = new Map(state?.built);
  const { scene, cars, people, glows, setTime, setShadows, fleet, setLot } = await createCity(
    renderer,
    quality.tier,
    city,
    state !== null,
    drawn,
  );
  const hud = showHud ? createHud(renderer, quality) : null;

  // A tier change rebuilds the post chain; shadows and resolution follow the same settings.
  apply = (tier) => {
    const s = settingsFor(tier);
    post?.dispose();
    renderer.setPixelRatio(Math.min(devicePixelRatio, s.pixelRatioCap));
    setShadows(s.shadows, s.shadowMapSize);
    post = createPost(renderer, scene, camera, passesFor(tier), glows);
    setTime(hour, post.bloom);
  };

  const slider = document.getElementById('hour') as HTMLInputElement;
  const clockTicks = new TickClock();
  const traffic = state && fleet ? new Traffic(fleet, city ? (city.tiles - 1) / 2 : 0) : null;
  if (state && traffic) {
    // The sun follows the tick the page draws, so the slider is only a readout.
    slider.disabled = true;
    document.getElementById('timeline')!.dataset.live = '';
    state.onLot = (lot, b) => void setLot(lot, b);
    for (const [lot, b] of state.changesSince(drawn)) void setLot(lot, b);
    state.onVoyageEnd = (v) => traffic.release(v);
    hour = cityTime(Math.max(0, state.latest - 1)).hour;
  }
  hour = frozenHour ?? (state ? hour : parseFloat(slider.value));
  slider.value = String(hour);
  slider.addEventListener('input', () => {
    hour = parseFloat(slider.value);
    setTime(hour, post!.bloom);
  });
  post = createPost(renderer, scene, camera, passesFor(quality.tier), glows);
  setTime(hour, post.bloom);

  addEventListener('visibilitychange', () => quality.restartWindow());

  // Memory is read once per tier, after that tier has rendered, so freed passes show up as lower counts.
  const memory: NonNullable<Window['__quality']>['memory'] = [];
  if (slow || showHud) window.__quality = { history: quality.history, memory };

  const clock = new THREE.Clock();
  let last = performance.now();
  let shownHour = NaN;
  const day = document.getElementById('day')!;
  if (state && traffic) {
    window.__live = {
      tick: NaN,
      speed: state.speed,
      voyages: 0,
      unplaced: 0,
      where: () => traffic.where(),
      closeUp() {
        const car = traffic.where().find((w) => w.car);
        if (!car) return false;
        controls.target.set(car.x, 0.1, car.z);
        camera.position.set(car.x + 1.1, 0.55, car.z + 1.1);
        return true;
      },
    };
  }
  function frame() {
    const now = performance.now();
    const frameMs = now - last;
    last = now;
    quality.tick(frameMs);
    hud?.frame(frameMs);
    if (slow) for (const end = performance.now() + slow; performance.now() < end; );
    const dt = still ? 0 : Math.min(clock.getDelta(), 0.05);
    move(cars, dt, true);
    move(people, dt, false);
    for (const p of people) p.mixer.update(dt);
    if (state && traffic && window.__live) {
      // The clock runs on real time even when frames are slow, so it stays with the sim.
      const tick = clockTicks.advance(Math.min(1, frameMs / 1000), state.latest, state.speed);
      if (!Number.isNaN(tick)) {
        state.retire(Math.floor(tick));
        traffic.update(tick, still ? 0 : dt, state.voyages.values());
        const time = cityTime(tick);
        if (frozenHour === null && !(Math.abs(time.hour - shownHour) <= 0.004)) {
          shownHour = hour = time.hour;
          setTime(hour, post!.bloom);
          day.textContent = `Day ${time.day}`;
        }
        Object.assign(window.__live, {
          tick,
          speed: state.speed,
          voyages: state.voyages.size,
          unplaced: state.unplaced,
        });
      }
    }
    controls.update();
    post!.render(controls.target);
    if (window.__quality && memory[memory.length - 1]?.tier !== quality.tier) {
      const { textures, geometries } = renderer.info.memory;
      memory.push({ tier: quality.tier, textures, geometries });
    }
    requestAnimationFrame(frame);
  }
  move(cars, 0, true);
  move(people, 0, false);
  frame();
  document.body.dataset.ready = '1';
  window.__ready = true;

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post!.resize();
  });
}

main();
