// The building tools on the canvas: the lot or crossing under the pointer, its marker and ghost, and the click or tap
// that uses the tool. What the tool does is placement.ts; this finds what is pointed at and draws the answer.
import * as THREE from 'three';
import { isEmpty, kindOn, lotAtTile, roadOver, tilesBetween, type Ground } from './build';
import type { LotAccess } from './construction-fx';
import type { City } from './layout';
import { LotGrid, groundPoint, lotsAlong } from './lot-pick';
import { createMarker, createRoadGhost } from './placement-ghost';
import { PHOTO_CLASS } from './ui/photo';
import type { Placement, RoadPreview, RoadTarget } from './placement';

/** Taller than any building, in tiles: the ray is followed down from here. */
const CEILING = 5;
/** Pixels a press may wander and still be a click; a finger is less steady than a mouse. */
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 12;
/** A press held longer than this is a look around, not a click. */
const CLICK_MS = 600;
/** What a first tap picked with a touch demolish or road is dropped after this long with no second tap. */
const CONFIRM_MS = 5000;

/** Photo mode shows the city and nothing else, so nothing may be placed or drawn then. */
const photo = () => document.body.classList.contains(PHOTO_CLASS);

/** Points over a lot to aim at, as offsets from its middle and a height: its middle, then its corners, then higher. */
const AIMS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0.3],
  [0, 0, 0.9],
  [0, 0, 0.05],
  [0.3, 0.3, 0.3],
  [-0.3, 0.3, 0.3],
  [0.3, -0.3, 0.3],
  [-0.3, -0.3, 0.3],
  [0, 0, 1.6],
];

export interface PlacementViewDeps {
  dom: HTMLElement;
  camera: THREE.Camera;
  scene: THREE.Scene;
  city: City;
  placement: Placement;
  ground(): Ground;
  lots: LotAccess;
  previewBuilding(lot: number | null, building: { kind: number; rotation: number } | null, fits: boolean): void;
}

export interface PlacementView {
  /** Follow the pointer and the camera; called once a frame. */
  update(): void;
  /** The lot under a point of the canvas, in normalised device coordinates. */
  pick(x: number, y: number): number | null;
  /** Where on the canvas, in client pixels, a lot's middle is. */
  screenOf(lot: number): { x: number; y: number } | null;
  /** Where on the canvas, in client pixels, map tile `(x, z)` is on the ground, or null off screen. */
  screenOfTile(x: number, z: number): { x: number; y: number } | null;
}

