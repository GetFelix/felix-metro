// The cars and walkers of a live city, drawn as instances: one call for every car of a kind's mesh, one for every
// walker of a model's mesh, and one for each kind of car light, however many are on the road.
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { cloneModel } from './models';
import type { Fleet } from './traffic';
import { Batch, glowGeometry, glowMaterial } from './instanced';
import { bakeWalk, walkMaterial, walkPhase, type WalkClock } from './walk';

/** A car's lights, in the car's own space (2.5 long, +Z forward) and the sizes they are drawn at. */
const HEADLIGHTS = [-0.45, 0.45].map((x) => ({ at: new THREE.Vector3(x, 0.55, 1.35), size: 0.9 }));
const TAILLIGHTS = [-0.45, 0.45].map((x) => ({ at: new THREE.Vector3(x, 0.6, -1.35), size: 0.7 }));
/** Tiles of room round what is placed that still counts as in view: a car's shadow, and the frame the camera lags. */
const CULL_MARGIN = 1.5;
/** How far above the ground a car's and a walker's middle is, and how far from it they still count as hit (model units). */
const CAR_LIFT = 0.3;
const CAR_REACH = 1.3;
const PERSON_LIFT = 0.6;
const PERSON_REACH = 0.7;
const BEAM_SIZE: [number, number] = [2.2, 3.4];
const BEAM_AT = new THREE.Matrix4()
  .makeTranslation(0, 0.05, 3.0)
  .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

