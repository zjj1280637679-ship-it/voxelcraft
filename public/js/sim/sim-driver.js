// sim-driver.js — bridges the PURE kernel (sim/kernel.js) to the browser shell.
// The kernel stays DOM/three-free; this driver (shell side) feeds it dt + the player
// position each rAF frame, and renders each entity as a PLACEHOLDER avatar (小人) via
// the existing renderer. 显现可换数据: swap the avatar for a real model later with
// ZERO kernel change. Faults are isolated (§3.7 隔): a sim throw freezes the creatures
// but never kills the render loop.

import { makeState, makeEntity, reduce } from './kernel.js';
import { protoByKey } from './prototypes.js';

// Distinct placeholder skin so creatures read as "not a player" for now.
const ENT_SKIN = { b: 2, t: 4, p: 6, k: 5 };
const FIRE_SKIN = { b: 0, t: 0, p: 1, k: 0 };   // small + red/orange = a fire mote

export class SimDriver {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.state = makeState();
    this.ctx = { out: [] };
    this._n = 0;
    this._ids = new Set();   // avatar ids we own, so kernel-reaped entities get cleaned up
  }

  // protoKey/packKey = string CODES into the registries; (x,z) world pos; seed = RNG.
  // Display name defaults to the prototype's bound name (a name is just bound data).
  spawn(protoKey, packKey, x, z, seed, name) {
    const id = ++this._n;
    let y = 40;
    try { y = this.world.surfaceHeight(Math.floor(x), Math.floor(z)); } catch (_) { /* unloaded */ }
    this.state.ents.set(id, makeEntity(id, protoKey, packKey, x, y, z, seed));
    const proto = protoByKey(protoKey);   // present facet: per-creature skin + size (data, swappable)
    this.renderer.addPlayer('e' + id, name || proto.name || protoKey, proto.skin || ENT_SKIN, proto.scale || 1);
    this._ids.add(id);
    return id;
  }

  // Spawn an airborne projectile at an explicit altitude + baked heading index. Used by
  // 喷火: a short-lived 'fire' object that flies straight then self-reaps (pack ttl).
  spawnProjectile(protoKey, packKey, x, y, z, dirIndex, seed) {
    const id = ++this._n;
    const e = makeEntity(id, protoKey, packKey, x, y, z, seed);
    e.dir = dirIndex & 7;
    this.state.ents.set(id, e);
    const proto = protoByKey(protoKey);
    this.renderer.addPlayer('e' + id, '', proto.skin || FIRE_SKIN, proto.scale || 0.35);
    this._ids.add(id);
    return id;
  }

  // Called once per rAF frame, after player.update(dt).
  tick(dt, playerPos) {
    if (this.state.ents.size === 0 && this._ids.size === 0) return;
    try {
      this.ctx.out.length = 0;
      reduce(this.state, { players: [{ x: playerPos.x, z: playerPos.z }] }, dt, this.ctx);
      for (const e of this.state.ents.values()) {
        // flying objects (fly facet) render at their OWN altitude; ground creatures snap
        // to the surface (placeholder until real models/physics land).
        let y = e.y;
        if (!protoByKey(e.m.p).fly) {
          try { y = this.world.surfaceHeight(Math.floor(e.x), Math.floor(e.z)); } catch (_) { /* keep last */ }
        }
        this.renderer.updatePlayer('e' + e.id, [e.x, y + (e.bob || 0) * 0.6, e.z], 0, 0);
      }
      // reap avatars for entities the kernel destroyed (e.g. expired fire motes)
      for (const id of this._ids) {
        if (!this.state.ents.has(id)) { this.renderer.removePlayer('e' + id); this._ids.delete(id); }
      }
    } catch (err) {
      console.error('[sim] tick error (creatures frozen, loop alive):', err);
    }
  }

  // Remove one entity + its avatar (e.g. a creature whose HP hit 0). Returns true if removed.
  kill(id) {
    if (!this.state.ents.has(id)) return false;
    this.state.ents.delete(id);
    this.renderer.removePlayer('e' + id);
    this._ids.delete(id);
    return true;
  }

  clear() {
    for (const id of this._ids) this.renderer.removePlayer('e' + id);
    this.state = makeState();
    this._ids = new Set();
    this._n = 0;
  }
}
