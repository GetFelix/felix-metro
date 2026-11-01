import * as THREE from 'three';
import { bindInput } from './camera-input';
import type { CameraAction } from './camera-keys';
import {
  cityBounds,
  clampView,
  nearestAngle,
  offsetOf,
  orbitBy,
  panBy,
  panGrab,
  settled,
  stepSpring,
  viewFromOffset,
  wrapAngle,
  zoomToward,
  type Bounds,
  type Limits,
  type Ndc,
  type Spring,
  type View,
} from './camera-math';

/** The style frame's map is this many tiles across; its camera may roam over it. */
const FRAME_TILES = 17;

/** How stiff the follow is: while the person drags it is quick, and a programmatic move takes about half a second. */
const INPUT_OMEGA = 16;
const EASE_OMEGA = 9;

/** Per second with a key held: the share of the distance the view slides, the radians it turns, the e-folds of zoom. */
const KEY_PAN = 0.9;
const KEY_TURN = 1.3;
const KEY_ZOOM = 1.4;

/** Where the camera is looking from, as a small object that survives `JSON.stringify` (for the link that shares a view). */
export type CameraState = View;

export interface MoveOptions {
  /** Ease there on a spring (the default), or jump. A person who asked for less motion always gets the jump. */
  ease?: boolean;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Looks at a point on the ground from a distance and two angles, and is the one thing that moves the camera. The
 * person's input and the app's own moves (`moveTo`) both set a goal, and the camera chases it on a spring that does not
 * bounce. `target` is the point it looks at, as Three.js's controls have it, for the passes that focus on it.
 */
export class CameraRig extends THREE.EventDispatcher<{ start: object }> {
  readonly target: THREE.Vector3;
  enabled = true;
  private goal: View;
  private readonly springs: Record<keyof View, Spring>;
  private omega = INPUT_OMEGA;
  private readonly held = new Set<CameraAction>();
  private last = performance.now();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly limits: Limits,
    private readonly home: View,
    private readonly height = 0,
  ) {
    super();
    this.target = new THREE.Vector3(home.x, height, home.z);
    this.goal = { ...home };
    const spring = (value: number): Spring => ({ value, velocity: 0 });
    this.springs = {
      x: spring(home.x),
      z: spring(home.z),
      distance: spring(home.distance),
      azimuth: spring(home.azimuth),
      polar: spring(home.polar),
    };
    camera.lookAt(this.target);
  }

  /** Where the camera is heading: the settled view, which is what a shared link should hold. Rounded to 3 places. */
  state(): CameraState {
    const g = this.goal;
    return {
      x: round(g.x),
      z: round(g.z),
      distance: round(g.distance),
      azimuth: round(wrapAngle(g.azimuth)),
      polar: round(g.polar),
    };
  }

  /** Go to a saved view; false, and no move, when it is not a view. */
  setState(s: Partial<CameraState> | null | undefined, options: MoveOptions = {}): boolean {
    if (!s || ![s.x, s.z, s.distance, s.azimuth, s.polar].every((n) => typeof n === 'number' && Number.isFinite(n)))
      return false;
    this.moveTo({ x: s.x!, z: s.z! }, s.distance!, s.azimuth!, s.polar!, options);
    return true;
  }

  /**
   * Look at (x, z) on the ground from `distance` at the two angles. Every number is held inside the limits. The turn
   * takes the short way round.
   */
  moveTo(
    target: { x: number; z: number },
    distance: number,
    azimuth: number,
    polar: number,
    options: MoveOptions = {},
  ) {
    const to = clampView(
      { x: target.x, z: target.z, distance, azimuth: nearestAngle(this.goal.azimuth, azimuth), polar },
      this.limits,
    );
    this.goal = to;
    if (options.ease === false || reducedMotion()) this.place(to);
    else this.omega = EASE_OMEGA;
  }

  /** Back to the view the page opened on. */
  reset(options: MoveOptions = {}) {
    this.moveTo(this.home, this.home.distance, this.home.azimuth, this.home.polar, options);
  }

  /** Put the camera at `view` at once, with nothing left to chase. */
  place(view: View) {
    const to = clampView(view, this.limits);
    this.goal = to;
    for (const k of Object.keys(this.springs) as (keyof View)[]) {
      this.springs[k].value = to[k];
      this.springs[k].velocity = 0;
    }
    this.apply();
  }

  /** The view as drawn right now, between where it was and where it is heading. */
  view(): View {
    const s = this.springs;
    return { x: s.x.value, z: s.z.value, distance: s.distance.value, azimuth: s.azimuth.value, polar: s.polar.value };
  }

  // The person's input. Each one takes the camera over from any move in progress.

  /** Turn by `azimuth` and tilt by `polar` radians. */
  orbit(azimuth: number, polar: number) {
    this.take();
    this.goal = orbitBy(this.goal, azimuth, polar, this.limits);
  }

  /** Drag the ground so what was under `from` is under `to`. */
  grab(from: Ndc, to: Ndc) {
    this.take();
    this.goal = panGrab(this.goal, from, to, this.lens(), this.limits);
  }

