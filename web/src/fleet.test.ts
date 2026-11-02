import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { createFleet, type FleetParts } from './fleet';
import { walkPhase } from './walk';
import { walker } from './walk-fixture';

const CAR_SCALE = 0.12;
const PERSON_SCALE = 0.22;

/** A car of a body and a wheel set off to one side, as a model file has them. */
function car(): GLTF {
  const scene = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 2.5), new THREE.MeshStandardMaterial());
  body.name = 'body';
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2), new THREE.MeshStandardMaterial());
  wheel.name = 'wheel';
  wheel.position.set(0.5, 0.2, 0.8);
  wheel.rotation.z = Math.PI / 2;
  scene.add(body, wheel);
  return { scene, animations: [] } as unknown as GLTF;
}

function make(kinds = 2) {
  const scene = new THREE.Scene();
  const parts: FleetParts = {
    cars: Array.from({ length: kinds }, car),
    people: [walker(), walker(), walker()],
    carScale: CAR_SCALE,
    personScale: PERSON_SCALE,
    carMaterial: (src) => src,
    personMaterial: (src) => src,
    headMap: new THREE.Texture(),
    tailMap: new THREE.Texture(),
    beam: new THREE.MeshBasicMaterial(),
  };
  const crowd = createFleet(scene, parts);
  return { scene, parts, crowd };
}

const matrixAt = (mesh: THREE.InstancedMesh, i: number) =>
  new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, i * 16);
const closeTo = (m: THREE.Matrix4) => Array.from(m.elements).map((n) => expect.closeTo(n, 5));

/** The mesh drawing the model's mesh `name` of car kind index `k`. */
const drawing = (scene: THREE.Scene, parts: FleetParts, k: number, name: string) => {
  const source = parts.cars[k]!.scene.getObjectByName(name) as THREE.Mesh;
  return scene.children.find((c) => (c as THREE.Mesh).geometry === source.geometry) as THREE.InstancedMesh;
};

/** What a car cloned from its model and moved as one object would put each part at: the drawing this replaces. */
function asObject(model: GLTF, x: number, y: number, z: number, heading: number, size: number) {
  const o = model.scene.clone(true);
  o.scale.setScalar(CAR_SCALE * size);
  o.position.set(x, y, z);
  o.rotation.y = heading;
  const lights: THREE.Object3D[] = [];
  for (const [sx, sy, sz, s] of [
    [-0.45, 0.55, 1.35, 0.9],
    [0.45, 0.55, 1.35, 0.9],
    [-0.45, 0.6, -1.35, 0.7],
    [0.45, 0.6, -1.35, 0.7],
  ] as const) {
    const light = new THREE.Object3D();
    light.position.set(sx, sy, sz);
    light.scale.setScalar(s);
    o.add(light);
    lights.push(light);
  }
  const beam = new THREE.Object3D();
  beam.rotation.x = -Math.PI / 2;
  beam.position.set(0, 0.05, 3.0);
  o.add(beam);
  o.updateMatrixWorld(true);
  return { o, lights, beam };
}

