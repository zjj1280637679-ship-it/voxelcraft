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

export class SimDriver {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.state = makeState();
    this.ctx = { out: [] };
    this._n = 0;
  }

  // protoKey/packKey = string CODES into the registries; (x,z) world pos; seed = RNG.
  // Display name defaults to the prototype's bound name (a name is just bound data).
  spawn(protoKey, packKey, x, z, seed, name) {
    const id = ++this._n;
    let y = 40;
    try { y = this.world.surfaceHeight(Math.floor(x), Math.floor(z)); } catch (_) { /* unloaded */ }
    this.state.ents.set(id, makeEntity(id, protoKey, packKey, x, y, z, seed));
    this.renderer.addPlayer('e' + id, name || protoByKey(protoKey).name || protoKey, ENT_SKIN);
    return id;
  }

  // Called once per rAF frame, after player.update(dt).
  tick(dt, playerPos) {
    if (this.state.ents.size === 0) return;
    try {
      this.ctx.out.length = 0;
      reduce(this.state, { players: [{ x: playerPos.x, z: playerPos.z }] }, dt, this.ctx);
      for (const e of this.state.ents.values()) {
        let y = e.y;
        try { y = this.world.surfaceHeight(Math.floor(e.x), Math.floor(e.z)); } catch (_) { /* keep last */ }
        this.renderer.updatePlayer('e' + e.id, [e.x, y + (e.bob || 0) * 0.6, e.z], 0, 0);
      }
    } catch (err) {
      console.error('[sim] tick error (creatures frozen, loop alive):', err);
    }
  }

  clear() {
    for (const id of this.state.ents.keys()) this.renderer.removePlayer('e' + id);
    this.state = makeState();
    this._n = 0;
  }
}