  /** Scale the distance by `factor`, keeping the ground under `at` where it is. */
  zoomAt(at: Ndc, factor: number) {
    this.take();
    this.goal = zoomToward(this.goal, at, factor, this.lens(), this.limits);
  }

  /** Start or stop a held key's motion. */
  hold(action: CameraAction, down: boolean) {
    if (down) {
      this.take();
      this.held.add(action);
    } else this.held.delete(action);
  }

  releaseAll() {
    this.held.clear();
  }

  /** Move the camera a frame on. `dt` is in seconds and defaults to the time since the last call. */
  update(dt?: number): boolean {
    const now = performance.now();
    const elapsed = dt ?? (now - this.last) / 1000;
    this.last = now;
    // The spring is exact for any step, so a slow frame still arrives on time; a held key moves by the step, so it is capped.
    const step = Math.min(0.25, elapsed);
    if (this.enabled && this.held.size) this.keys(Math.min(0.1, elapsed));
    const before = this.view();
    let moving = false;
    for (const k of Object.keys(this.springs) as (keyof View)[]) {
      const s = this.springs[k];
      stepSpring(s, this.goal[k], this.omega, step);
      if (settled(s, this.goal[k], 1e-4)) {
        s.value = this.goal[k];
        s.velocity = 0;
      } else moving = true;
    }
    const after = this.view();
    const changed = (Object.keys(after) as (keyof View)[]).some((k) => after[k] !== before[k]);
    if (changed) this.apply();
    return moving || changed;
  }

  private take() {
    this.omega = INPUT_OMEGA;
    this.dispatchEvent({ type: 'start' });
  }

  private lens() {
    return { fov: this.camera.fov, aspect: this.camera.aspect };
  }

  /** Held keys move the goal; the follow then smooths them. */
  private keys(dt: number) {
    const h = (a: CameraAction) => (this.held.has(a) ? 1 : 0);
    const [forward, right] = [h('panForward') - h('panBack'), h('panRight') - h('panLeft')];
    let goal = this.goal;
    if (forward || right) {
      const step = KEY_PAN * goal.distance * dt;
      goal = panBy(goal, forward * step, right * step, this.limits);
    }
    const turn = h('rotateRight') - h('rotateLeft');
    if (turn) goal = orbitBy(goal, turn * KEY_TURN * dt, 0, this.limits);
    const zoom = h('zoomOut') - h('zoomIn');
    if (zoom) goal = zoomToward(goal, { x: 0, y: 0 }, Math.exp(zoom * KEY_ZOOM * dt), this.lens(), this.limits);
    this.goal = goal;
  }

  private apply() {
    const v = this.view();
    const o = offsetOf(v);
    this.target.set(v.x, this.height, v.z);
    this.camera.position.set(v.x + o.x, this.height + o.y, v.z + o.z);
    this.camera.lookAt(this.target);
  }
}

/**
 * `span` widens the view for a city bigger than the style frame's map; `centre` is the point it looks at; `bounds` is
 * the ground that point may roam over, the style frame's map by default. Left-drag turns, right-drag or Shift-drag moves,
 * the wheel zooms toward the pointer, and the keys in `camera-keys.ts` do the same from the keyboard.
 */
export function createCamera(
  dom: HTMLElement,
  span = 1,
  centre = new THREE.Vector3(0.4, 0, 0.8),
  bounds: Bounds = cityBounds(FRAME_TILES),
) {
  const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 200);
  const offset = new THREE.Vector3(11.1 * span, 9.6 * span, 12.2 * span);
  camera.position.copy(offset).add(centre);
  const limits: Limits = {
    minDistance: 8,
    maxDistance: 40 * span,
    minPolar: 0.5,
    maxPolar: 1.15,
    bounds,
  };
  const controls = new CameraRig(camera, limits, viewFromOffset(centre.x, centre.z, offset), centre.y);
  bindInput(controls, dom);
  return { camera, controls };
}

/** How long the opening drift from above takes. */
const INTRO_MS = 2000;

/**
 * Start the camera high and pulled back and let it settle onto the framing it has now, ending early when the person
 * takes the controls. Call `step` every frame with the time; it returns false once the drift is over.
 */
export function startIntro(
  camera: THREE.PerspectiveCamera,
  controls: CameraRig,
  now: number,
): { step(now: number): boolean } {
  const target = controls.target.clone();
  const final = camera.position.clone().sub(target);
  const start = new THREE.Vector3(final.x * 1.5, final.y * 2.4, final.z * 1.5);
  let over = false;
  controls.addEventListener('start', () => (over = true));
  const place = (e: number) => {
    const offset = start.clone().lerp(final, e);
    controls.place(viewFromOffset(target.x, target.z, offset));
  };
  place(0);
  return {
    step(t) {
      if (over) return false;
      const p = Math.min(1, (t - now) / INTRO_MS);
      place(1 - (1 - p) ** 3);
      return p < 1;
    },
  };
}