describe('the fleet’s cars', () => {
  it('put every mesh of a car where the car moved as one object would', () => {
    const { scene, parts, crowd } = make();
    crowd.fleet.begin(0);
    crowd.fleet.car(1, 3, 0.036, -2, 1.1, 1);
    crowd.fleet.end();
    const { o } = asObject(parts.cars[0]!, 3, 0.036, -2, 1.1, 1);
    for (const name of ['body', 'wheel']) {
      const expected = o.getObjectByName(name)!.matrixWorld;
      expect(Array.from(matrixAt(drawing(scene, parts, 0, name), 0).elements)).toEqual(closeTo(expected));
    }
  });

  it('shrink toward nothing as a car turns into its lot, lights and all', () => {
    const { scene, parts, crowd } = make();
    crowd.fleet.begin(0);
    crowd.fleet.car(1, 1, 0.036, 1, 0.4, 0.25);
    crowd.fleet.end();
    const { o, lights } = asObject(parts.cars[0]!, 1, 0.036, 1, 0.4, 0.25);
    expect(Array.from(matrixAt(drawing(scene, parts, 0, 'wheel'), 0).elements)).toEqual(
      closeTo(o.getObjectByName('wheel')!.matrixWorld),
    );
    const head = matrixAt(crowd.glows[0] as THREE.InstancedMesh, 0);
    expect(new THREE.Vector3().setFromMatrixPosition(head).toArray()).toEqual(
      new THREE.Vector3()
        .setFromMatrixPosition(lights[0]!.matrixWorld)
        .toArray()
        .map((n) => expect.closeTo(n, 5)),
    );
    // A sprite's size is the length of its matrix's columns, whichever way the car is turned.
    const width = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixColumn(m, 0).length();
    expect(width(head)).toBeCloseTo(width(lights[0]!.matrixWorld), 5);
  });

  it('hang two headlights, two taillights and one beam on every car, where the sprites were', () => {
    const { crowd, parts } = make();
    crowd.fleet.begin(0);
    crowd.fleet.car(1, -4, 0.036, 2.5, -2, 1);
    crowd.fleet.end();
    const { lights, beam } = asObject(parts.cars[0]!, -4, 0.036, 2.5, -2, 1);
    const [head, tail, beams] = crowd.glows as THREE.InstancedMesh[];
    expect([head!.count, tail!.count, beams!.count]).toEqual([2, 2, 1]);
    const at = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m).toArray();
    const world = [0, 1].map((i) => at(matrixAt(head!, i)));
    expect(world).toEqual(
      [at(lights[0]!.matrixWorld), at(lights[1]!.matrixWorld)].map((p) => p.map((n) => expect.closeTo(n, 5))),
    );
    const behind = [0, 1].map((i) => at(matrixAt(tail!, i)));
    expect(behind).toEqual(
      [at(lights[2]!.matrixWorld), at(lights[3]!.matrixWorld)].map((p) => p.map((n) => expect.closeTo(n, 5))),
    );
    expect(Array.from(matrixAt(beams!, 0).elements)).toEqual(closeTo(beam.matrixWorld));
  });

  it('draw a vehicle kind with its own model, and kinds past the last model wrap around', () => {
    const { scene, parts, crowd } = make(2);
    crowd.fleet.begin(0);
    crowd.fleet.car(1, 0, 0, 0, 0, 1);
    crowd.fleet.car(2, 1, 0, 0, 0, 1);
    crowd.fleet.car(3, 2, 0, 0, 0, 1);
    crowd.fleet.end();
    expect(drawing(scene, parts, 0, 'body').count).toBe(2);
    expect(drawing(scene, parts, 1, 'body').count).toBe(1);
  });

  it('cost one mesh per model part, however many cars there are', () => {
    const { scene, crowd } = make();
    const before = scene.children.length;
    crowd.fleet.begin(0);
    for (let i = 0; i < 500; i++) crowd.fleet.car(1 + (i % 6), i, 0, 0, 0, 1);
    crowd.fleet.end();
    expect(scene.children.length).toBe(before);
    expect(crowd.counts()).toMatchObject({ cars: 500, lights: 2000 });
  });

  it('cast shadows, as the cars did', () => {
    const { scene, parts } = make();
    expect(drawing(scene, parts, 0, 'body').castShadow).toBe(true);
  });

  it('leave out a car that has shrunk to nothing', () => {
    const { crowd } = make();
    crowd.fleet.begin(0);
    crowd.fleet.car(1, 0, 0, 0, 0, 0);
    crowd.fleet.end();
    expect(crowd.counts()).toEqual({ cars: 0, people: 0, lights: 0 });
  });

  it('start every round from empty', () => {
    const { crowd } = make();
    crowd.fleet.begin(0);
    crowd.fleet.car(1, 0, 0, 0, 0, 1);
    crowd.fleet.person(4, 0, 0, 0, 0, 1);
    crowd.fleet.end();
    expect(crowd.counts()).toMatchObject({ cars: 1, people: 1 });
    crowd.fleet.begin(0);
    crowd.fleet.end();
    expect(crowd.counts()).toEqual({ cars: 0, people: 0, lights: 0 });
  });

  it('light up with the time of day', () => {
    const { crowd, parts } = make();
    crowd.setLights(0.5, 0.25, 0.75);
    const [head, tail] = crowd.glows as THREE.InstancedMesh[];
    expect((head!.material as THREE.ShaderMaterial).uniforms.opacity!.value).toBe(0.5);
    expect((tail!.material as THREE.ShaderMaterial).uniforms.opacity!.value).toBe(0.25);
    expect(parts.beam.opacity).toBe(0.75);
  });
});

