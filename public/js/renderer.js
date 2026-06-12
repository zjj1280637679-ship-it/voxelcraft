// Scene / camera / chunk-mesh / avatar owner. One shared material for all
// chunks; geometries are disposed whenever a chunk mesh is rebuilt or removed.
import * as THREE from '../lib/three.module.js';
import { CHUNK, PALETTE, chunkKey } from './constants.js';
import { buildAtlas } from './textures.js';
import { buildChunkGeometry } from './mesher.js';

const SKY = 0x87ceeb;
const LERP_RATE = 10; // avatar interpolation, ~10/s toward network target
const HEAD_COLOR = '#e0ac69'; // fixed skin tone for every avatar head

function validPaletteIndex(v) {
  return Number.isInteger(v) && v >= 0 && v < PALETTE.length;
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

    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x7a6a52, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(60, 100, 40); // constant direction toward origin
    this.scene.add(sun);

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

  // skin = {s, p} PALETTE indices (shirt/pants). Invalid or missing skins
  // fall back to a stable id-derived pair so old payloads still render.
  addPlayer(id, name, skin) {
    if (this.players.has(id)) this.removePlayer(id);
    let s, p;
    if (skin && typeof skin === 'object' && validPaletteIndex(skin.s) && validPaletteIndex(skin.p)) {
      s = skin.s;
      p = skin.p;
    } else {
      const base = Number.isInteger(id) && id >= 0 ? id : 0;
      s = base % PALETTE.length;
      p = (base + 3) % PALETTE.length;
    }

    const group = new THREE.Group();

    // Stacked boxy avatar, group origin = feet: legs 0..0.6, torso 0.6..1.2,
    // head 1.2..1.7 (same total height as the old two-part avatar).
    const legsGeo = new THREE.BoxGeometry(0.6, 0.6, 0.3);
    const legsMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(PALETTE[p]) });
    const legs = new THREE.Mesh(legsGeo, legsMat);
    legs.position.y = 0.3;
    group.add(legs);

    const torsoGeo = new THREE.BoxGeometry(0.6, 0.6, 0.3);
    const torsoMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(PALETTE[s]) });
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = 0.9;
    group.add(torso);

    const headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const headMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(HEAD_COLOR) });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.45;
    group.add(head);

    const sprite = makeNameSprite(name);
    sprite.position.y = 2.05;
    group.add(sprite);

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
      geos: [legsGeo, torsoGeo, headGeo],
      mats: [legsMat, torsoMat, headMat],
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

    this.camera.position.set(eyePos.x, eyePos.y, eyePos.z);
    this.camera.rotation.set(pitch, yaw, 0); // YXZ order matches yaw/pitch contract
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
  }
}
