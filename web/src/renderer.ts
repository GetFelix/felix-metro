import * as THREE from 'three';
import type { Tier } from './params';
import { settingsFor } from './quality';

export function createRenderer(tier: Tier) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, settingsFor(tier).pixelRatioCap));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = settingsFor(tier).shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.prepend(renderer.domElement);
  return renderer;
}
