// Instances of one geometry and material that come and go while the page runs, drawn as a single call. The instanced
// meshes of cars and walkers (instanced.ts) refill from empty each frame; the static city's lots, road tiles and lamps
// change only when a builder acts or the hour moves, so each instance here keeps its place until it is removed.
import * as THREE from 'three';

const FIRST_CAPACITY = 16;

/** A per-instance attribute next to the matrix. `instanceColor` is the one three.js reads from the mesh itself. */
export interface Extra {
  name: string;
  size: number;
}

/** One instance of a pool. `index` moves when another instance is removed, so keep the object, not the number. */
export interface Instance {
  index: number;
}

export class InstancePool {
  readonly mesh: THREE.InstancedMesh;
  private capacity = FIRST_CAPACITY;
  private readonly owners: Instance[] = [];
  private readonly geometry: THREE.BufferGeometry;

  constructor(
    source: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    private readonly extras: readonly Extra[] = [],
  ) {
    // The extras go on a geometry of this pool's own, sharing the model's vertex buffers.
    this.geometry = new THREE.BufferGeometry();
    this.geometry.index = source.index;
    for (const name of Object.keys(source.attributes)) this.geometry.setAttribute(name, source.getAttribute(name));
    this.mesh = new THREE.InstancedMesh(this.geometry, material, FIRST_CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The page places and removes every instance, and one pool spans the whole city.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (const e of extras) this.attach(e, this.makeExtra(e));
  }

  get count(): number {
    return this.owners.length;
  }

  /** Add an instance at `matrix`; its extras start at zero. */
  add(matrix: THREE.Matrix4): Instance {
    if (this.owners.length === this.capacity) this.grow();
    const instance = { index: this.owners.length };
    this.owners.push(instance);
    this.mesh.count = this.owners.length;
    this.setMatrix(instance, matrix);
    for (const e of this.extras) this.write(e, instance.index, ZERO);
    return instance;
  }

  setMatrix(instance: Instance, matrix: THREE.Matrix4): void {
    matrix.toArray(this.mesh.instanceMatrix.array, instance.index * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Set an extra of an instance; it is uploaded only when it changed. */
  set(instance: Instance, name: string, ...values: number[]): void {
    const e = this.extras.find((x) => x.name === name)!;
    const a = this.attribute(e);
    const at = instance.index * e.size;
    for (let i = 0; i < e.size; i++) {
      if (a.array[at + i] === values[i]) continue;
      a.array[at + i] = values[i]!;
      a.needsUpdate = true;
    }
  }

  /** Take an instance out. The last one moves into its place, so the draw stays dense. */
  remove(instance: Instance): void {
    const at = instance.index;
    if (at < 0) return;
    const last = this.owners.pop()!;
    if (last !== instance) {
      const m = this.mesh.instanceMatrix;
      (m.array as Float32Array).copyWithin(at * 16, last.index * 16, last.index * 16 + 16);
      for (const e of this.extras) {
        const a = this.attribute(e).array as Float32Array;
        a.copyWithin(at * e.size, last.index * e.size, last.index * e.size + e.size);
        this.attribute(e).needsUpdate = true;
      }
      this.owners[at] = last;
      last.index = at;
    }
    instance.index = -1;
    this.mesh.count = this.owners.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
  }

  private attribute(e: Extra): THREE.BufferAttribute {
    return (
      e.name === 'instanceColor' ? this.mesh.instanceColor! : this.geometry.getAttribute(e.name)
    ) as THREE.BufferAttribute;
  }

  private write(e: Extra, index: number, values: readonly number[]): void {
    const a = this.attribute(e);
    for (let i = 0; i < e.size; i++) a.array[index * e.size + i] = values[i]!;
    a.needsUpdate = true;
  }

  private makeExtra(e: Extra, from?: ArrayLike<number>): THREE.InstancedBufferAttribute {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * e.size), e.size);
    if (from) (a.array as Float32Array).set(from);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }

  private attach(e: Extra, a: THREE.InstancedBufferAttribute): void {
    if (e.name === 'instanceColor') this.mesh.instanceColor = a;
    else this.geometry.setAttribute(e.name, a);
  }

  private grow(): void {
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    const old = this.extras.map((e) => this.attribute(e).array as Float32Array);
    this.capacity *= 2;
    // Frees the buffers the old arrays were uploaded as; the new ones are made on the next draw.
    this.mesh.dispose();
    this.geometry.dispose();
    const bigger = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 16), 16);
    bigger.array.set(matrices);
    bigger.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix = bigger;
    this.extras.forEach((e, i) => this.attach(e, this.makeExtra(e, old[i])));
  }
}

const ZERO: readonly number[] = [0, 0, 0, 0];
