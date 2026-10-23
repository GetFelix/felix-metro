import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Tier } from './params';

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

export function createRenderer(tier: Tier) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, tier === 'low' ? 1 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = tier !== 'low';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.prepend(renderer.domElement);
  return renderer;
}

// Ambient occlusion (high tier), bloom, tilt-shift blur, tone mapping, then a small grade.
export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  tier: Tier,
  glows: THREE.Object3D[],
) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (tier === 'high') {
    const ao = withSeededRandom(() => new GTAOPass(scene, camera, innerWidth, innerHeight));
    ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.0, scale: 1.0 });
    ao.blendIntensity = 0.85;
    const render = ao.render.bind(ao);
    ao.render = (...args: Parameters<typeof render>) => {
      const shown = glows.map((g) => g.visible);
      glows.forEach((g) => (g.visible = false));
      render(...args);
      glows.forEach((g, i) => (g.visible = shown[i]!));
    };
    composer.addPass(ao);
  }
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.45, 1.0);
  composer.addPass(bloom);

  // Tilt-shift as a miniature photo: blur grows with distance from the focus plane through the orbit target, so
  // anything at that depth, however tall, stays sharp.
  const depthRT = new THREE.WebGLRenderTarget(innerWidth, innerHeight);
  depthRT.depthTexture = new THREE.DepthTexture(innerWidth, innerHeight);
  const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const TiltShift = {
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: depthRT.depthTexture },
      resolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
      cameraNear: { value: camera.near },
      cameraFar: { value: camera.far },
      focus: { value: 19 },
      band: { value: 2.2 },
      range: { value: 9.0 },
      amount: { value: tier === 'low' ? 0 : 7.0 },
    },
    vertexShader:
      'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse, tDepth; uniform vec2 resolution;
    uniform float cameraNear, cameraFar, focus, band, range, amount; varying vec2 vUv;
    float dist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    void main() {
      float r = amount * smoothstep(0.0, range, abs(dist(vUv) - focus) - band);
      if (r < 0.01) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
      vec4 sum = vec4(0.0); float w = 0.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(float(i) / 12.0) * r / resolution;
        // A sharp foreground pixel must not bleed into a blurred one behind it.
        float rr = amount * smoothstep(0.0, range, abs(dist(vUv + o) - focus) - band);
        float k = clamp(rr / max(r, 0.001), 0.25, 1.0);
        sum += texture2D(tDiffuse, vUv + o) * k; w += k;
      }
      gl_FragColor = sum / w;
    }`,
  };
  const tilt = new ShaderPass(TiltShift);
  composer.addPass(tilt);
  composer.addPass(new OutputPass());

  // Grade after tone mapping: a little saturation and a soft vignette.
  const Grade = {
    uniforms: { tDiffuse: { value: null }, saturation: { value: 1.12 }, vignette: { value: 0.28 } },
    vertexShader: TiltShift.vertexShader,
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
  };
  composer.addPass(new ShaderPass(Grade));

  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    tilt.uniforms.resolution!.value.set(innerWidth, innerHeight);
    depthRT.setSize(innerWidth, innerHeight);
  }

  return { composer, bloom, tilt, depthRT, depthMat, resize };
}
