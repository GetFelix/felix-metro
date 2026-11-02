// Draws the ambient life ambient.ts works out: lit shop windows, chimney smoke, birds on roofs, traffic lights, and the
// places the garbage truck and the delivery vans stand. Nothing here keeps a clock; each update rebuilds the picture
// from the tick it is given, so a rewind or a seek draws what a forward run would.
import * as THREE from 'three';
import { TICKS_PER_DAY } from './clock';
import { night } from './daylight';
import { Batch, glowGeometry, radialTexture, tintMaterial } from './instanced';
import { KINDS } from './kinds';
import { lotLook, type City } from './layout';
import type { Fleet } from './traffic';
import {
  birdVisit,
  buildRoads,
  dayOf,
  hasRoost,
  hourOf,
  planDay,
  puffAge,
  roll,
  routePose,
  seedNumber,
  shopOpen,
  signalAt,
  smokeLevel,
  type Light,
  type Placed,
  type Roads,
  TRUCK_KIND,
  type Round,
} from './ambient';

/** What a quality tier draws. */
export interface AmbientSettings {
  shops: boolean;
  /** Puffs rising from each stack; 0 for none. */
  smoke: number;
  /** Birds on each roost; 0 for none. */
  birds: number;
  /** Delivery vans out at once, up to the most a day plans. */
  vans: number;
  truck: boolean;
  signals: boolean;
}

/** What the scene lets this reach. */
export interface AmbientAccess {
  /** The building kind on a lot now: the generated one, or what the log built. */
  kind(lot: number): number;
  /** The building drawn on a lot once it has loaded. */
  building(lot: number): THREE.Object3D | null;
  /** The lot is going up or coming down, so nothing is hung on it. */
  busy(lot: number): boolean;
}

/** A piece of a model: its geometry, the material to draw it with, and where it sits in the model. */
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  local: THREE.Matrix4;
}

/** What is on screen, for the CI check and the console. */
export interface AmbientCounts {
  shops: number;
  puffs: number;
  birds: number;
  vans: number;
  truck: number;
  green: number;
  amber: number;
  red: number;
}

/** Where a factory's stack tops out in its model, by model name. */
const STACKS: Record<string, [number, number, number]> = {
  'building-a': [-0.67, 1.47, 0.34],
  'building-b': [0.13, 1.47, 0.34],
  'building-c': [0.34, 1.25, 0],
  'building-d': [0, 1.41, 0.4],
  'building-e': [-0.37, 1.65, 0.68],
  'building-f': [-1.1, 1.92, -0.12],
  'chimney-large': [0, 1.7, 0],
};

const WIND: readonly [number, number] = [0.5, 0.2];
/** The shop window's strip: a share of the facade's width, and its height and middle above the pavement. */
const WINDOW_SHARE = 0.72;
const WINDOW_HEIGHT = 0.15;
const WINDOW_MIDDLE = 0.13;
const SHOP_WARM = new THREE.Color(1.5, 1.05, 0.55);
const POST_CORNER = 0.4;
const LENS_HEIGHT = 0.455;
const LENS_SIZE = 0.11;
/** Hang a bird above the roof so its feet are on it. */
const PERCH = 0.02;
const MAX_VEHICLES = 8;

const LIGHTS: Record<Light, number> = { green: 0, amber: 1, red: 2 };
const LENS_COLOURS = ['rgba(60,235,130,1)', 'rgba(255,176,32,1)', 'rgba(255,59,42,1)'];

function canvasTexture(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A warm strip of three panes. */
function windowTexture() {
  return canvasTexture(
    (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgba(255,226,170,0.75)');
      grad.addColorStop(1, 'rgba(255,196,110,1)');
      g.fillStyle = grad;
      const pane = (w - 4 * 3) / 3;
      for (let i = 0; i < 3; i++) g.fillRect(3 + i * (pane + 3), 3, pane, h - 6);
    },
    96,
    24,
  );
}

/** A bird seen from the side with its wings up: two strokes meeting at the body. */
function birdTexture() {
  return canvasTexture(
    (g, w, h) => {
      g.strokeStyle = 'rgba(222,214,200,1)';
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(3, 3);
      g.quadraticCurveTo(w / 2 - 4, h / 2, w / 2, h - 5);
      g.quadraticCurveTo(w / 2 + 4, h / 2, w - 3, 3);
      g.stroke();
    },
    32,
    16,
  );
}

/** The building's box with the height it has when finished, whatever a construction animation has scaled it to. */
function fullBox(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o);
  const base = (o.userData as { baseY?: number }).baseY;
  if (base !== undefined && o.scale.y > 0) box.max.y = (box.max.y * base) / o.scale.y;
  return box;
}

