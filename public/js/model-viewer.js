// Standalone model inspector (model-viewer.html). Renders the CURRENT avatarModel via the shared
// voxel mesher (same mesh as in-game), with drag-to-rotate + wheel-zoom orbit controls so the model
// can be checked from any angle. Iterate avatar.js → reload this page → inspect.

import * as THREE from '../lib/three.module.js';
import { avatarModel } from './avatar.js';
import { buildVoxelGeometry } from './voxmesh.js';

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242c);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);

scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x444a55, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(2.2, 4, 2.6); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera; sc.left = -2; sc.right = 2; sc.top = 2; sc.bottom = -2; sc.near = 0.1; sc.far = 14;
scene.add(sun); scene.add(sun.target);

const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshLambertMaterial({ color: 0x2a2f38 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
scene.add(new THREE.GridHelper(4, 16, 0x3a4150, 0x2c313a));

let skin = { b: 1, t: 5, p: 3, k: 1 };
let mesh = null, wire = false;
function rebuild() {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  const model = avatarModel(skin);
  const geo = buildVoxelGeometry(model.boxes);
  mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, wireframe: wire }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  const tris = geo.getAttribute('position').count / 3;
  document.getElementById('stat').textContent = `三角形 ${tris} · 高 ${model.h} 体素 · 盒子 ${model.boxes.length}`;
}
rebuild();

// orbit: spherical camera around the model's mid-height
let theta = 0.6, phi = 1.25, radius = 2.8;
const target = new THREE.Vector3(0, 0.9, 0);
function updateCam() {
  phi = Math.max(0.12, Math.min(Math.PI - 0.12, phi));
  radius = Math.max(0.9, Math.min(8, radius));
  camera.position.set(
    target.x + radius * Math.sin(phi) * Math.sin(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.cos(theta));
  camera.lookAt(target);
}
let dragging = false, lx = 0, ly = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (!dragging) return; theta -= (e.clientX - lx) * 0.01; phi -= (e.clientY - ly) * 0.01; lx = e.clientX; ly = e.clientY; });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('wheel', (e) => { radius *= 1 + Math.sign(e.deltaY) * 0.1; e.preventDefault(); }, { passive: false });

let auto = true;
document.getElementById('btnAuto').onclick = () => { auto = !auto; };
document.getElementById('btnRandom').onclick = () => { skin = { b: Math.random() * 8 | 0, t: Math.random() * 8 | 0, p: Math.random() * 8 | 0, k: Math.random() * 6 | 0 }; rebuild(); };
document.getElementById('btnWire').onclick = () => { wire = !wire; rebuild(); };

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
}
function loop() {
  requestAnimationFrame(loop);
  resize();
  if (auto && !dragging) theta += 0.006;
  updateCam();
  renderer.render(scene, camera);
}
loop();