export function createPlacementView(deps: PlacementViewDeps): PlacementView {
  const { dom, camera, placement, lots } = deps;
  const grid = new LotGrid(deps.city.tiles, deps.city.lots);
  const marker = createMarker(deps.scene);
  const roadGhost = createRoadGhost(deps.scene);
  const half = (deps.city.tiles - 1) / 2;
  const nodes = deps.city.nodes;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  /** Where the mouse last was, so the lot under it follows the camera as well as the mouse. */
  let pointer: { x: number; y: number } | null = null;

  const pick = (x: number, y: number): number | null => {
    ndc.set(x, y);
    raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = raycaster.ray;
    const ray = { origin, direction };
    let best: { lot: number; distance: number } | null = null;
    for (const lot of lotsAlong(ray, grid, CEILING)) {
      const objects = lots.objects(lot);
      if (objects.length === 0) continue;
      const hit = raycaster.intersectObjects(objects as THREE.Object3D[], true)[0];
      if (hit && (!best || hit.distance < best.distance)) best = { lot, distance: hit.distance };
    }
    if (best) return best.lot;
    const ground = groundPoint(ray);
    return ground ? grid.lotAt(ground.x, ground.z) : null;
  };

  /** The road tool's target under a point of the canvas: the nearest crossing, and a builder's road on that tile. */
  const roadTarget = (x: number, y: number): RoadTarget | null => {
    ndc.set(x, y);
    raycaster.setFromCamera(ndc, camera);
    const ground = groundPoint(raycaster.ray);
    if (!ground) return null;
    const [tx, tz] = [ground.x + half, ground.z + half];
    let node: number | null = null;
    let best = Infinity;
    nodes.forEach(([nx, nz], i) => {
      const d = (nx - tx) ** 2 + (nz - tz) ** 2;
      if (d < best) [best, node] = [d, i];
    });
    const lot = lotAtTile(deps.city, Math.round(tx), Math.round(tz));
    return { node, segment: lot === null ? null : roadOver(deps.ground(), lot) };
  };

  /** The tiles, in world units, the road ghost covers. */
  const roadPoints = (road: RoadPreview): [number, number][] => {
    const world = ([x, z]: readonly [number, number]): [number, number] => [x - half, z - half];
    if (road.kind === 'start') return nodes[road.a] ? [world(nodes[road.a]!)] : [];
    if (road.kind === 'remove') {
      const r = deps.ground().roads?.get(road.segment);
      const [a, b] = [nodes[r?.a ?? -1], nodes[r?.b ?? -1]];
      return a && b ? tilesBetween(a, b).map(world) : [];
    }
    const [a, b] = [nodes[road.a], nodes[road.b]];
    if (!a || !b) return [];
    return [a, ...tilesBetween(a, b), b].map(world);
  };

  // Redraw the marker and ghost only when what they show changes.
  let shown = '';
  const draw = () => {
    const road = photo() ? null : placement.roadPreview();
    const preview = photo() ? null : placement.preview();
    const key = road
      ? `road|${JSON.stringify(road)}`
      : preview
        ? `${preview.lot}|${preview.tool}|${preview.kind}|${preview.rotation}|${preview.check.ok}`
        : '';
    if (key === shown) return;
    shown = key;
    if (road) {
      marker.hide();
      deps.previewBuilding(null, null, false);
      roadGhost.show(roadPoints(road), !road.check.ok ? 'clash' : road.kind === 'remove' ? 'demolish' : 'fits');
      return;
    }
    roadGhost.hide();
    if (!preview) {
      marker.hide();
      deps.previewBuilding(null, null, false);
      return;
    }
    const [x, z] = lots.centre(preview.lot);
    const fits = preview.check.ok;
    if (preview.tool === 'demolish') {
      marker.show(x, z, fits ? 'demolish' : 'clash', fits ? lots.objects(preview.lot) : []);
      deps.previewBuilding(null, null, false);
      return;
    }
    marker.show(x, z, fits ? 'fits' : 'clash');
    // A building does not draw over one already standing, or over a road.
    const ground = deps.ground();
    const kind = kindOn(ground, preview.lot);
    const bare = kind !== null && isEmpty(kind) && roadOver(ground, preview.lot) === null;
    deps.previewBuilding(
      bare ? preview.lot : null,
      bare ? { kind: preview.kind, rotation: preview.rotation } : null,
      fits,
    );
  };
  placement.onChange(() => {
    if (placement.tool !== 'demolish' && placement.tool !== 'road') disarm();
    dom.style.cursor = placement.tool ? 'crosshair' : '';
    draw();
  });

  const toNdc = (clientX: number, clientY: number) => {
    const r = dom.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * 2 - 1, y: 1 - ((clientY - r.top) / r.height) * 2 };
  };

  let press: { id: number; x: number; y: number; at: number; touch: boolean } | null = null;
  const pointers = new Set<number>();
  const onDown = (e: PointerEvent) => {
    const touch = e.pointerType !== 'mouse';
    if (!touch) pointers.clear();
    pointers.add(e.pointerId);
    // A second finger, a button that is not the main one, or the pan modifier is the camera's.
    if (!placement.tool || photo() || pointers.size > 1 || (!touch && (e.button !== 0 || e.shiftKey))) {
      press = null;
      return;
    }
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), touch };
  };
  const onMove = (e: PointerEvent) => {
    if (press?.id === e.pointerId) {
      const slop = press.touch ? TOUCH_SLOP : MOUSE_SLOP;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > slop) press = null;
    }
    if (e.pointerType !== 'mouse') return;
    if (e.buttons === 0) {
      pointer = toNdc(e.clientX, e.clientY);
    } else {
      // A drag is the camera's: the ghost would sit where the pointer was when it began.
      pointer = null;
      placement.hover(null);
      placement.hoverRoad(null);
    }
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    const p = press;
    if (!p || p.id !== e.pointerId || !placement.tool || photo()) return;
    press = null;
    if (performance.now() - p.at > CLICK_MS) return;
    const at = toNdc(e.clientX, e.clientY);
    if (placement.tool === 'road') {
      const target = roadTarget(at.x, at.y);
      if (!target) return;
      placement.hoverRoad(target);
      if (p.touch) {
        // A finger cannot hover, so a road or a removal is sent by a second tap on what the first one showed.
        const road = placement.roadPreview(target);
        const key = road?.kind === 'lay' ? `lay:${road.b}` : road?.kind === 'remove' ? `remove:${road.segment}` : null;
        if (key !== null && armed?.key !== key) {
          arm(key);
          return;
        }
        armed = null;
        held = { answered: placement.answered };
      }
      void placement.commitRoad(target);
      return;
    }
    const lot = pick(at.x, at.y);
    if (lot === null) return;
    placement.hover(lot);
    if (p.touch) {
      // A finger cannot hover, so a demolish takes two taps: the first picks the building, the second takes it down.
      if (placement.tool === 'demolish' && armed?.key !== `lot:${lot}`) {
        arm(`lot:${lot}`);
        return;
      }
      armed = null;
      held = { answered: placement.answered };
    }
    void placement.commit(lot);
  };
  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (press?.id === e.pointerId) press = null;
  };
  /** What a first tap picked and waits to be confirmed on: `lot:7`, `lay:12` (the far end) or `remove:120`. */
  let armed: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** After a tap, the answer to its command ends the ghost a finger left behind. */
  let held: { answered: number } | null = null;
  const disarm = () => {
    if (armed) clearTimeout(armed.timer);
    armed = null;
  };
  const arm = (key: string) => {
    disarm();
    armed = {
      key,
      timer: setTimeout(() => {
        armed = null;
        placement.hover(null);
        placement.hoverRoad(null);
      }, CONFIRM_MS),
    };
  };
  const onLeave = (e: PointerEvent) => {
    // A finger lifting also leaves; the lot it touched keeps its ghost while the command goes through.
    if (e.pointerType !== 'mouse') return;
    pointer = null;
    placement.hover(null);
    placement.hoverRoad(null);
  };
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('pointerleave', onLeave);

  const here = new THREE.Vector3();
  return {
    update() {
      if (placement.tool === 'road' && pointer) placement.hoverRoad(roadTarget(pointer.x, pointer.y));
      else if (placement.tool && pointer) placement.hover(pick(pointer.x, pointer.y));
      if (held && placement.answered > held.answered) {
        held = null;
        if (!pointer) {
          placement.hover(null);
          placement.hoverRoad(null);
        }
      }
      // The city changes under a tool too: a building that has just gone up ends the ghost on its lot.
      draw();
    },
    pick,
    screenOfTile(x, z) {
      here.set(x - half, 0, z - half).project(camera);
      if (Math.abs(here.x) > 1 || Math.abs(here.y) > 1 || here.z > 1) return null;
      const r = dom.getBoundingClientRect();
      return { x: r.left + ((here.x + 1) / 2) * r.width, y: r.top + ((1 - here.y) / 2) * r.height };
    },
    screenOf(lot) {
      const [x, z] = lots.centre(lot);
      const r = dom.getBoundingClientRect();
      // A taller neighbour can stand in front of the middle, so try a few points until the pointer would find the lot.
      for (const [dx, dz, y] of AIMS) {
        here.set(x + dx, y, z + dz).project(camera);
        if (Math.abs(here.x) > 1 || Math.abs(here.y) > 1 || here.z > 1) continue;
        if (pick(here.x, here.y) !== lot) continue;
        return { x: r.left + ((here.x + 1) / 2) * r.width, y: r.top + ((1 - here.y) / 2) * r.height };
      }
      return null;
    },
  };
}
