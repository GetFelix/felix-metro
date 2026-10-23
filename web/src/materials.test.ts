import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createMaterials, type TextureBuilders } from './materials';

function counting() {
  const count = { variant: 0, mask: 0 };
  const build: TextureBuilders = {
    variant: () => (count.variant++, new THREE.Texture()),
    mask: () => (count.mask++, new THREE.Texture()),
  };
  // Each model of a pack arrives with its own copy of the colormap texture.
  const source = () => new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  return { count, build, source };
}

describe('createMaterials', () => {
  it('builds each variant texture once per pack, however many models and placements use it', () => {
    const { count, build, source } = counting();
    const { materialFor } = createMaterials(build);
    for (let model = 0; model < 5; model++) {
      const src = source();
      for (const v of [0, 1, 2, 0, 1, 2]) for (const lit of [0, 1]) materialFor('commercial', src, lit, v);
    }
    expect(count.variant).toBe(3);
    materialFor('suburban', source(), 0, 0);
    expect(count.variant).toBe(4);
  });

  it('builds the window mask once per pack, shared by every lit material', () => {
    const { count, build, source } = counting();
    const { materialFor } = createMaterials(build);
    const lit = [0.3, 0.6, 1, 1.4].flatMap((l) => [0, 1, 2].map((v) => materialFor('commercial', source(), l, v)));
    materialFor('commercial', source(), 0, 1);
    expect(count.mask).toBe(1);
    expect(new Set(lit.map((m) => m.emissiveMap)).size).toBe(1);
    materialFor('industrial', source(), 1);
    expect(count.mask).toBe(2);
  });

  it('shares one material per pack, light level and variant', () => {
    const { build, source } = counting();
    const { materialFor, lit } = createMaterials(build);
    expect(materialFor('cars', source(), 0)).toBe(materialFor('cars', source(), 0));
    expect(materialFor('cars', source(), 1)).not.toBe(materialFor('cars', source(), 0));
    expect(lit()).toHaveLength(1);
  });

  it('splits lit materials by window bucket and shares unlit ones across buckets', () => {
    const { build, source } = counting();
    const { materialFor, lit } = createMaterials(build);
    expect(materialFor('commercial', source(), 1, 0, 0)).not.toBe(materialFor('commercial', source(), 1, 0, 3));
    expect(materialFor('commercial', source(), 1, 0, 3)).toBe(materialFor('commercial', source(), 1, 0, 3));
    expect(materialFor('commercial', source(), 0, 0, 3)).toBe(materialFor('commercial', source(), 0, 0, 5));
    expect(lit().map((m) => m.userData.bucket)).toEqual([0, 3]);
  });
});
