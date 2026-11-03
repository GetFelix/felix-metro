// The bulb, glow and pool of light at the arm of every street lamp, as three pools of instances. A lamp switches on at
// its own hour, so each instance carries its own brightness: the bulb's colour, and the glow's and pool's alpha.
import * as THREE from 'three';
import { BULB_OFF, PALETTE } from './palette';
import { InstancePool, type Instance } from './instance-pool';
import { tintMaterial } from './instanced';
import type { daylight } from './daylight';

/** The instances of one lamp. */
export interface LampLight {
  readonly id: number;
  readonly bulb: Instance;
  readonly glow: Instance;
  readonly pool: Instance;
}

const bulbOff = new THREE.Color(BULB_OFF);
const lampColor = new THREE.Color(PALETTE.lamp);
const color = new THREE.Color();
const matrix = new THREE.Matrix4();
const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

export class LampLights {
  private readonly bulbs: InstancePool;
  private readonly glows: InstancePool;
  private readonly pools: InstancePool;

  /** The glow and the pool are additive and are left in `hidden`, which the ambient occlusion pass hides. */
  constructor(scene: THREE.Scene, hidden: THREE.Object3D[], maps: { glow: THREE.Texture; pool: THREE.Texture }) {
    this.bulbs = new InstancePool(
      new THREE.SphereGeometry(0.025, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      [{ name: 'instanceColor', size: 3 }],
    );
    const alpha = [{ name: 'alpha', size: 1 }];
    this.glows = new InstancePool(
      new THREE.PlaneGeometry(1, 1),
      tintMaterial(maps.glow, { billboard: true, additive: true }),
      alpha,
    );
    this.pools = new InstancePool(
      new THREE.PlaneGeometry(1, 1),
      tintMaterial(maps.pool, { billboard: false, additive: true }),
      alpha,
    );
    scene.add(this.bulbs.mesh, this.glows.mesh, this.pools.mesh);
    hidden.push(this.glows.mesh, this.pools.mesh);
  }

  /** Hang a lamp's lights with the bulb at `arm`, switched off. */
  add(id: number, arm: THREE.Vector3): LampLight {
    const bulb = this.bulbs.add(matrix.makeTranslation(arm.x, arm.y, arm.z));
    const glow = this.glows.add(matrix.makeScale(0.45, 0.45, 1).setPosition(arm.x, arm.y, arm.z));
    const pool = this.pools.add(
      matrix.compose(new THREE.Vector3(arm.x, 0.03, arm.z), flat, new THREE.Vector3(1.5, 1.5, 1)),
    );
    const light = { id, bulb, glow, pool };
    this.set(light, 0, 0, 0);
    return light;
  }

  remove(light: LampLight): void {
    this.bulbs.remove(light.bulb);
    this.glows.remove(light.glow);
    this.pools.remove(light.pool);
  }

  /** Switch a lamp: `on` is 0 to 1, and the openings are how bright its glow and pool are at the hour. */
  set(light: LampLight, on: number, glowOpacity: number, poolOpacity: number): void {
    color.copy(bulbOff).lerp(lampColor, on);
    this.bulbs.set(light.bulb, 'instanceColor', color.r, color.g, color.b);
    this.glows.set(light.glow, 'alpha', on * glowOpacity);
    this.pools.set(light.pool, 'alpha', on * poolOpacity);
  }

  setFromDay(light: LampLight, on: number, d: ReturnType<typeof daylight>): void {
    this.set(light, on, d.glowOpacity, d.poolOpacity);
  }
}
