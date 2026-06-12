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

// Warm-sunset palette: purple zenith fading to a #ff9a5a-family horizon; the
// fog sits in the same family so terrain melts into the horizon band.
const SKY_TOP = '#4b3470';      // zenith — dusk purple
const SKY_MID = '#9a5a78';      // mid sky — mauve
const SKY_LOW = '#e8824e';      // lower sky — ember orange
const SKY_HORIZON = '#ff9a5a';  // horizon — warm orange
const FOG = 0xf99355;           // between SKY_LOW and SKY_HORIZON
const RADIUS = 3;          // chunks around the center column — postcard, not gameplay
const ORBIT_SPEED = 0.05;  // rad/s — slow drift
const ORBIT_DIST = 34;     // camera distance from the center column
const DEFAULT_SEED = 1337;

// Screen-space vertical gradient used as scene.background (three stretches a
// plain 2D texture across the viewport — no extra geometry needed).
function buildSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, SKY_TOP);
  grad.addColorStop(0.45, SKY_MID);
  grad.addColorStop(0.75, SKY_LOW);
  grad.addColorStop(1, SKY_HORIZON);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

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
  let skyTex = null;
  const geos = [];
  let resizeHandler = null;
  try {

  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 0.75));

  const scene = new THREE.Scene();
  skyTex = buildSkyTexture();
  scene.background = skyTex;
  scene.fog = new THREE.Fog(FOG, ORBIT_DIST + CHUNK, ORBIT_DIST + RADIUS * CHUNK * 1.8);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  // Late-afternoon light: warm sky dome over warm brown bounce, and a low
  // amber sun so faces catch long sunset light instead of noon white.
  scene.add(new THREE.HemisphereLight(0xffd9a6, 0x6b4a3a, 0.85));
  const sun = new THREE.DirectionalLight(0xffb070, 1.05);
  sun.position.set(80, 35, -60);
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
      skyTex.dispose();
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
      if (skyTex) skyTex.dispose();
      if (renderer) {
        renderer.dispose();
        if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
      }
    } catch (e2) { /* best-effort cleanup */ }
    throw err;
  }
}
