// HostRoom: authoritative room logic running in the host's browser tab
// (DESIGN.md §F, v2). Strictly event-driven — no setInterval/setTimeout/rAF
// (background tabs throttle timers, ws message handlers keep firing).
// No three.js, no DOM: pure game-state + relay messaging.

import { HEIGHT, BLOCK, PALETTE } from './constants.js';

// New members are announced at the nominal spawn column until their first
// move arrives (matches v1 server behavior).
const DEFAULT_SPAWN = [8, 40, 8];

// Highest legitimate block id — derived from BLOCK so it cannot desync when
// blocks are added. Ids above it render invisible but still cull neighbor
// faces (see mesher.js), so they must never enter the edit log.
const MAX_BLOCK_ID = Math.max(...Object.values(BLOCK));

function cleanName(name) {
  const s = typeof name === 'string' ? name.trim().slice(0, 16) : '';
  return s || '玩家';
}

// Skins cross the member trust boundary: accept only {s,p} integer PALETTE
// indices, anything else collapses to the default skin.
function cleanSkin(skin) {
  if (
    skin && typeof skin === 'object' &&
    Number.isInteger(skin.s) && skin.s >= 0 && skin.s < PALETTE.length &&
    Number.isInteger(skin.p) && skin.p >= 0 && skin.p < PALETTE.length
  ) {
    return { s: skin.s, p: skin.p };
  }
  return { s: 0, p: 0 };
}

export class HostRoom {
  // playerRef: live handle with .pos {x,y,z} and .yaw — used to include the
  // host itself in `joined` payloads. Must be the delegating handle, never a
  // snapshot, so late joiners see the host's current position.
  constructor({ net, world, room, hostId, hostName, hostSkin, playerRef }) {
    this.net = net;
    this.world = world;
    this.room = room;
    this.hostId = hostId;
    this.hostName = cleanName(hostName);
    this.hostSkin = cleanSkin(hostSkin);
    this.playerRef = playerRef;
    this.members = new Map(); // id -> {name, skin, p:[x,y,z], ry, helloed}
  }

  // Relay reported a new connection in the room; it stays pending until hello.
  handlePeerIn(id) {
    if (this.members.has(id)) return;
    this.members.set(id, {
      name: null, skin: null, p: DEFAULT_SPAWN.slice(), ry: 0, helloed: false,
    });
  }

  handleMsg(from, d) {
    const m = this.members.get(from);
    // No peer-in registration -> ignore; malformed payloads -> ignore.
    if (!m || !d || typeof d.t !== 'string') return;
    switch (d.t) {
      case 'hello': {
        if (m.helloed) {
          // Re-hello after host migration: the member may have missed the
          // original `joined` (lost with the old host). Re-unicast it; never
          // re-cast `pjoin` (already announced) or restart the member.
          this.net.sendTo(from, this.buildJoined(from));
          return;
        }
        m.name = cleanName(d.name);
        m.skin = cleanSkin(d.skin);
        m.helloed = true;
        this.net.sendTo(from, this.buildJoined(from));
        this.net.cast(
          { t: 'pjoin', id: from, name: m.name, p: m.p, ry: m.ry, skin: m.skin },
          from
        );
        break;
      }
      case 'move': {
        if (!m.helloed) return;
        if (
          !Array.isArray(d.p) || d.p.length !== 3 || !d.p.every(Number.isFinite) ||
          !Number.isFinite(d.ry) || !Number.isFinite(d.rx)
        ) return;
        m.p = d.p;
        m.ry = d.ry;
        this.net.cast({ t: 'pmove', id: from, p: d.p, ry: d.ry, rx: d.rx }, from);
        break;
      }
      case 'block': {
        if (!m.helloed) return;
        const { x, y, z, id } = d;
        if (
          !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
          !Number.isInteger(id) || id < 0 || id > MAX_BLOCK_ID ||
          y < 0 || y >= HEIGHT
        ) return;
        // Keeps world.edits authoritative for future joiners.
        this.world.applyEdit(x, y, z, id);
        // Echo to ALL members including the originating sender: the host is the
        // authority, so the originator re-applies the authoritative edit and
        // conflicting same-cell edits converge to host arrival order. (pmove
        // keeps its except-sender — positions self-heal; only block needs this.)
        this.net.cast({ t: 'block', x, y, z, id });
        break;
      }
      default:
        break;
    }
  }

  handlePeerOut(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    this.net.cast({ t: 'pleave', id }, null);
  }

  // Host's own movement; the caller throttles (<= ~12 Hz).
  castOwnMove(p, ry, rx) {
    this.net.cast({ t: 'pmove', id: this.hostId, p: [p[0], p[1], p[2]], ry, rx }, null);
  }

  // Host's own block edit; the caller has already applied it to its world.
  // Cast to ALL members (no except) for the same convergence reason as the
  // 'block' case in handleMsg.
  castOwnBlock(x, y, z, id) {
    this.net.cast({ t: 'block', x, y, z, id });
  }

  buildJoined(forId) {
    const ref = this.playerRef;
    const players = [{
      id: this.hostId,
      name: this.hostName,
      p: [ref.pos.x, ref.pos.y, ref.pos.z],
      ry: ref.yaw,
      skin: this.hostSkin,
    }];
    for (const [id, m] of this.members) {
      if (id === forId || !m.helloed) continue;
      players.push({
        id, name: m.name, p: [m.p[0], m.p[1], m.p[2]], ry: m.ry,
        skin: m.skin || { s: 0, p: 0 },
      });
    }
    const edits = [];
    for (const [key, id] of this.world.edits) {
      const c1 = key.indexOf(',');
      const c2 = key.indexOf(',', c1 + 1);
      edits.push([+key.slice(0, c1), +key.slice(c1 + 1, c2), +key.slice(c2 + 1), id]);
    }
    return {
      t: 'joined',
      room: this.room,
      seed: this.world.seed,
      id: forId,
      players,
      edits,
    };
  }

  // Full edit-log snapshot for migration resync. The edits array is serialized
  // from world.edits exactly like buildJoined's, so members merge it via
  // world.applyEdit (idempotent) and converge on the new host's world.
  buildResync() {
    const edits = [];
    for (const [key, id] of this.world.edits) {
      const c1 = key.indexOf(',');
      const c2 = key.indexOf(',', c1 + 1);
      edits.push([+key.slice(0, c1), +key.slice(c1 + 1, c2), +key.slice(c2 + 1), id]);
    }
    return { t: 'resync', edits };
  }

  // Migration seeding: map is Map<id, {name, p, ry, skin}> of already-active peers.
  adoptMembers(map) {
    for (const [id, info] of map) {
      this.members.set(id, {
        // cleanName like every other field here: a poisoned name inherited
        // from a malicious old host must not be re-broadcast via buildJoined.
        name: cleanName(info.name),
        skin: cleanSkin(info.skin),
        p: Array.isArray(info.p) ? [info.p[0], info.p[1], info.p[2]] : DEFAULT_SPAWN.slice(),
        ry: Number.isFinite(info.ry) ? info.ry : 0,
        helloed: true,
      });
    }
  }
}
