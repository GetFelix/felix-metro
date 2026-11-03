// The sea and the beach, drawn from the coast texture (see coast.ts). The water is one mesh with one material: the
// shader cuts the coast out of it, shades it by depth, and on the tiers that can afford it adds ripples, a soft sky
// sheen at a grazing view and a line of foam. The ground's material gets the beach from the same texture.
import * as THREE from 'three';
import { waterGeometry, type Coast } from './coast';
import type { City } from './layout';
import { PALETTE } from './palette';

// The ground and the water read one texture, uploaded once.
const textures = new WeakMap<Coast, THREE.DataTexture>();
const shared = (c: Coast) => {
  if (!textures.has(c)) textures.set(c, coastTexture(c));
  return {
    uCoast: { value: textures.get(c)! },
    uCoastRect: { value: new THREE.Vector2(c.origin, c.extent) },
  };
};

function coastTexture(c: Coast): THREE.DataTexture {
  const texture = new THREE.DataTexture(c.data, c.size, c.size, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const VERTEX_HEAD = /* glsl */ `
varying vec2 vShoreXZ;
`;
const VERTEX_MAIN = /* glsl */ `
vShoreXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
`;
const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D uCoast;
uniform vec2 uCoastRect;
varying vec2 vShoreXZ;
vec4 shoreAt() {
  return texture2D(uCoast, (vShoreXZ - vec2(uCoastRect.x)) / uCoastRect.y);
}
`;

/** Patches `material` so the ground turns to sand toward the water, darker where the waves wet it. */
export function beachGround(material: THREE.MeshStandardMaterial, coast: Coast): void {
  const grass = new THREE.Color(PALETTE.grass);
  const sand = new THREE.Color(PALETTE.sand);
  // A ratio, so the sand follows the grass through the day and night colours the scene gives the ground.
  const tint = new THREE.Vector3(sand.r / grass.r, sand.g / grass.g, sand.b / grass.b);
  const uniforms = { ...shared(coast), uSandTint: { value: tint } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}\nuniform vec3 uSandTint;`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec4 shore = shoreAt();
        float beach = smoothstep(0.26, 0.6, shore.g);
        float wetted = smoothstep(0.0, 0.5, shore.r);
        diffuseColor.rgb *= mix(vec3(1.0), uSandTint, beach) * (1.0 - 0.3 * wetted);`,
      );
  };
  material.customProgramCacheKey = () => 'beach-ground';
}

export interface Water {
  mesh: THREE.Mesh;
  /** The waves' clock in seconds; 0 holds them still. */
  setTime(seconds: number): void;
  /** The colour of the sky the water catches at a grazing angle. */
  setSky(sky: THREE.Color, strength: number): void;
  /** Ripples, the sky sheen, foam and shading by depth. Off, the water is its flat colour. */
  setDetail(on: boolean): void;
}

/** The sea of `city`: its water tiles and the open sea past the shore's edge, in one mesh. */
export function createWater(city: City, coast: Coast, reach: number): Water {
  const uniforms = {
    ...shared(coast),
    uTime: { value: 0 },
    uDetail: { value: 1 },
    uSky: { value: new THREE.Color(PALETTE.shallow) },
    uShallow: { value: new THREE.Color(PALETTE.shallow) },
    uDeep: { value: new THREE.Color(PALETTE.deep) },
    uFoam: { value: new THREE.Color(PALETTE.foam) },
  };
  // Mostly diffuse: a rough, non-metal surface with little of the environment (scene.ts gives it the map, so the
  // intensity below applies), so it reads as water and not a mirror.
  const material = new THREE.MeshStandardMaterial({
    color: PALETTE.water,
    roughness: 0.42,
    metalness: 0,
    envMapIntensity: 0.1,
    transparent: true,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${FRAGMENT_HEAD}
        uniform float uTime;
        uniform float uDetail;
        uniform vec3 uSky;
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        uniform vec3 uFoam;`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec4 shore = shoreAt();
        float level = shore.r;
        float soft = max(fwidth(level), 0.002);
        float cover = smoothstep(0.5 - soft, 0.5 + soft, level);
        if (cover < 0.004) discard;
        if (uDetail > 0.5) {
          diffuseColor.rgb = mix(uShallow, uDeep, smoothstep(0.55, 1.0, shore.b));
          float lap = 0.55 + 0.45 * sin(level * 55.0 - uTime * 1.2 + vShoreXZ.x * 1.7 + vShoreXZ.y * 1.1);
          float foam = (1.0 - smoothstep(0.0, 0.16, level - 0.5)) * lap;
          diffuseColor.rgb = mix(diffuseColor.rgb, uFoam, foam * 0.6);
        }
        diffuseColor.a *= cover;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        if (uDetail > 0.5) {
          vec2 p = vShoreXZ;
          vec2 k1 = vec2(2.3, 1.1);
          vec2 k2 = vec2(-1.4, 2.9);
          vec2 k3 = vec2(4.1, -3.2);
          vec2 slope = k1 * (0.5 * cos(dot(p, k1) + uTime * 0.8))
            + k2 * (0.35 * cos(dot(p, k2) + uTime * 1.1))
            + k3 * (0.25 * cos(dot(p, k3) - uTime * 1.5));
          normal = normalize((viewMatrix * vec4(normalize(vec3(-slope.x * 0.025, 1.0, -slope.y * 0.025)), 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        if (uDetail > 0.5) {
          float sheen = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 3.0);
          outgoingLight += uSky * sheen * 0.55;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'sea';

  const mesh = new THREE.Mesh(waterGeometry(city, reach), material);
  mesh.receiveShadow = true;
  return {
    mesh,
    setTime: (seconds) => (uniforms.uTime.value = seconds),
    setSky: (sky, strength) => uniforms.uSky.value.copy(sky).multiplyScalar(strength),
    setDetail: (on) => (uniforms.uDetail.value = on ? 1 : 0),
  };
}
