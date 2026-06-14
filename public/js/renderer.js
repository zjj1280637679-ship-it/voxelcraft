// Scene / camera / chunk-mesh / avatar owner. One shared material for all
// chunks; geometries are disposed whenever a chunk mesh is rebuilt or removed.
import * as THREE from '../lib/three.module.js';
import { CHUNK, PALETTE, SKIN_TONES, BODIES, chunkKey } from './constants.js';
import { avatarParts } from './avatar.js';
import { buildAtlas } from './textures.js';
import { buildChunkGeometry } from './mesher.js';

const SKY = 0x87ceeb;
const LERP_RATE = 10; // avatar interpolation, ~10/s toward network target

// SHARED skin v2 validation/migration rule (DESIGN.md): v2 {b,t,p,k} in range
// -> copy; legacy {s,p} 0..7 -> {b:1,t:s,p:p,k:1}; else {b:1,t:0,p:0,k:1}.
// Replaces the old id-derived color fallback.
function cleanSkin(skin) {
  if (skin && typeof skin === 'object') {
    const { b, t, p, k } = skin;
    if (
      Number.isInteger(b) && b >= 0 && b < BODIES.length &&
      Number.isInteger(t) && t >= 0 && t < PALETTE.length &&
      Number.isInteger(p) && p >= 0 && p < PALETTE.length &&
      Number.isInteger(k) && k >= 0 && k < SKIN_TONES.length
    ) {
      return { b, t, p, k };
    }
    if (
      Number.isInteger(skin.s) && skin.s >= 0 && skin.s < PALETTE.length &&
      Number.isInteger(skin.p) && skin.p >= 0 && skin.p < PALETTE.length
    ) {
      return { b: 1, t: skin.s, p: skin.p, k: 1 };
    }
  }
  return { b: 1, t: 0, p: 0, k: 1 };
}

