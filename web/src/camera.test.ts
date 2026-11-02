import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraRig, startIntro } from './camera';
import { cityBounds, groundPoint, offsetOf, viewFromOffset, type Limits } from './camera-math';

const limits: Limits = { minDistance: 8, maxDistance: 80, minPolar: 0.5, maxPolar: 1.15, bounds: cityBounds(34) };
const offset = new THREE.Vector3(11.1, 9.6, 12.2);

function make() {
  const camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 200);
  camera.position.copy(offset);
  const rig = new CameraRig(camera, limits, viewFromOffset(0, 0, offset));
  return { camera, rig };
}

/** Run the rig for `seconds` of 60 fps frames. */
function run(rig: CameraRig, seconds: number, each: () => void = () => {}) {
  for (let i = 0; i < seconds * 60; i++) {
    rig.update(1 / 60);
    each();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('an idle camera', () => {
  it('does not touch the camera, so the opening view is the one it was given', () => {
    const { camera, rig } = make();
    const [position, quaternion] = [camera.position.clone(), camera.quaternion.clone()];
    run(rig, 2);
    expect(camera.position.equals(position)).toBe(true);
    expect(camera.quaternion.equals(quaternion)).toBe(true);
    expect(rig.update(1 / 60)).toBe(false);
  });
});

describe('moveTo', () => {
  it('eases to the goal without passing it', () => {
    const { rig } = make();
    rig.moveTo({ x: 6, z: -4 }, 12, 2.0, 0.7);
    const first = rig.view();
    rig.update(1 / 60);
    const second = rig.view();
    expect(second.distance).toBeLessThan(first.distance);
    expect(second.distance).toBeGreaterThan(12);
    let lowest = Infinity;
    run(rig, 3, () => (lowest = Math.min(lowest, rig.view().distance)));
    expect(lowest).toBeGreaterThanOrEqual(12);
    expect(rig.view()).toEqual({ x: 6, z: -4, distance: 12, azimuth: 2.0, polar: 0.7 });
  });

  it('takes about half a second', () => {
    const { rig } = make();
    rig.moveTo({ x: 10, z: 0 }, 20, rig.view().azimuth, rig.view().polar);
    run(rig, 0.6);
    expect(rig.view().x).toBeGreaterThan(9);
    expect(rig.view().x).toBeLessThan(10);
  });

  it('jumps when asked not to ease', () => {
    const { camera, rig } = make();
    rig.moveTo({ x: 6, z: -4 }, 12, 2.0, 0.7, { ease: false });
    expect(rig.view()).toEqual({ x: 6, z: -4, distance: 12, azimuth: 2.0, polar: 0.7 });
    expect(rig.target.x).toBe(6);
    const o = offsetOf(rig.view());
    expect(camera.position.x).toBeCloseTo(6 + o.x);
  });

  it('jumps for a person who asked for less motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { rig } = make();
    rig.moveTo({ x: 6, z: -4 }, 12, 2.0, 0.7);
    expect(rig.view().x).toBe(6);
    expect(rig.update(1 / 60)).toBe(false);
  });

  it('holds the goal inside the limits', () => {
    const { rig } = make();
    rig.moveTo({ x: 500, z: -500 }, 1, 0, 0, { ease: false });
    expect(rig.view()).toMatchObject({ x: 17, z: -17, distance: 8, polar: 0.5 });
  });

  it('turns the short way round', () => {
    const { rig } = make();
    rig.moveTo({ x: 0, z: 0 }, 20, 3.0, 1, { ease: false });
    rig.moveTo({ x: 0, z: 0 }, 20, -3.0, 1);
    run(rig, 0.05);
    expect(rig.view().azimuth).toBeGreaterThan(3.0);
  });
});

describe('state and setState', () => {
  it('survive JSON and put the camera back', () => {
    const { rig } = make();
    rig.moveTo({ x: 6.1234, z: -4 }, 12, 2.0, 0.7, { ease: false });
    const saved = JSON.parse(JSON.stringify(rig.state()));
    expect(saved).toEqual({ x: 6.123, z: -4, distance: 12, azimuth: 2, polar: 0.7 });
    rig.reset({ ease: false });
    expect(rig.setState(saved, { ease: false })).toBe(true);
    expect(rig.state()).toEqual(saved);
  });

  it('reports where the camera is heading, not where it is on the way', () => {
    const { rig } = make();
    rig.moveTo({ x: 6, z: 0 }, 12, 1, 0.7);
    rig.update(1 / 60);
    expect(rig.state()).toEqual({ x: 6, z: 0, distance: 12, azimuth: 1, polar: 0.7 });
  });

  it('turns an angle into the half turn either side of zero', () => {
    const { rig } = make();
    rig.moveTo({ x: 0, z: 0 }, 20, 7, 1, { ease: false });
    expect(rig.state().azimuth).toBeCloseTo(7 - 2 * Math.PI, 3);
  });

  it('refuses what is not a view and stays put', () => {
    const { rig } = make();
    const before = rig.state();
    for (const bad of [
      null,
      undefined,
      {},
      { x: 1 },
      { x: NaN, z: 0, distance: 10, azimuth: 0, polar: 1 },
      { x: '1', z: 0 },
    ]) {
      expect(rig.setState(bad as never)).toBe(false);
    }
    expect(rig.state()).toEqual(before);
  });
});

describe('reset', () => {
  it('comes back to the view the camera opened on', () => {
    const { camera, rig } = make();
    const start = camera.position.clone();
    rig.zoomAt({ x: 0.5, y: -0.5 }, 0.4);
    rig.orbit(1, 0.2);
    run(rig, 1);
    rig.reset();
    run(rig, 3);
    expect(camera.position.distanceTo(start)).toBeLessThan(1e-6);
    expect(rig.target.length()).toBeLessThan(1e-6);
  });
});

describe('the person taking over', () => {
  it('tells listeners, which is how the opening drift ends', () => {
    const { rig } = make();
    const seen = vi.fn();
    rig.addEventListener('start', seen);
    rig.orbit(0.1, 0);
    rig.zoomAt({ x: 0, y: 0 }, 0.9);
    rig.grab({ x: 0, y: 0 }, { x: 0.1, y: 0 });
    rig.hold('panForward', true);
    expect(seen).toHaveBeenCalledTimes(4);
  });

  it('keeps the ground under the cursor while a wheel zoom settles', () => {
    const { camera, rig } = make();
    const at = { x: 0.6, y: -0.5 };
    const ground = groundPoint(rig.view(), at, { fov: camera.fov, aspect: camera.aspect })!;
    rig.zoomAt(at, 0.4);
    run(rig, 2);
    camera.updateMatrixWorld();
    const seen = new THREE.Vector3(ground.x, 0, ground.z).project(camera);
    expect(seen.x).toBeCloseTo(at.x, 4);
    expect(seen.y).toBeCloseTo(at.y, 4);
  });

  it('cannot take the look-at point out of the city by any means', () => {
    const { rig } = make();
    const inside = () => Math.abs(rig.target.x) <= 17 + 1e-9 && Math.abs(rig.target.z) <= 17 + 1e-9;
    rig.hold('panForward', true);
    rig.hold('panRight', true);
    run(rig, 120, () => expect(inside()).toBe(true));
    rig.hold('panForward', false);
    rig.hold('panRight', false);
    rig.hold('panBack', true);
    rig.hold('panLeft', true);
    run(rig, 120, () => expect(inside()).toBe(true));
    for (let i = 0; i < 50; i++) {
      rig.grab({ x: 0, y: 0 }, { x: -1, y: 1 });
      rig.zoomAt({ x: 1, y: 1 }, i % 2 ? 0.8 : 1.2);
      run(rig, 0.1, () => expect(inside()).toBe(true));
    }
  });

  it('moves while a key is held and stops when it is let go', () => {
    const { rig } = make();
    rig.hold('panRight', true);
    run(rig, 1);
    const moved = rig.view().x;
    expect(moved).toBeGreaterThan(1);
    rig.hold('panRight', false);
    run(rig, 2);
    const settled = rig.view().x;
    run(rig, 1);
    expect(rig.view().x).toBe(settled);
    expect(settled).toBeGreaterThanOrEqual(moved);
  });

  it('rotates and zooms from the keys', () => {
    const { rig } = make();
    const start = rig.view();
    rig.hold('rotateRight', true);
    rig.hold('zoomIn', true);
    run(rig, 1);
    expect(rig.view().azimuth).toBeGreaterThan(start.azimuth);
    expect(rig.view().distance).toBeLessThan(start.distance);
  });

  it('does not move on keys while disabled', () => {
    const { rig } = make();
    rig.enabled = false;
    rig.hold('panRight', true);
    run(rig, 1);
    expect(rig.view().x).toBe(0);
  });
});

describe('the opening drift', () => {
  it('starts high and ends on the framing it had', () => {
    const { camera, rig } = make();
    const final = camera.position.clone();
    const intro = startIntro(camera, rig, 1000);
    expect(camera.position.y).toBeGreaterThan(final.y * 2);
    expect(intro.step(2000)).toBe(true);
    expect(intro.step(3000)).toBe(false);
    expect(camera.position.distanceTo(final)).toBeLessThan(1e-5);
  });

  it('ends when the app moves the camera, so a deep link is not drifted away from', () => {
    for (const move of [
      (rig: CameraRig) => rig.setState({ x: 5, z: -3, distance: 15, azimuth: 1, polar: 0.8 }, { ease: false }),
      (rig: CameraRig) => rig.moveTo({ x: 5, z: -3 }, 15, 1, 0.8, { ease: false }),
      (rig: CameraRig) => rig.reset({ ease: false }),
    ]) {
      const { camera, rig } = make();
      const intro = startIntro(camera, rig, 1000);
      intro.step(1200);
      move(rig);
      const placed = camera.position.clone();
      expect(intro.step(1400)).toBe(false);
      expect(camera.position.distanceTo(placed)).toBe(0);
    }
  });

  it('is not ended by its own placing', () => {
    const { camera, rig } = make();
    const intro = startIntro(camera, rig, 1000);
    expect(intro.step(1100)).toBe(true);
    expect(intro.step(1200)).toBe(true);
  });

  it('ends when the person takes the controls, and the camera goes on from where it was', () => {
    const { camera, rig } = make();
    const intro = startIntro(camera, rig, 1000);
    expect(intro.step(1500)).toBe(true);
    const mid = camera.position.clone();
    rig.zoomAt({ x: 0, y: 0 }, 0.9);
    expect(intro.step(1600)).toBe(false);
    rig.update(1 / 60);
    expect(camera.position.distanceTo(mid)).toBeLessThan(2);
  });
});
