import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { passesFor, without, type PassName } from './passes';

export { passesFor, without, type PassName };

const VERTEX =
  'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

// GTAOPass builds its noise texture from Math.random; seeding it keeps the ambient occlusion the same on every load.
function withSeededRandom<T>(make: () => T): T {
  const original = Math.random;
  let a = 1;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return make();
  } finally {
    Math.random = original;
  }
}

// Builds the composer from an ordered pass list; see passes.ts for what each tier runs. Only the listed passes are
// built, and dispose() frees everything this created so a tier change can rebuild the chain.
export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  passes: readonly PassName[],
  glows: THREE.Object3D[],
) {
  const composer = new EffectComposer(renderer);
  const has = (n: PassName) => passes.includes(n);

  // Runs every frame, so the visibility buffer and the restore function are made once.
  const shown = new Uint8Array(glows.length);
  const restore = () => {
    for (let i = 0; i < glows.length; i++) glows[i]!.visible = shown[i] === 1;
  };
  const hide = () => {
    for (let i = 0; i < glows.length; i++) {
      shown[i] = glows[i]!.visible ? 1 : 0;
      glows[i]!.visible = false;
    }
    return restore;
  };

  if (has('render')) composer.addPass(new RenderPass(scene, camera));
  if (has('ao')) {
    const ao = withSeededRandom(() => new GTAOPass(scene, camera, innerWidth, innerHeight));
    ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.0, scale: 1.0 });
    ao.blendIntensity = 0.85;
    const render = ao.render.bind(ao);
    ao.render = (...args: Parameters<typeof render>) => {
      const show = hide();
      render(...args);
      show();
    };
    composer.addPass(ao);
  }
  let bloom: UnrealBloomPass | null = null;
  if (has('bloom')) {
    bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.45, 1.0);
    composer.addPass(bloom);
  }

  // Distance haze: nothing is blurred up to the focus plane through the orbit target plus a wide sharp band, then the
  // blur grows toward the horizon. Nothing in front of the focus is ever blurred.
  let tilt: ShaderPass | null = null;
  let depthRT: THREE.WebGLRenderTarget | null = null;
  let depthMat: THREE.MeshBasicMaterial | null = null;
  if (has('tilt-shift')) {
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight);
    rt.depthTexture = new THREE.DepthTexture(innerWidth, innerHeight);
    depthRT = rt;
    depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    tilt = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: rt.depthTexture },
        resolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
        focus: { value: 19 },
        band: { value: 25.0 },
        range: { value: 40.0 },
        amount: { value: 3.5 },
      },
      vertexShader: VERTEX,
      fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse, tDepth; uniform vec2 resolution;
    uniform float cameraNear, cameraFar, focus, band, range, amount; varying vec2 vUv;
    float dist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    void main() {
      float r = amount * smoothstep(0.0, range, dist(vUv) - focus - band);
      if (r < 0.01) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
      vec4 sum = vec4(0.0); float w = 0.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(float(i) / 12.0) * r / resolution;
        // A sharp foreground pixel must not bleed into a blurred one behind it.
        float rr = amount * smoothstep(0.0, range, dist(vUv + o) - focus - band);
        float k = clamp(rr / max(r, 0.001), 0.25, 1.0);
        sum += texture2D(tDiffuse, vUv + o) * k; w += k;
      }
      gl_FragColor = sum / w;
    }`,
    });
    composer.addPass(tilt);
  }
  if (has('output')) composer.addPass(new OutputPass());

  // Grade after tone mapping: a little saturation and a soft vignette.
  if (has('grade')) {
    composer.addPass(
      new ShaderPass({
        uniforms: { tDiffuse: { value: null }, saturation: { value: 1.12 }, vignette: { value: 0.28 } },
        vertexShader: VERTEX,
        fragmentShader: `
    uniform sampler2D tDiffuse; uniform float saturation, vignette; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      float v = smoothstep(0.85, 0.25, distance(vUv, vec2(0.5)));
      c.rgb *= mix(1.0 - vignette, 1.0, v);
      gl_FragColor = c;
    }`,
      }),
    );
  }

  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    tilt?.uniforms.resolution!.value.set(innerWidth, innerHeight);
    depthRT?.setSize(innerWidth, innerHeight);
  }

  // The focus follows the orbit target every frame; the depth pre-pass runs only when tilt-shift does.
  function render(target: THREE.Vector3) {
    if (tilt && depthRT && depthMat) {
      const show = hide();
      scene.overrideMaterial = depthMat;
      renderer.setRenderTarget(depthRT);
      // A throw here must not leave the depth material or the hidden glows behind for every later frame.
      try {
        renderer.render(scene, camera);
      } finally {
        renderer.setRenderTarget(null);
        scene.overrideMaterial = null;
        show();
      }
      const focus = camera.position.distanceTo(target);
      tilt.uniforms.focus!.value = focus;
      // The sharp band grows with the zoom, so a far camera over a big city keeps most of it sharp.
      tilt.uniforms.band!.value = focus + 6;
    }
    composer.render();
  }

  function dispose() {
    for (const pass of composer.passes) pass.dispose();
    composer.dispose();
    depthRT?.depthTexture?.dispose();
    depthRT?.dispose();
    depthMat?.dispose();
  }

  return { bloom, render, resize, dispose };
}
