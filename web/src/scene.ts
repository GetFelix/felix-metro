import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BULB_OFF, CYAN, FOG, GROUND_NIGHT, HEMI, PALETTE, SIGN_EMISSIVE, SKY, SUN_WHITE, TOWER } from './palette';
import type { Pack } from './assets';
import { cloneModel, facing as facingOf, fitToLot, loadModel } from './models';
import { createMaterials } from './materials';
import type { Tier } from './params';

// Seeded so the frame is identical on every load.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;

const smooth = (t: number) => t * t * (3 - 2 * t);

function sky(hour: number) {
  let i = 0;
  while (i < SKY.length - 2 && hour >= SKY[i + 1]![0]) i++;
  const a = SKY[i]!;
  const b = SKY[i + 1]!;
  const t = smooth(THREE.MathUtils.clamp((hour - a[0]) / (b[0] - a[0]), 0, 1));
  const mix = (k: 1 | 2 | 4 | 5) => a[k].clone().lerp(b[k], t);
  const num = (k: 3 | 6 | 7) => a[k] + (b[k] - a[k]) * t;
  return { sky: mix(1), sun: mix(2), sunI: num(3), hs: mix(4), hg: mix(5), hI: num(6), exp: num(7) };
}

// How dark it is, 0 at noon to 1 at night; drives windows, lamps and headlights.
const night = (h: number) => {
  const d = Math.min(Math.abs(h - 13), 24 - Math.abs(h - 13)); // hours from 13:00
  return smooth(THREE.MathUtils.clamp((d - 4.8) / 2.0, 0, 1));
};