describe('the fleet’s view', () => {
  /** A camera at (0, 8, 8) looking at the origin. */
  const camera = () => {
    const c = new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 200);
    c.position.set(0, 8, 8);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    return c;
  };

  it('leaves out a car and a walker the camera cannot see, with room to spare for the next frame', () => {
    const { crowd } = make();
    crowd.fleet.view(camera());
    crowd.fleet.begin(0);
    crowd.fleet.car(1, 0, 0, 0, 0, 1);
    crowd.fleet.car(1, 60, 0, 0, 0, 1);
    crowd.fleet.car(1, 0, 0, 40, 0, 1);
    crowd.fleet.person(1, 0, 0, 0, 0, 1);
    crowd.fleet.person(2, -60, 0, 0, 0, 1);
    crowd.fleet.end();
    expect(crowd.counts()).toMatchObject({ cars: 1, people: 1, lights: 4 });
  });

  it('keeps one just past the edge of the picture, so a pan does not show it late', () => {
    const { crowd } = make();
    const c = camera();
    // The picture's right edge on the ground, found by walking out until the point leaves the view.
    let edge = 0;
    for (let x = 0; x < 40; x += 0.05) {
      const p = new THREE.Vector3(x, 0, 0).project(c);
      if (Math.abs(p.x) > 1) break;
      edge = x;
    }
    crowd.fleet.view(c);
    crowd.fleet.begin(0);
    crowd.fleet.car(1, edge + 1, 0, 0, 0, 1);
    crowd.fleet.car(1, edge + 4, 0, 0, 0, 1);
    crowd.fleet.end();
    expect(crowd.counts().cars).toBe(1);
  });

  it('draws everything when there is no view', () => {
    const { crowd } = make();
    crowd.fleet.view(camera());
    crowd.fleet.view(null);
    crowd.fleet.begin(0);
    crowd.fleet.car(1, 500, 0, 0, 0, 1);
    crowd.fleet.end();
    expect(crowd.counts().cars).toBe(1);
  });
});

describe('the fleet’s walkers', () => {
  it('stand where the walker was put, at the size given', () => {
    const { crowd } = make();
    crowd.fleet.begin(0);
    crowd.fleet.person(7, 2, 0, -1, 0.5, 1);
    crowd.fleet.end();
    const walkers = crowd.glows.slice(3) as THREE.InstancedMesh[];
    const used = walkers.filter((m) => m.count === 1);
    // The fixture's one skinned mesh, for the model resident 7 gets (7 % 3 = 1).
    expect(used).toHaveLength(1);
    const expected = new THREE.Matrix4().compose(
      new THREE.Vector3(2, 0, -1),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5),
      new THREE.Vector3(1, 1, 1).multiplyScalar(PERSON_SCALE),
    );
    expect(Array.from(matrixAt(used[0]!, 0).elements)).toEqual(closeTo(expected));
  });

  it('start each walker at its own place in the cycle', () => {
    const { crowd } = make();
    crowd.fleet.begin(0);
    crowd.fleet.person(3, 0, 0, 0, 0, 1);
    crowd.fleet.person(6, 0, 0, 0, 0, 1);
    crowd.fleet.end();
    const mesh = (crowd.glows.slice(3) as THREE.InstancedMesh[]).find((m) => m.count === 2)!;
    const phase = mesh.geometry.getAttribute('phase');
    expect([phase.getX(0), phase.getX(1)]).toEqual([expect.closeTo(walkPhase(3), 6), expect.closeTo(walkPhase(6), 6)]);
  });

  it('share one clock for the cycle, moved on by the time each round is given and wrapped at the loop', () => {
    const { crowd } = make();
    const clocks = (crowd.glows.slice(3) as THREE.InstancedMesh[]).map((m) => {
      const shader = { uniforms: {} as Record<string, { value: number }>, vertexShader: '' };
      (m.material as THREE.Material).onBeforeCompile(shader as never, null as never);
      return shader.uniforms.walkAt!;
    });
    expect(new Set(clocks).size).toBe(1);
    crowd.fleet.begin(0.25);
    expect(clocks[0]!.value).toBeCloseTo(0.25);
    crowd.fleet.begin(0.9);
    expect(clocks[0]!.value).toBeCloseTo(0.15);
  });

  it('are hidden from the depth and occlusion passes, with the lights', () => {
    const { crowd } = make();
    // Three lights, and one mesh for each of the three models' one skinned mesh.
    expect(crowd.glows).toHaveLength(3 + 3);
  });

  it('cast no shadow', () => {
    const { crowd } = make();
    for (const m of crowd.glows.slice(3)) expect(m.castShadow).toBe(false);
  });

  it('are not drawn once they have shrunk to nothing', () => {
    const { crowd } = make();
    crowd.fleet.begin(0);
    crowd.fleet.person(1, 0, 0, 0, 0, 0);
    crowd.fleet.end();
    expect(crowd.counts().people).toBe(0);
  });
});