function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeNameSprite(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const text = String(name == null ? '' : name).slice(0, 16);
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.min(248, Math.ceil(ctx.measureText(text).width) + 26);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRectPath(ctx, 128 - w / 2, 8, w, 48, 10);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 128, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.renderOrder = 10; // draw over terrain so names stay readable
  return sprite;
}

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 4 * CHUNK * 0.55, 4 * CHUNK * 0.95);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    this.camera.rotation.order = 'YXZ'; // yaw around Y, then pitch around X

    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x7a6a52, 0.9);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(60, 100, 40); // constant direction toward origin
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    // Dynamic soft shadows — OFF until quality (光追) turns them on. The shadow camera is an
    // orthographic box that follows the player (see render()); map size scales the GPU cost from
    // cheap (1024) to brutal (4096), which is exactly the knob to "crank to this machine's limit".
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sun.castShadow = false;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 1.2;       // blocky unit cubes → bias along the normal kills acne
    const sc = sun.shadow.camera;
    sc.left = -64; sc.right = 64; sc.top = 64; sc.bottom = -64; sc.near = 1; sc.far = 280;
    sc.updateProjectionMatrix();

    this.atlas = buildAtlas();
    this.material = new THREE.MeshLambertMaterial({
      map: this.atlas.texture,
      vertexColors: true,
    });

    this.chunkMeshes = new Map(); // chunkKey -> THREE.Mesh
    this.players = new Map();     // id -> avatar record

    const boxGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
    const edges = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x111111 })
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this._lastTime = performance.now();
    this._renderScale = 1;       // client render-scale (presentation, set by clientconfig)
    this.resize();
    console.log('[vc] renderer initialized');
  }

  setFogForRadius(radiusChunks) {
    this.scene.fog.near = radiusChunks * CHUNK * 0.55;
    this.scene.fog.far = radiusChunks * CHUNK * 0.95;
  }

  updateChunk(world, cx, cz) {
    const key = chunkKey(cx, cz);
    const geo = buildChunkGeometry(world, cx, cz, this.atlas.tileUV);
    const existing = this.chunkMeshes.get(key);
    if (existing) {
      existing.geometry.dispose();
      if (geo) {
        existing.geometry = geo;
      } else {
        this.scene.remove(existing);
        this.chunkMeshes.delete(key);
      }
      return;
    }
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = true; mesh.receiveShadow = true;   // terrain self-shadows + catches creature shadows
    mesh.position.set(cx * CHUNK, 0, cz * CHUNK);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }

  removeChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const mesh = this.chunkMeshes.get(key);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.chunkMeshes.delete(key);
  }

  hasChunk(cx, cz) {
    return this.chunkMeshes.has(chunkKey(cx, cz));
  }

  setHighlight(posOrNull) {
    if (!posOrNull) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.position.set(posOrNull.x + 0.5, posOrNull.y + 0.5, posOrNull.z + 0.5);
    this.highlight.visible = true;
  }

  // skin v2 {b,t,p,k}; legacy {s,p} payloads are migrated, anything else
  // collapses to the default skin (shared rule, see cleanSkin).
  addPlayer(id, name, skin, scale = 1) {
    if (this.players.has(id)) this.removePlayer(id);
    const parts = avatarParts(cleanSkin(skin));   // the UNIFIED avatar spec (shared with the menu 2D preview)

    const group = new THREE.Group();
    const geos = [], mats = [];
    // 3D backend: turn each spec box into a Three.js mesh. `parent:'head'` parts attach to the head
    // (head-local = world − head pos) so they tilt with a pitch look; the rest sit on the group.
    let head = null, topY = 0;
    const headSpec = parts.find((q) => q.id === 'head');
    for (const q of parts) {
      const g = new THREE.BoxGeometry(q.sx, q.sy, q.sz);
      const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(q.color) });
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true; mesh.receiveShadow = true;
      geos.push(g); mats.push(m);
      if (q.parent === 'head' && head) {
        mesh.position.set(q.x - headSpec.x, q.y - headSpec.y, q.z - headSpec.z);
        head.add(mesh);
      } else {
        mesh.position.set(q.x, q.y, q.z);
        group.add(mesh);
        if (q.id === 'head') head = mesh;
      }
      topY = Math.max(topY, q.y + q.sy / 2);
    }

    const sprite = makeNameSprite(name);
    sprite.position.y = topY + 0.32;
    group.add(sprite);

    if (scale !== 1) {
      group.scale.setScalar(scale);                  // per-creature size (present facet)
      sprite.scale.set(1.6 / scale, 0.4 / scale, 1); // counter-scale so the name stays legible
    }

    group.position.set(8, 40, 8); // server default until first pmove
    this.scene.add(group);

    this.players.set(id, {
      group,
      head,
      sprite,
      targetPos: group.position.clone(),
      targetRy: 0,
      targetRx: 0,
      initialized: false,
      geos,
      mats,
    });
  }

  updatePlayer(id, p, ry, rx) {
    const pl = this.players.get(id);
    if (!pl) return;
    if (Array.isArray(p)) pl.targetPos.set(p[0], p[1], p[2]);
    else if (p) pl.targetPos.set(p.x, p.y, p.z);
    // Defense in depth: `|| 0` passes Infinity/strings, which NaN the group
    // matrix forever once integrated via angleDelta. Require finite numbers.
    pl.targetRy = Number.isFinite(ry) ? ry : 0;
    pl.targetRx = Number.isFinite(rx) ? rx : 0;
    if (!pl.initialized) {
      // snap on first network sample to avoid a long fly-in lerp
      pl.initialized = true;
      pl.group.position.copy(pl.targetPos);
      pl.group.rotation.y = pl.targetRy;
      pl.head.rotation.x = pl.targetRx;
    }
  }

  removePlayer(id) {
    const pl = this.players.get(id);
    if (!pl) return;
    this.scene.remove(pl.group);
    for (const g of pl.geos) g.dispose();
    for (const m of pl.mats) m.dispose();
    pl.sprite.material.map.dispose();
    pl.sprite.material.dispose();
    this.players.delete(id);
  }

  render(eyePos, yaw, pitch) {
    const now = performance.now();
    const dt = Math.min((now - this._lastTime) / 1000, 0.1);
    this._lastTime = now;
    const k = 1 - Math.exp(-LERP_RATE * dt);

    for (const pl of this.players.values()) {
      pl.group.position.lerp(pl.targetPos, k);
      pl.group.rotation.y += angleDelta(pl.group.rotation.y, pl.targetRy) * k;
      pl.head.rotation.x += (pl.targetRx - pl.head.rotation.x) * k;
    }

    // keep the orthographic shadow box centred on the player so shadows cover the visible area
    if (this.renderer.shadowMap.enabled) {
      this.sun.position.set(eyePos.x + 55, eyePos.y + 58, eyePos.z + 30); // raking angle → long, readable shadows
      this.sun.target.position.set(eyePos.x, eyePos.y, eyePos.z);
      this.sun.target.updateMatrixWorld();
    }

    this.camera.position.set(eyePos.x, eyePos.y, eyePos.z);
    this.camera.rotation.set(pitch, yaw, 0); // YXZ order matches yaw/pitch contract
    this.renderer.render(this.scene, this.camera);
  }

  // Quality knobs the clientconfig drives. `shadows` (光追) = dynamic soft shadows + max anisotropy;
  // `shadowSize` scales the shadow-map cost (1024 cheap … 4096 brutal). Toggling needs a 1-time
  // material recompile (needsUpdate). All presentation — never touches the sim.
  setQuality(shadows, shadowSize) {
    const on = !!shadows;
    if (this.renderer.shadowMap.enabled !== on) {
      this.renderer.shadowMap.enabled = on;
      this.sun.castShadow = on;
      this.hemi.intensity = on ? 0.5 : 0.9;   // dim the sky fill so shadows actually read
      this.sun.intensity = on ? 1.7 : 1.3;
      this.material.needsUpdate = true;
      for (const pl of this.players.values()) for (const m of pl.mats) m.needsUpdate = true;
      const aniso = on ? this.renderer.capabilities.getMaxAnisotropy() : 1;
      if (this.atlas && this.atlas.texture) { this.atlas.texture.anisotropy = aniso; this.atlas.texture.needsUpdate = true; }
    }
    if (on && shadowSize && this.sun.shadow.mapSize.x !== shadowSize) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * this._renderScale);
    this.renderer.setSize(w, h, false);
  }

  // Presentation-local render resolution multiplier (0.25..2). Applied via the drawing-buffer
  // pixel ratio; cheap, live, and observable. Driven by clientconfig (never the sim).
  setRenderScale(s) {
    const c = Math.max(0.25, Math.min(2, s || 1));
    if (c === this._renderScale) return;
    this._renderScale = c;
    this.resize();
  }
}
