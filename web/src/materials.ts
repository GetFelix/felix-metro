import * as THREE from 'three';
import { PALETTE, ROOFS, WALLS } from './palette';
import type { Pack } from './assets';

// Pixels of a copy of the colormap, to be rewritten and turned back into a texture.
function colormapCopy(tex: THREE.Texture) {
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  return { c, g, d: g.getImageData(0, 0, c.width, c.height) };
}

// Windows are the light-blue swatches of Kenney's colormap. A copy of the colormap with only those swatches kept
// becomes the emissive map, so lit windows come from the texture the models already use.
function windowMask(tex: THREE.Texture) {
  const { c, g, d } = colormapCopy(tex);
  for (let i = 0; i < d.data.length; i += 4) {
    const [r, gg, b] = [d.data[i]!, d.data[i + 1]!, d.data[i + 2]!];
    const isWindow = b > 170 && b > r + 25 && b >= gg && gg > 150;
    const v = isWindow ? 255 : 0;
    d.data[i] = v;
    d.data[i + 1] = v;
    d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  const m = new THREE.CanvasTexture(c);
  m.flipY = tex.flipY;
  m.colorSpace = THREE.SRGBColorSpace;
  m.magFilter = THREE.NearestFilter;
  return m;
}

// The colormap with its wall swatches and roof swatches tinted from the palette lists.
function variantMap(tex: THREE.Texture, v: number) {
  const { c, g, d } = colormapCopy(tex);
  const wall = new THREE.Color(WALLS[v % WALLS.length]!);
  const roof = new THREE.Color(ROOFS[(v * 3) % ROOFS.length]!);
  for (let i = 0; i < d.data.length; i += 4) {
    const r = d.data[i]!,
      gg = d.data[i + 1]!,
      b = d.data[i + 2]!;
    const mx = Math.max(r, gg, b),
      mn = Math.min(r, gg, b);
    let tint: THREE.Color | null = null,
      k = mx / 255;
    if (mx > 200 && mx - mn < 18) tint = wall;
    else if (gg > r + 40 && gg > b + 10) {
      tint = roof;
      k = 0.55 + 0.6 * (gg / 255);
    }
    if (tint) {
      d.data[i] = Math.min(255, tint.r * 255 * k);
      d.data[i + 1] = Math.min(255, tint.g * 255 * k);
      d.data[i + 2] = Math.min(255, tint.b * 255 * k);
    }
  }
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.flipY = tex.flipY;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.anisotropy = 8;
  return t;
}

export interface TextureBuilders {
  variant(src: THREE.Texture, v: number): THREE.Texture;
  mask(src: THREE.Texture): THREE.Texture;
}

const canvasBuilders: TextureBuilders = { variant: variantMap, mask: windowMask };

// Every model of a pack samples the same colormap, so a variant texture and a window mask are built once per pack
// from whichever model asks first. Materials are shared by (pack, light level, variant, window bucket).
export function createMaterials(build: TextureBuilders = canvasBuilders) {
  const variants = new Map<string, THREE.Texture>();
  const masks = new Map<Pack, THREE.Texture>();
  const shared = new Map<string, THREE.MeshStandardMaterial>();

  function materialFor(pack: Pack, src: THREE.MeshStandardMaterial, lit: number, v = -1, bucket = 0) {
    // Buildings that light up at different hours need different materials; unlit ones all share bucket 0.
    const b = lit > 0 ? bucket : 0;
    const key = `${pack}:${lit}:${v}:${b}`;
    let m = shared.get(key);
    if (!m) {
      let map = src.map!;
      if (v >= 0) {
        const vk = `${pack}:${v}`;
        if (!variants.has(vk)) variants.set(vk, build.variant(map, v));
        map = variants.get(vk)!;
      }
      map.magFilter = THREE.NearestFilter;
      map.anisotropy = 8;
      m = new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0.0, envMapIntensity: 0.45 });
      if (lit > 0) {
        // From the original colormap: a recoloured wall can look like glass.
        if (!masks.has(pack)) masks.set(pack, build.mask(src.map!));
        m.emissiveMap = masks.get(pack)!;
        m.emissive = PALETTE.window.clone();
        m.userData.lit = lit;
        m.userData.bucket = b;
      }
      shared.set(key, m);
    }
    return m;
  }

  const lit = () => [...shared.values()].filter((m) => m.userData.lit);

  return { materialFor, lit };
}
