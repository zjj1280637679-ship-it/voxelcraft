// menubg.js — entry-page background renderer (DESIGN.md §B). A low-fi
// postcard of the seeded world: small terrain patch generated once at start,
// slow orbiting camera, binding low resolution (pixelRatio <= 0.75).
// Total failure containment: every exception stays inside this module — on
// failure startMenuBg logs one '[vc] menubg failed' line and returns a no-op
// handle, letting the CSS gradient behind the canvas show through.

import * as THREE from '../lib/three.module.js';
import { CHUNK } from './constants.js';
import { World } from './world.js';
import { buildAtlas } from './textures.js';
import { buildChunkGeometry } from './mesher.js';

const SKY = 0x87ceeb;
const RADIUS = 3;          // chunks around the center column — postcard, not gameplay
const ORBIT_SPEED = 0.05;  // rad/s — slow drift
const ORBIT_DIST = 34;     // camera distance from the center column
const DEFAULT_SEED = 1337;

export function startMenuBg(canvas, seed) {
  try {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('no canvas');
    }
    const s = Number.isFinite(seed) ? Math.floor(seed) : DEFAULT_SEED;
    return start(canvas, s);
  } catch (err) {
    console.log('[vc] menubg failed:', err && err.message);
    return { stop() {} };
  }
}

function start(canvas, seed) {
  // GL resources created so far. If setup throws partway, the catch at the
  // bottom disposes them — the no-op handle startMenuBg returns on failure
  // could never free them, so the context/buffers would otherwise leak.
  let renderer = null;
  let material = null;
  let atlas = null;
  const geos = [];
  let resizeHandler = null;
  try {

  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 0.75));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, ORBIT_DIST + CHUNK, ORBIT_DIST + RADIUS * CHUNK * 1.8);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x7a6a52, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(60, 100, 40);
  scene.add(sun);

  atlas = buildAtlas();
  material = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    vertexColors: true,
  });

  // Generate the whole postcard area up front — no per-frame chunk work.
  const world = new World(seed);
  while (world.ensureAround(8, 8, RADIUS, 16) > 0) { /* generate all */ }
  const meshes = [];
  for (const key of world.dirty) {
    const comma = key.indexOf(',');
    const cx = +key.slice(0, comma);
    const cz = +key.slice(comma + 1);
    const geo = buildChunkGeometry(world, cx, cz, atlas.tileUV);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(cx * CHUNK, 0, cz * CHUNK);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    geos.push(geo);
    meshes.push(mesh);
  }
  world.dirty.clear();

  const cy = world.surfaceHeight(8, 8);
  const center = new THREE.Vector3(8.5, cy + 2, 8.5);

  let rafId = null;
  let stopped = false;

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  resizeHandler = resize;
  window.addEventListener('resize', resize);
  resize();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    window.removeEventListener('resize', resize);
    try {
      for (const m of meshes) scene.remove(m);
      for (const g of geos) g.dispose();
      material.dispose();
      atlas.texture.dispose();
      renderer.dispose();
      // Drop the GL context promptly — a game session is usually about to
      // claim its own context on #gameCanvas.
      if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
    } catch (err) { /* disposal must never throw into main.js */ }
    console.log('[vc] menubg stopped');
  };

  const t0 = performance.now();
  const frame = (now) => {
    if (stopped) return;
    rafId = requestAnimationFrame(frame);
    try {
      const a = ((now - t0) / 1000) * ORBIT_SPEED;
      camera.position.set(
        center.x + Math.cos(a) * ORBIT_DIST,
        cy + 16 + Math.sin(a * 0.5) * 3,
        center.z + Math.sin(a) * ORBIT_DIST
      );
      camera.lookAt(center);
      renderer.render(scene, camera);
    } catch (err) {
      // Context loss or a poisoned scene would throw every frame: log once,
      // tear down, and let the CSS gradient take over.
      console.log('[vc] menubg failed:', err && err.message);
      stop();
    }
  };
  rafId = requestAnimationFrame(frame);

  console.log('[vc] menubg started, seed', seed);
  return { stop };

  } catch (err) {
    // Partial setup failed: free everything created before the throw, then
    // rethrow so startMenuBg logs '[vc] menubg failed' and returns the no-op
    // handle. Disposal itself must never throw into main.js.
    try {
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      for (const g of geos) g.dispose();
      if (material) material.dispose();
      if (atlas && atlas.texture) atlas.texture.dispose();
      if (renderer) {
        renderer.dispose();
        if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
      }
    } catch (e2) { /* best-effort cleanup */ }
    throw err;
  }
}