// Light pools are additive ground decals instead of real lights, so fifty lamps cost almost nothing.
function radial(color: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Mover {
  o: THREE.Object3D;
  axis: 'x' | 'z';
  line: number;
  dir: number;
  s: number;
  speed: number;
}
interface Walker extends Mover {
  mixer: THREE.AnimationMixer;
}

const EXTENT = 11;
export function move(list: Mover[], dt: number, carLike: boolean) {
  for (const a of list) {
    a.s += a.dir * a.speed * dt;
    if (a.s > EXTENT) a.s -= 2 * EXTENT;
    if (a.s < -EXTENT) a.s += 2 * EXTENT;
    if (a.axis === 'x') {
      a.o.position.set(a.s, 0, a.line);
      a.o.rotation.y = a.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      a.o.position.set(a.line, 0, a.s);
      a.o.rotation.y = a.dir > 0 ? 0 : Math.PI;
    }
    if (carLike) a.o.position.y = 0.036;
    // Fade out at the edge of the map instead of popping.
    a.o.visible = Math.abs(a.s) < EXTENT - 0.5;
  }
}

// Roads every fourth tile; the three tiles between are a block of lots.
const ROADS = [-8, -4, 0, 4, 8];
const isRoad = (v: number) => ROADS.includes(v);
// Blocks are indexed so the tiles between two roads share one index. The camera looks from +x +z, so block (1, 1) is
// the foreground and (-2, -2) the back.
const blockOf = (v: number) => Math.floor(v / 4);
const district = (bx: number, bz: number) => {
  if (bx === 1 && bz === 1) return 'park';
  if ((bx === -1 || bx === 0) && (bz === -1 || bz === 0)) return 'downtown';
  if ((bz === -2 && bx >= 0) || (bx === 1 && bz === -1)) return 'industrial';
  if (bx === -2 || (bx === -1 && bz === 1)) return 'suburban';
  return 'commercial';
};

const COMMERCIAL = 'abcdefghijklmn'.split('').map((c) => `building-${c}`);
const SKYSCRAPERS = 'abcde'.split('').map((c) => `building-skyscraper-${c}`);
const HOUSES = 'abcdefghij'.split('').map((c) => `building-type-${c}`);
const INDUSTRIAL = 'abcdef'.split('').map((c) => `building-${c}`);
const CARS = [
  'sedan',
  'taxi',
  'suv',
  'van',
  'hatchback-sports',
  'sedan',
  'taxi',
  'delivery',
  'police',
  'truck',
  'garbage-truck',
  'ambulance',
];
const CAR_SCALE = 0.12;
const PEOPLE = 'abcdef'.split('').flatMap((c) => [`character-female-${c}`, `character-male-${c}`]);

export async function createCity(renderer: THREE.WebGLRenderer, tier: Tier) {
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const fog = new THREE.Fog(FOG, 30, 70);
  scene.fog = fog;

  const hemi = new THREE.HemisphereLight(HEMI.sky, HEMI.ground, 0.8);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(SUN_WHITE, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(tier === 'high' ? 4096 : 2048, tier === 'high' ? 4096 : 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 80 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  // Ground: grass under the city, darker toward the fog.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(60, 64),
    new THREE.MeshStandardMaterial({ color: PALETTE.grass, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- assets ----------
  const materials = createMaterials();
  const facing = (x: number, z: number) => facingOf(x, z, isRoad, pick);

  function meshes(o: THREE.Object3D, apply: (m: THREE.Mesh) => void) {
    o.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) apply(n as THREE.Mesh);
    });
  }

  async function place(pack: Pack, name: string, x: number, z: number, rotY = 0, scale = 1, lit = 0, v = -1) {
    const o = cloneModel(await loadModel(pack, name));
    meshes(o, (n) => {
      n.material = materials.materialFor(pack, n.material as THREE.MeshStandardMaterial, lit, v);
      n.castShadow = true;
      n.receiveShadow = true;
    });
    o.position.set(x, 0, z);
    o.rotation.y = rotY;
    o.scale.setScalar(scale);
    fitToLot(pack, o);
    scene.add(o);
    return o;
  }

  // ---------- layout ----------
  const lamps: THREE.Object3D[] = [];
  const jobs: Promise<unknown>[] = [];
  const N = 9;
  for (let x = -N; x <= N; x++) {
    for (let z = -N; z <= N; z++) {
      const rx = isRoad(x),
        rz = isRoad(z);
      const dist = Math.hypot(x, z);
      if (dist > 12.5 || Math.abs(x) > 8 || Math.abs(z) > 8) continue;
      if (rx && rz) {
        jobs.push(place('roads', 'road-crossroad-path', x, z));
        continue;
      }
      if (rx || rz) {
        // road-straight runs along X as modelled.
        jobs.push(place('roads', 'road-straight', x, z, rx ? Math.PI / 2 : 0));
        // A lamp on every other road tile, on alternating sides. The model's arm points along -Z, so each lamp turns
        // its arm toward the road's centre.
        if ((x + z) % 2 === 0 && dist < 11.5) {
          const side = (rx ? z : x) % 4 === 2 ? 1 : -1;
          const lx = rx ? x + 0.44 * side : x,
            lz = rz ? z + 0.44 * side : z;
          jobs.push(
            place(
              'roads',
              'light-square',
              lx,
              lz,
              rx ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : side > 0 ? 0 : Math.PI,
            ).then((o) => lamps.push(o)),
          );
        }
        continue;
      }
      const kind = district(blockOf(x), blockOf(z));
      // Window light levels; towers stay dimmer because their glass is one big swatch.
      const lit = rand() < 0.75 ? pick([0.6, 1, 1.4]) : 0;
      const center = !isRoad(x + 1) && !isRoad(x - 1) && !isRoad(z + 1) && !isRoad(z - 1);
      if (kind === 'downtown') {
        jobs.push(place('roads', 'tile-low', x, z));
        if (x === -2 && z === 2) continue; // the Felix tower
        if (center || rand() < 0.3)
          jobs.push(
            place('commercial', pick(SKYSCRAPERS), x, z, facing(x, z), 0.7, lit ? 0.3 : 0, Math.floor(rand() * 6)),
          );
        else jobs.push(place('commercial', pick(COMMERCIAL), x, z, facing(x, z), 1, lit, Math.floor(rand() * 6)));
      } else if (kind === 'commercial') {
        jobs.push(place('roads', 'tile-low', x, z));
        if (center) {
          jobs.push(place('commercial', 'detail-parasol-a', x - 0.2, z + 0.1, 0, 1));
          jobs.push(place('suburban', 'tree-large', x + 0.25, z - 0.2, rand() * 6, 1.1));
        } else jobs.push(place('commercial', pick(COMMERCIAL), x, z, facing(x, z), 1, lit, Math.floor(rand() * 6)));
      } else if (kind === 'suburban') {
        if (center) {
          jobs.push(place('suburban', 'tree-large', x - 0.2, z - 0.15, rand() * 6, 1.2));
          jobs.push(place('suburban', 'tree-small', x + 0.25, z + 0.2, rand() * 6, 1.2));
        } else {
          jobs.push(place('suburban', pick(HOUSES), x, z, facing(x, z), 0.62, lit ? 1 : 0, Math.floor(rand() * 5)));
          if (rand() < 0.6)
            jobs.push(
              place(
                'suburban',
                pick(['tree-small', 'tree-large']),
                x + (rand() - 0.5) * 0.7,
                z + (rand() - 0.5) * 0.7,
                rand() * 6,
                0.9,
              ),
            );
        }
      } else if (kind === 'industrial') {
        jobs.push(place('roads', 'tile-low', x, z));
        if (center)
          jobs.push(
            place('industrial', pick(['water-tower', 'chimney-large', 'detail-tank-large']), x, z, rand() * 6, 0.55),
          );
        else if (rand() < 0.2) {
          jobs.push(
            place(
              'industrial',
              pick(['shipping-container-a', 'shipping-container-b', 'shipping-container-c']),
              x - 0.15,
              z,
              facing(x, z),
              0.5,
            ),
          );
          jobs.push(
            place(
              'industrial',
              pick(['shipping-container-a', 'shipping-container-c']),
              x + 0.2,
              z + 0.1,
              facing(x, z),
              0.5,
            ),
          );
        } else
          jobs.push(
            place('industrial', pick(INDUSTRIAL), x, z, facing(x, z), 0.46, lit ? 1 : 0, 2 + Math.floor(rand() * 3)),
          );
      } else {
        // Park: trees and a pond.
        for (let k = 0; k < 3; k++)
          jobs.push(
            place(
              'suburban',
              pick(['tree-large', 'tree-small']),
              x + (rand() - 0.5) * 0.8,
              z + (rand() - 0.5) * 0.8,
              rand() * 6,
              1 + rand() * 0.4,
            ),
          );
      }
    }
  }
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 40),
    new THREE.MeshStandardMaterial({ color: PALETTE.water, roughness: 0.15, metalness: 0.1 }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(6, 0.005, 6);
  pond.receiveShadow = true;
  scene.add(pond);

  // Scattered trees outside the grid so the city sits in a landscape.
  for (let k = 0; k < 140; k++) {
    const a = rand() * Math.PI * 2,
      r = 12.8 + rand() * 9;
    jobs.push(
      place(
        'suburban',
        pick(['tree-large', 'tree-small']),
        Math.cos(a) * r,
        Math.sin(a) * r,
        rand() * 6,
        1 + rand() * 0.6,
      ),
    );
  }

  // ---------- lights that come on at night ----------
  const poolMat = new THREE.MeshBasicMaterial({
    map: radial('rgba(255,196,107,1)'),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0,
  });
  const bulbMat = new THREE.MeshBasicMaterial({ color: PALETTE.lamp });
  // Additive glows: hidden while ambient occlusion reads the scene, or they shade it like solid quads.
  const glows: THREE.Object3D[] = [];
  const glowMat = new THREE.SpriteMaterial({
    map: radial('rgba(255,210,140,1)'),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0,
  });

  // ---------- traffic ----------
  const cars: Mover[] = [];
  const headMat = new THREE.SpriteMaterial({
    map: radial('rgba(255,241,208,1)'),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0,
  });
  const tailMat = new THREE.SpriteMaterial({
    map: radial('rgba(255,59,42,1)'),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0,
  });
  const beamMat = new THREE.MeshBasicMaterial({
    map: radial('rgba(255,236,190,0.9)'),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0,
  });

  async function addCar(axis: 'x' | 'z', line: number, dir: number, offset: number, speed: number) {
    const name = pick(CARS);
    const o = cloneModel(await loadModel('cars', name));
    meshes(o, (n) => {
      n.material = materials.materialFor('cars', n.material as THREE.MeshStandardMaterial, 0);
      n.castShadow = true;
    });
    o.scale.setScalar(CAR_SCALE);
    // Lights are children in model space (the car is 2.5 long, +Z forward).
    for (const sx of [-0.45, 0.45]) {
      const h = new THREE.Sprite(headMat);
      h.position.set(sx, 0.55, 1.35);
      h.scale.setScalar(0.9);
      o.add(h);
      const t = new THREE.Sprite(tailMat);
      t.position.set(sx, 0.6, -1.35);
      t.scale.setScalar(0.7);
      o.add(t);
    }
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3.4), beamMat);
    beam.rotation.x = -Math.PI / 2;
    beam.position.set(0, 0.05, 3.0);
    o.add(beam);
    o.children.filter((c) => (c as THREE.Sprite).isSprite || c === beam).forEach((c) => glows.push(c));
    scene.add(o);
    cars.push({ o, axis, line, dir, s: offset, speed });
  }
  // Right-hand traffic: lanes 0.17 from the centre line.
  for (const r of ROADS.slice(1, 4)) {
    for (const dir of [1, -1]) {
      for (let k = 0; k < 3; k++) {
        jobs.push(addCar('x', r - 0.17 * dir, dir, rand() * 24 - 12, 0.9 + rand() * 0.5));
        jobs.push(addCar('z', r + 0.17 * dir, dir, rand() * 24 - 12, 0.9 + rand() * 0.5));
      }
    }
  }

  // ---------- pedestrians ----------
  const people: Walker[] = [];
  async function addPerson(axis: 'x' | 'z', line: number, dir: number, offset: number) {
    // Drawn before the load so the pose and speed don't depend on which model arrives first.
    const name = pick(PEOPLE);
    const phase = rand() * 2;
    const speed = 0.22 + rand() * 0.08;
    const gltf = await loadModel('mini-characters', name);
    const o = cloneModel(gltf);
    meshes(o, (n) => {
      n.material = materials.materialFor('mini-characters', n.material as THREE.MeshStandardMaterial, 0);
      n.castShadow = true;
    });
    o.scale.setScalar(0.17);
    const mixer = new THREE.AnimationMixer(o);
    const walk = gltf.animations.find((a) => a.name === 'walk')!;
    mixer.clipAction(walk).play();
    mixer.setTime(phase);
    scene.add(o);
    people.push({ o, mixer, axis, line, dir, s: offset, speed });
  }
  for (const r of ROADS.slice(1, 4)) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        jobs.push(addPerson('x', r + 0.4 * side, pick([1, -1]), rand() * 20 - 10));
        jobs.push(addPerson('z', r + 0.4 * side, pick([1, -1]), rand() * 20 - 10));
      }
    }
  }

  // The Felix tower: the tallest building downtown, a cyan crown and the cat on its roof.
  const tower = await place('commercial', 'building-skyscraper-e', -2, 2, 0, 1, 0.3, 4);
  const towerBox = new THREE.Box3().setFromObject(tower);
  const towerSize = towerBox.getSize(new THREE.Vector3());
  const top = towerBox.max.y;
  const crownMat = new THREE.MeshStandardMaterial({
    color: TOWER.crown,
    emissive: CYAN,
    emissiveIntensity: 1.2,
    roughness: 0.4,
  });
  const crown = new THREE.Mesh(new THREE.BoxGeometry(towerSize.x + 0.02, 0.07, towerSize.z + 0.02), crownMat);
  crown.position.set(-2, top - 0.05, 2);
  const logoTex = await new THREE.TextureLoader().loadAsync('brand/felix-metro-mark.png');
  logoTex.colorSpace = THREE.SRGBColorSpace;
  logoTex.anisotropy = 8;
  const signMat = new THREE.MeshStandardMaterial({
    map: logoTex,
    emissiveMap: logoTex,
    emissive: SIGN_EMISSIVE,
    emissiveIntensity: 0.15,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 0.6,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), signMat);
  sign.position.set(-2, top + 0.48, 2);
  sign.rotation.y = Math.PI / 4;
  sign.castShadow = true;
  const mast = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.12, 0.05),
    new THREE.MeshStandardMaterial({ color: TOWER.mast }),
  );
  mast.position.set(-2, top + 0.06, 2);
  scene.add(crown, sign, mast);

  await Promise.all(jobs);

  // Bulbs, glows and pools hang off the lamp models' arms.
  for (const lamp of lamps) {
    const arm = new THREE.Vector3(0, 0.58, -0.17).applyEuler(lamp.rotation).add(lamp.position);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), bulbMat);
    bulb.position.copy(arm);
    const glow = new THREE.Sprite(glowMat);
    glow.position.copy(arm);
    glow.scale.setScalar(0.45);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(arm.x, 0.03, arm.z);
    scene.add(bulb, glow, pool);
    glows.push(glow, pool);
  }

  // ---------- time of day ----------
  function setTime(hour: number, bloom: UnrealBloomPass) {
    const s = sky(hour);
    scene.background = s.sky;
    fog.color.copy(s.sky);
    // The sun travels east to west; at night the same light is the moon, high and cool.
    const n = night(hour);
    const dayAngle = ((hour - 6) / 12) * Math.PI;
    const elev = n > 0.85 ? 0.9 : Math.max(0.12, Math.sin(dayAngle));
    const az = n > 0.85 ? 2.2 : dayAngle;
    // West is +x, so the evening sun comes from the camera's side and lights the faces in view.
    sun.position.set(-Math.cos(az) * 20, elev * 22 + 3, 6 + Math.sin(az) * 3);
    sun.color.copy(s.sun);
    sun.intensity = s.sunI;
    hemi.color.copy(s.hs);
    hemi.groundColor.copy(s.hg);
    hemi.intensity = s.hI;
    renderer.toneMappingExposure = s.exp;
    scene.environmentIntensity = 0.06 + 0.5 * (1 - n);
    (ground.material as THREE.MeshStandardMaterial).color
      .set(PALETTE.grass)
      .lerp(new THREE.Color(GROUND_NIGHT), n * 0.6);
    for (const m of materials.lit()) m.emissiveIntensity = n * 0.85 * m.userData.lit;
    const lampOn = smooth(THREE.MathUtils.clamp((n - 0.25) / 0.4, 0, 1));
    poolMat.opacity = lampOn * 0.55;
    glowMat.opacity = lampOn * 0.9;
    bulbMat.color.set(lampOn > 0.05 ? PALETTE.lamp : BULB_OFF);
    headMat.opacity = lampOn;
    tailMat.opacity = lampOn * 0.8;
    beamMat.opacity = lampOn * 0.35;
    bloom.strength = 0.1 + n * 0.35;
    crownMat.emissiveIntensity = 0.5 + n * 2.5;
    signMat.emissiveIntensity = 0.12 + n * 0.3;
    const hh = Math.floor(hour) % 24,
      mm = Math.floor((hour % 1) * 60);
    document.getElementById('clock')!.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    document.getElementById('track')!.style.setProperty('--p', `${(hour / 24) * 100}%`);
  }

  return { scene, cars, people, glows, setTime };
}