interface Shop {
  lot: number;
  matrix: Float32Array;
  /** Quarter turns from facing south, as the lot's facing counts them. */
  turns: number;
}
interface Stack {
  lot: number;
  x: number;
  y: number;
  z: number;
}
interface Crossing {
  node: number;
  x: number;
  z: number;
}

export class Ambient {
  private readonly seed: number;
  private readonly roads: Roads;
  private readonly half: number;
  private readonly shops = new Map<number, Shop>();
  private readonly stacks = new Map<number, Stack>();
  private readonly roosts = new Map<number, Stack>();
  private readonly crossings: Crossing[] = [];
  private readonly windows: Batch;
  private readonly smoke: Batch;
  private readonly birds: Batch;
  private readonly lenses: Batch[];
  private readonly posts: Batch[] = [];
  private readonly smokeMaterial: THREE.ShaderMaterial;
  private readonly windowMaterial: THREE.ShaderMaterial;
  private readonly lensMaterials: THREE.ShaderMaterial[];
  private readonly textures: THREE.Texture[] = [];
  private readonly meshes: THREE.Object3D[] = [];
  private readonly placed: (Placed & { kind: number })[] = [];
  private plan: { day: number; rounds: Round[] } | null = null;
  private tick = NaN;
  private readonly counted: AmbientCounts = {
    shops: 0,
    puffs: 0,
    birds: 0,
    vans: 0,
    truck: 0,
    green: 0,
    amber: 0,
    red: 0,
  };
  private readonly scratch = new THREE.Matrix4();
  private readonly point = new THREE.Vector3();
  private readonly lotTile: (id: number) => { x: number; z: number } | null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly city: City,
    private readonly access: AmbientAccess,
    private settings: AmbientSettings,
    /** What the ambient occlusion and depth passes must leave out: everything here that is blended. */
    glows: THREE.Object3D[],
    /** The traffic light's post, for the crossings. */
    post: readonly ModelPart[] = [],
  ) {
    this.seed = seedNumber(city.seed);
    this.half = (city.tiles - 1) / 2;
    this.lotTile = (id) => {
      const l = city.lots[id];
      return l ? { x: l.x, z: l.z } : null;
    };
    const commercial = (zone: string) => zone === 'commercial' || zone === 'downtown';
    this.roads = buildRoads(
      city.roads,
      city.lots.map((l) => {
        const info = KINDS[l.kind];
        const look = info ? lotLook(info.pack, info.model) : null;
        const building = look === 'skyscraper' || look === 'commercial' || look === 'house' || look === 'factory';
        return {
          id: l.id,
          x: l.x,
          z: l.z,
          building: building && l.id !== city.tower,
          commercial: building && commercial(l.zone),
        };
      }),
    );
    this.roads.x.forEach((_, i) => {
      if (city.roads[i]!.piece === 3)
        this.crossings.push({ node: i, x: this.roads.x[i]! - this.half, z: this.roads.z[i]! - this.half });
    });
    for (let i = 0; i < MAX_VEHICLES; i++) this.placed.push({ x: 0, z: 0, heading: 0, size: 0, kind: 0 });

    const own = <T extends THREE.Object3D>(o: T, hidden: boolean): T => {
      this.scene.add(o);
      this.meshes.push(o);
      if (hidden) glows.push(o);
      return o;
    };
    const textured = <T extends THREE.Texture>(t: T) => (this.textures.push(t), t);

    this.windowMaterial = tintMaterial(textured(windowTexture()), { billboard: false, additive: true });
    this.windowMaterial.uniforms.tint!.value.copy(SHOP_WARM);
    this.windows = new Batch(new THREE.PlaneGeometry(1, 1), this.windowMaterial, { name: 'alpha', size: 1 });
    own(this.windows.mesh, true);

    this.smokeMaterial = tintMaterial(textured(radialTexture('rgba(255,255,255,1)')), {
      billboard: true,
      additive: false,
    });
    this.smoke = new Batch(glowGeometry(), this.smokeMaterial, { name: 'alpha', size: 1 });
    own(this.smoke.mesh, true);

    const birdMaterial = tintMaterial(textured(birdTexture()), { billboard: true, additive: false });
    this.birds = new Batch(new THREE.PlaneGeometry(1, 0.5), birdMaterial, { name: 'alpha', size: 1 });
    own(this.birds.mesh, true);

    this.lensMaterials = LENS_COLOURS.map((c) => {
      const m = tintMaterial(textured(radialTexture(c)), { billboard: true, additive: true });
      m.uniforms.tint!.value.setScalar(1.6);
      return m;
    });
    this.lenses = this.lensMaterials.map((m) => {
      const b = new Batch(glowGeometry(), m, { name: 'alpha', size: 1 });
      own(b.mesh, true);
      return b;
    });

    this.buildPosts(post, own);
    this.setTier(settings);
  }

  /** Change what is drawn, as the quality tier changes. */
  setTier(settings: AmbientSettings): void {
    this.settings = settings;
    for (const p of this.posts) p.mesh.visible = settings.signals;
    if (!Number.isNaN(this.tick)) this.update(this.tick);
  }

  /** What is on screen now. */
  counts(): Readonly<AmbientCounts> {
    return this.counted;
  }

  /** Hang the effects a lot's building carries, once its model has loaded and whenever it changes. */
  refresh(lot: number): void {
    this.clearLot(lot);
    const info = KINDS[this.access.kind(lot)];
    const o = this.access.building(lot);
    const at = this.city.lots[lot];
    if (!info || !o || !at || lot === this.city.tower) return;
    const look = lotLook(info.pack, info.model);
    const box = fullBox(o);
    const centre = box.getCenter(this.point);
    const [cx, cz] = [centre.x, centre.z];
    if (look === 'commercial' && (at.zone === 'commercial' || at.zone === 'downtown')) {
      const turns = (((Math.round(o.rotation.y / (Math.PI / 2)) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
      const dir = [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ][turns]!;
      const alongX = turns % 2 === 0;
      const reach = alongX ? (box.max.z - box.min.z) / 2 : (box.max.x - box.min.x) / 2;
      const width = (alongX ? box.max.x - box.min.x : box.max.z - box.min.z) * WINDOW_SHARE;
      const m = new THREE.Matrix4()
        .makeRotationY((turns * Math.PI) / 2)
        .setPosition(cx + dir[0]! * (reach + 0.004), WINDOW_MIDDLE, cz + dir[1]! * (reach + 0.004))
        .multiply(new THREE.Matrix4().makeScale(width, WINDOW_HEIGHT, 1));
      this.shops.set(lot, { lot, matrix: Float32Array.from(m.elements), turns });
    }
    if (look === 'factory' || info.model === 'chimney-large') {
      const local = STACKS[info.model];
      if (local) {
        const p = new THREE.Vector3(...local);
        // The model's own space, before construction scaled it.
        o.updateMatrixWorld(true);
        o.localToWorld(p);
        const base = (o.userData as { baseY?: number }).baseY;
        if (base !== undefined && o.scale.y > 0) p.y = (p.y * base) / o.scale.y;
        this.stacks.set(lot, { lot, x: p.x, y: p.y, z: p.z });
      }
    } else if (look !== 'prop' && hasRoost(this.seed, lot)) {
      this.roosts.set(lot, {
        lot,
        x: cx + (roll(this.seed, lot, 10) - 0.5) * 0.3,
        y: box.max.y + PERCH,
        z: cz + (roll(this.seed, lot, 11) - 0.5) * 0.3,
      });
    }
  }

  /** Take down what hangs on a lot, while its building is replaced. */
  clearLot(lot: number): void {
    this.shops.delete(lot);
    this.stacks.delete(lot);
    this.roosts.delete(lot);
  }

  /** Draw the city's ambient life at `tick`, a fraction. */
  update(tick: number): void {
    this.tick = tick;
    const hour = hourOf(tick);
    const dark = night(hour);
    const c = this.counted;
    c.shops = c.puffs = c.birds = c.vans = c.truck = c.green = c.amber = c.red = 0;
    this.fillShops(hour, dark);
    this.fillSmoke(tick, hour, dark);
    this.fillBirds(tick, hour);
    this.fillLenses(tick, dark);
    this.fillVehicles(tick);
  }

  /** One of each kind of effect, as `[x, y, z]` in world units, for a page that wants to look at it. */
  focus(): Partial<Record<'shop' | 'stack' | 'roost' | 'crossing' | 'vehicle', [number, number, number]>> {
    // The ones nearest the camera's corner, so a shop's front and a flock are in view and nothing stands between.
    const near = <T extends { x: number; z: number }>(all: Iterable<T>) =>
      [...all].reduce<T | undefined>((a, b) => (!a || b.x + b.z > a.x + a.z ? b : a), undefined);
    const shop = near(
      [...this.shops.values()]
        .filter((s) => s.turns < 2)
        .map((s) => ({ x: s.matrix[12]!, y: s.matrix[13]!, z: s.matrix[14]! })),
    );
    const stack = near(this.stacks.values());
    const roost = near(this.roosts.values());
    const crossing = near(this.crossings);
    const vehicle = this.placed.find((p) => p.size > 0);
    return {
      shop: shop && [shop.x, shop.y, shop.z],
      stack: stack && [stack.x, stack.y, stack.z],
      roost: roost && [roost.x, roost.y, roost.z],
      crossing: crossing && [crossing.x, 0.3, crossing.z],
      vehicle: vehicle && [vehicle.x, 0.1, vehicle.z],
    };
  }

  /** Place the truck and the vans in the fleet's round. */
  place(fleet: Fleet): void {
    for (const p of this.placed) if (p.size > 0) fleet.car(p.kind, p.x, 0.036, p.z, p.heading, p.size);
  }

  dispose(): void {
    for (const m of this.meshes) this.scene.remove(m);
    for (const b of [this.windows, this.smoke, this.birds, ...this.lenses, ...this.posts]) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.windowMaterial.dispose();
    this.smokeMaterial.dispose();
    this.lensMaterials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }

  private buildPosts(post: readonly ModelPart[], own: <T extends THREE.Object3D>(o: T, hidden: boolean) => T): void {
    if (!this.crossings.length) return;
    const corner = new THREE.Matrix4();
    for (const part of post) {
      const batch = new Batch(part.geometry, part.material);
      batch.mesh.castShadow = false;
      own(batch.mesh, false);
      for (const x of this.crossings) {
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const) {
          corner.makeTranslation(x.x + sx * POST_CORNER, 0, x.z + sz * POST_CORNER);
          this.scratch.multiplyMatrices(corner, part.local).toArray(batch.matrices, batch.next() * 16);
        }
      }
      batch.finish();
      this.posts.push(batch);
    }
  }

  private fillShops(hour: number, dark: number): void {
    const b = this.windows;
    b.clear();
    if (this.settings.shops) {
      // By day the shops show a pale strip; at night the glow carries.
      const lift = 0.3 + 0.7 * dark;
      for (const s of this.shops.values()) {
        if (this.access.busy(s.lot)) continue;
        const open = shopOpen(hour, this.seed, s.lot);
        if (open < 0.01) continue;
        const i = b.next();
        b.matrices.set(s.matrix, i * 16);
        b.values[i] = open * lift;
        if (open > 0.5) this.counted.shops++;
      }
    }
    b.finish();
  }

  private fillSmoke(tick: number, hour: number, dark: number): void {
    const b = this.smoke;
    b.clear();
    const n = this.settings.smoke;
    if (n > 0) {
      const grey = 0.9 - 0.62 * dark;
      this.smokeMaterial.uniforms.tint!.value.setScalar(grey);
      const e = this.scratch.elements;
      for (const s of this.stacks.values()) {
        if (this.access.busy(s.lot)) continue;
        const level = smokeLevel(hour, this.seed, s.lot);
        if (level < 0.02) continue;
        for (let i = 0; i < n; i++) {
          const age = puffAge(tick, this.seed, s.lot, i, n);
          const size = 0.12 + 0.3 * age;
          const sway = 0.03 * Math.sin(age * 9 + i + s.lot);
          const at = b.next();
          this.scratch.identity();
          e[0] = size;
          e[5] = size;
          e[12] = s.x + WIND[0] * age * 0.5 + sway;
          e[13] = s.y + age * 0.55;
          e[14] = s.z + WIND[1] * age * 0.5;
          this.scratch.toArray(b.matrices, at * 16);
          b.values[at] = level * 0.85 * Math.sin(Math.PI * age);
          this.counted.puffs++;
        }
      }
    }
    b.finish();
  }

  private fillBirds(tick: number, hour: number): void {
    const b = this.birds;
    b.clear();
    const n = this.settings.birds;
    if (n > 0) {
      const e = this.scratch.elements;
      for (const r of this.roosts.values()) {
        if (this.access.busy(r.lot)) continue;
        const v = birdVisit(hour, this.seed, r.lot);
        if (!v.here) continue;
        // Away from the roof 1 as the flock comes in, 0 while it sits, and 1 again as it leaves.
        const away = 1 - v.landing + v.leaving;
        const angle = roll(this.seed, r.lot, v.leaving > 0 ? 12 : 13) * Math.PI * 2;
        const lift = away * (2 - away);
        for (let j = 0; j < n; j++) {
          const dx = (roll(this.seed, r.lot, 20 + j) - 0.5) * 0.18;
          const dz = (roll(this.seed, r.lot, 30 + j) - 0.5) * 0.18;
          const flap = away > 0 ? 1 + 0.35 * Math.sin(tick * 2.4 + j * 1.7) : 1;
          const size = 0.1 * flap;
          const at = b.next();
          this.scratch.identity();
          e[0] = size;
          e[5] = size;
          e[12] = r.x + dx + Math.cos(angle) * away * 1.4;
          e[13] = r.y + lift * 0.9;
          e[14] = r.z + dz + Math.sin(angle) * away * 1.4;
          this.scratch.toArray(b.matrices, at * 16);
          b.values[at] = Math.min(1, v.landing * 6) * (1 - v.leaving * v.leaving);
          this.counted.birds++;
        }
      }
    }
    b.finish();
  }

  private fillLenses(tick: number, dark: number): void {
    for (const l of this.lenses) l.clear();
    if (this.settings.signals) {
      for (const m of this.lensMaterials) m.uniforms.opacity!.value = 0.55 + 0.45 * dark;
      const e = this.scratch.elements;
      for (const x of this.crossings) {
        const s = signalAt(tick, this.seed, x.node);
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const) {
          // Posts across from each other show one road's light, and the next post along shows the other's.
          const light = sx * sz > 0 ? s.ns : s.ew;
          const batch = this.lenses[LIGHTS[light]]!;
          const at = batch.next();
          this.scratch.identity();
          e[0] = LENS_SIZE;
          e[5] = LENS_SIZE;
          e[12] = x.x + sx * POST_CORNER;
          e[13] = LENS_HEIGHT;
          e[14] = x.z + sz * POST_CORNER;
          this.scratch.toArray(batch.matrices, at * 16);
          batch.values[at] = 1;
          this.counted[light]++;
        }
      }
    }
    for (const l of this.lenses) l.finish();
  }

  private fillVehicles(tick: number): void {
    for (const p of this.placed) p.size = 0;
    const { vans, truck } = this.settings;
    if (!vans && !truck) return;
    const day = dayOf(tick);
    if (this.plan?.day !== day) this.plan = { day, rounds: planDay(this.roads, this.seed, day) };
    const into = tick - day * TICKS_PER_DAY;
    let slot = 0;
    let van = 0;
    for (const r of this.plan.rounds) {
      const isVan = r.kind !== TRUCK_KIND;
      if (isVan ? van++ >= vans : !truck) continue;
      const p = this.placed[slot]!;
      if (!routePose(this.roads, r.route, into - r.start, this.lotTile, p)) continue;
      p.kind = r.kind;
      p.x -= this.half;
      p.z -= this.half;
      slot++;
      if (isVan) this.counted.vans++;
      else this.counted.truck++;
    }
    for (let i = slot; i < this.placed.length; i++) this.placed[i]!.size = 0;
  }
}
