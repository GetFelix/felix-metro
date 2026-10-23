import * as THREE from 'three';
import type { Tier } from './params';

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
