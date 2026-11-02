// The building tools on the canvas: the lot under the pointer, its marker and ghost, and the click or tap that uses the
// tool. What the tool does is placement.ts; this finds the lot and draws the answer.
import * as THREE from 'three';
import { isEmpty, kindOn, type Ground } from './build';
import type { LotAccess } from './construction-fx';
import type { City } from './layout';
import { LotGrid, groundPoint, lotsAlong } from './lot-pick';
import { createMarker } from './placement-ghost';
import type { Placement } from './placement';

/** Taller than any building, in tiles: the ray is followed down from here. */
const CEILING = 5;
/** Pixels a press may wander and still be a click; a finger is less steady than a mouse. */
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 12;
/** A press held longer than this is a look around, not a click. */
const CLICK_MS = 600;

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
}

export function createPlacementView(deps: PlacementViewDeps): PlacementView {
  const { dom, camera, placement, lots } = deps;
  const grid = new LotGrid(deps.city.tiles, deps.city.lots);
  const marker = createMarker(deps.scene);
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

  // Redraw the marker and ghost only when what they show changes.
  let shown = '';
  const draw = () => {
    const preview = placement.preview();
    const key = preview ? `${preview.lot}|${preview.tool}|${preview.kind}|${preview.rotation}|${preview.check.ok}` : '';
    if (key === shown) return;
    shown = key;
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
    // A building does not draw over one already standing.
    const kind = kindOn(deps.ground(), preview.lot);
    const bare = kind !== null && isEmpty(kind);
    deps.previewBuilding(
      bare ? preview.lot : null,
      bare ? { kind: preview.kind, rotation: preview.rotation } : null,
      fits,
    );
  };
  placement.onChange(() => {
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
    if (!placement.tool || pointers.size > 1 || (!touch && (e.button !== 0 || e.shiftKey))) {
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
    if (e.pointerType === 'mouse' && e.buttons === 0) pointer = toNdc(e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    const p = press;
    if (!p || p.id !== e.pointerId || !placement.tool) return;
    press = null;
    if (performance.now() - p.at > CLICK_MS) return;
    const at = toNdc(e.clientX, e.clientY);
    const lot = pick(at.x, at.y);
    if (lot === null) return;
    placement.hover(lot);
    void placement.commit(lot);
  };
  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (press?.id === e.pointerId) press = null;
  };
  const onLeave = (e: PointerEvent) => {
    // A finger lifting also leaves; the lot it touched keeps its ghost while the command goes through.
    if (e.pointerType !== 'mouse') return;
    pointer = null;
    placement.hover(null);
  };
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('pointerleave', onLeave);

  const here = new THREE.Vector3();
  return {
    update() {
      if (placement.tool && pointer) placement.hover(pick(pointer.x, pointer.y));
      // The city changes under a tool too: a building that has just gone up ends the ghost on its lot.
      draw();
    },
    pick,
    screenOf(lot) {
      const [x, z] = lots.centre(lot);
      here.set(x, 0.3, z).project(camera);
      if (Math.abs(here.x) > 1 || Math.abs(here.y) > 1 || here.z > 1) return null;
      const r = dom.getBoundingClientRect();
      return { x: r.left + ((here.x + 1) / 2) * r.width, y: r.top + ((1 - here.y) / 2) * r.height };
    },
  };
}