export interface FleetParts {
  /** One model per kind of car; vehicle kind `k` is `cars[(k - 1) % cars.length]`. */
  cars: GLTF[];
  /** One model per look; resident `r` is `people[r % people.length]`. */
  people: GLTF[];
  carScale: number;
  personScale: number;
  /** The material a car's mesh is drawn with, from the one it was made with. */
  carMaterial(src: THREE.MeshStandardMaterial): THREE.Material;
  personMaterial(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial;
  headMap: THREE.Texture;
  tailMap: THREE.Texture;
  /** The pool of light a car's headlights throw on the road. */
  beam: THREE.Material;
}

interface Part {
  batch: Batch;
  /** The mesh's place in its model. */
  local: THREE.Matrix4;
}

/** A car or walker found under the pointer, by the resident it belongs to. */
export interface Picked {
  resident: number;
  car: boolean;
}

/** A mover placed in the last round, kept so the pointer can be matched to a resident, not to an instance slot. */
interface Mover {
  resident: number;
  car: boolean;
  x: number;
  y: number;
  z: number;
  /** Tiles from its centre that still count as on it. */
  reach: number;
}

export interface InstancedFleet {
  fleet: Fleet;
  /**
   * The nearest car or walker placed in the last round to the point (`x`, `y`) in normalised device coordinates, or
   * null when none is within `slack` pixels of it or of its own size. Only what was placed can be found, which is
   * what the camera sees.
   */
  pick(
    camera: THREE.PerspectiveCamera,
    x: number,
    y: number,
    size: { width: number; height: number },
    slack: number,
  ): Picked | null;
  /** What the depth and occlusion passes leave out: the lights, which are additive, and the walkers. */
  glows: THREE.Object3D[];
  /** Set how bright the lights are, each 0 to 1. */
  setLights(head: number, tail: number, beam: number): void;
  /** How many cars, walkers and lights were placed by the last round. */
  counts(): { cars: number; people: number; lights: number };
}

/** The meshes of a model, each with where it sits in the model. */
export function parts(model: GLTF): { mesh: THREE.Mesh; local: THREE.Matrix4 }[] {
  const root = model.scene;
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const found: { mesh: THREE.Mesh; local: THREE.Matrix4 }[] = [];
  root.traverse((n) => {
    if ((n as THREE.Mesh).isMesh) found.push({ mesh: n as THREE.Mesh, local: inverse.clone().multiply(n.matrixWorld) });
  });
  return found;
}

export function createFleet(scene: THREE.Scene, p: FleetParts): InstancedFleet {
  const batches: Batch[] = [];
  const own = (batch: Batch) => {
    batches.push(batch);
    scene.add(batch.mesh);
    return batch;
  };

  const cars: Part[][] = p.cars.map((model) =>
    parts(model).map(({ mesh, local }) => {
      const batch = own(new Batch(mesh.geometry, p.carMaterial(mesh.material as THREE.MeshStandardMaterial)));
      batch.mesh.castShadow = true;
      return { batch, local };
    }),
  );

  const clock: WalkClock = { value: 0 };
  const walks = p.people.map((model) => model.animations.find((a) => a.name === 'walk')!);
  const people: Batch[][] = p.people.map((model, i) => {
    return bakeWalk(cloneModel(model), walks[i]!).map(({ mesh, bake }) => {
      const geometry = mesh.geometry.clone();
      geometry.deleteAttribute('skinIndex');
      geometry.deleteAttribute('skinWeight');
      geometry.setAttribute(
        'vertexId',
        new THREE.BufferAttribute(
          Float32Array.from({ length: bake.vertices }, (_, v) => v),
          1,
        ),
      );
      const { material } = walkMaterial(p.personMaterial(mesh.material as THREE.MeshStandardMaterial), bake, clock);
      // A walker is a few pixels; its shadow would cost a draw for no visible gain.
      return own(new Batch(geometry, material, { name: 'phase', size: 1 }));
    });
  });

  const headLights = own(new Batch(glowGeometry(), glowMaterial(p.headMap)));
  const tailLights = own(new Batch(glowGeometry(), glowMaterial(p.tailMap)));
  const beams = own(new Batch(new THREE.PlaneGeometry(...BEAM_SIZE), p.beam));
  // Walkers join the lights: their bones are baked into a texture only their own material reads, so the depth and
  // occlusion passes, which draw everything with one material, would see them in the bind pose.
  const glows: THREE.Object3D[] = [headLights.mesh, tailLights.mesh, beams.mesh, ...people.flat().map((b) => b.mesh)];

  const frustum = new THREE.Frustum();
  const view = new THREE.Matrix4();
  const around = new THREE.Sphere(new THREE.Vector3(), CULL_MARGIN);
  let culling = false;
  const inView = (x: number, y: number, z: number) => {
    if (!culling) return true;
    around.center.set(x, y, z);
    return frustum.intersectsSphere(around);
  };

  const movers: Mover[] = [];
  let moversUsed = 0;
  const remember = (resident: number, car: boolean, x: number, y: number, z: number, reach: number) => {
    const m = (movers[moversUsed++] ??= { resident: 0, car: false, x: 0, y: 0, z: 0, reach: 0 });
    m.resident = resident;
    m.car = car;
    m.x = x;
    m.y = y;
    m.z = z;
    m.reach = reach;
  };
  const seen = new THREE.Vector3();

  const car = new THREE.Matrix4();
  const placed = new THREE.Matrix4();
  const point = new THREE.Vector3();
  // The walk clips share one length, so one clock serves every walker.
  const cycle = walks[0]?.duration ?? 1;
  let walked = 0;

  /** The car-to-world matrix: turned about Y by `heading`, `scale` big, at (x, y, z). */
  function pose(m: THREE.Matrix4, x: number, y: number, z: number, heading: number, scale: number) {
    const c = Math.cos(heading) * scale;
    const s = Math.sin(heading) * scale;
    return m.set(c, 0, s, x, 0, scale, 0, y, -s, 0, c, z, 0, 0, 0, 1);
  }

  function lights(batch: Batch, list: typeof HEADLIGHTS, scale: number) {
    for (const { at, size } of list) {
      point.copy(at).applyMatrix4(car);
      const w = size * scale;
      placed.set(w, 0, 0, point.x, 0, w, 0, point.y, 0, 0, w, point.z, 0, 0, 0, 1);
      placed.toArray(batch.matrices, batch.next() * 16);
    }
  }

  const fleet: Fleet = {
    view(camera) {
      culling = camera !== null;
      if (!camera) return;
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    },
    begin(dt) {
      moversUsed = 0;
      for (const b of batches) b.clear();
      walked = (walked + dt / cycle) % 1;
      clock.value = walked;
    },
    car(kind, x, y, z, heading, size, resident = -1) {
      if (size <= 0 || !inView(x, y, z)) return;
      if (resident >= 0)
        remember(resident, true, x, y + CAR_LIFT * p.carScale * size, z, p.carScale * size * CAR_REACH);
      // The sim's kinds are 1 to 6, fewer than the models, so none of them reaches the page's own truck.
      const set = cars[(kind - 1) % cars.length]!;
      const scale = p.carScale * size;
      pose(car, x, y, z, heading, scale);
      for (const { batch, local } of set) {
        placed.multiplyMatrices(car, local).toArray(batch.matrices, batch.next() * 16);
      }
      lights(headLights, HEADLIGHTS, scale);
      lights(tailLights, TAILLIGHTS, scale);
      placed.multiplyMatrices(car, BEAM_AT).toArray(beams.matrices, beams.next() * 16);
    },
    person(resident, x, y, z, heading, size) {
      if (size <= 0 || !inView(x, y, z)) return;
      const set = people[resident % people.length]!;
      remember(resident, false, x, y + PERSON_LIFT * p.personScale * size, z, p.personScale * size * PERSON_REACH);
      pose(car, x, y, z, heading, p.personScale * size);
      const phase = walkPhase(resident);
      for (const batch of set) {
        const at = batch.next();
        car.toArray(batch.matrices, at * 16);
        batch.values[at] = phase;
      }
    },
    end() {
      for (const b of batches) b.finish();
    },
  };

  return {
    fleet,
    glows,
    pick(camera, x, y, size, slack) {
      camera.updateMatrixWorld();
      const k = 1 / Math.tan((camera.fov * Math.PI) / 360);
      const half = size.height / 2;
      let best: Mover | null = null;
      let nearest = Infinity;
      for (let i = 0; i < moversUsed; i++) {
        const m = movers[i]!;
        seen.set(m.x, m.y, m.z).applyMatrix4(camera.matrixWorldInverse);
        const depth = -seen.z;
        if (depth <= camera.near) continue;
        const dx = (((seen.x * k) / (depth * camera.aspect) - x) * size.width) / 2;
        const dy = ((seen.y * k) / depth - y) * half;
        const away = Math.hypot(dx, dy);
        if (away <= Math.max(slack, (m.reach * k * half) / depth) && away < nearest) {
          nearest = away;
          best = m;
        }
      }
      return best && { resident: best.resident, car: best.car };
    },
    setLights(head, tail, beam) {
      (headLights.mesh.material as THREE.ShaderMaterial).uniforms.opacity!.value = head;
      (tailLights.mesh.material as THREE.ShaderMaterial).uniforms.opacity!.value = tail;
      p.beam.opacity = beam;
    },
    counts() {
      const sum = (sets: Batch[][]) => sets.reduce((n, set) => n + (set[0]?.count ?? 0), 0);
      return {
        cars: sum(cars.map((set) => set.map((part) => part.batch))),
        people: sum(people),
        lights: headLights.count + tailLights.count,
      };
    },
  };
}
