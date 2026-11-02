// How a tool's preview looks: a building drawn see-through in the colour that says whether it can go there, and a
// marker on the lot. The colours are the overlay's own (ui/kit.css).
import * as THREE from 'three';

const FITS = new THREE.Color('hsl(192, 90%, 46%)');
const CLASH = new THREE.Color('#ff6038');
const DOOMED = new THREE.Color('#ffbe3c');

const material = (color: THREE.Color, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false });

// Lit, so the shape reads as a building and not a silhouette, and a little self-lit so shade does not hide the colour.
const ghost = (color: THREE.Color) =>
  new THREE.MeshLambertMaterial({
    color,
    emissive: color.clone().multiplyScalar(0.35),
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
const GHOST = { fits: ghost(FITS), clash: ghost(CLASH) };

/** Draw every mesh under `root` as a see-through ghost, in the colour for a building that fits or one that does not. */
export function tintGhost(root: THREE.Object3D, fits: boolean): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = fits ? GHOST.fits : GHOST.clash;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
}

/** What the marker on a lot says. */
export type Mark = 'fits' | 'clash' | 'demolish';

const COLOR: Record<Mark, THREE.Color> = { fits: FITS, clash: CLASH, demolish: DOOMED };

/**
 * A flat tile on the ground for the lot under the pointer, and a box round a building about to come down. One of each,
 * moved from lot to lot.
 */
export function createMarker(scene: THREE.Scene) {
  const tile = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), material(FITS, 0.35));
  tile.rotation.x = -Math.PI / 2;
  tile.position.y = 0.03;
  tile.renderOrder = 10;
  tile.visible = false;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(DOOMED, 0.3));
  box.renderOrder = 10;
  box.visible = false;
  scene.add(tile, box);
  const bounds = new THREE.Box3();
  return {
    /** Put the marker on the lot at world (x, z); `around` are the objects of the building to box for a demolish. */
    show(x: number, z: number, mark: Mark, around: readonly THREE.Object3D[] = []) {
      (tile.material as THREE.MeshBasicMaterial).color.copy(COLOR[mark]);
      tile.position.set(x, 0.03, z);
      tile.visible = true;
      box.visible = false;
      if (mark !== 'demolish' || around.length === 0) return;
      bounds.makeEmpty();
      for (const o of around) bounds.expandByObject(o);
      if (bounds.isEmpty()) return;
      const size = bounds.getSize(new THREE.Vector3());
      box.scale.set(size.x + 0.04, size.y + 0.04, size.z + 0.04);
      bounds.getCenter(box.position);
      box.visible = true;
    },
    hide() {
      tile.visible = false;
      box.visible = false;
    },
  };
}
