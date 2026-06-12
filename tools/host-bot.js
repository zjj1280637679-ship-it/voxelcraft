// Minimal game-layer HOST for testing browsers as members: creates a named
// room on the relay and answers hello/move/block like public/js/host.js would,
// with an in-memory edit map instead of a real world. Runs until killed (Ctrl+C).
// Usage: node tools/host-bot.js [roomName] [relayHost[:port]] [seed]
//   e.g. node tools/host-bot.js                          -> room 机器人的世界 @ ws://localhost:8080/ws
//        node tools/host-bot.js 我的房间 192.168.1.5 777 -> room 我的房间 @ ws://192.168.1.5:8080/ws, seed 777

import WebSocket from 'ws';

const roomName = process.argv[2] || '机器人的世界';
const target = process.argv[3] || 'localhost:8080';
const url = `ws://${target.includes(':') ? target : target + ':8080'}/ws`;
const seed = Number(process.argv[4]) || 12345;

const OWN = { name: '机器人房主', p: [8, 40, 8], ry: 0, skin: { b: 1, t: 1, p: 5, k: 1 } };

let ownId = null;
let hostedRoom = null;     // display name echoed by the relay
const members = new Map(); // id -> { name, skin, p, ry, helloed }
const edits = new Map();   // 'x,y,z' -> block id
const moveLogAt = new Map(); // id -> last move log time (avoid 10 Hz flood)

// Skin v2 validation/migration — the SHARED rule, identical to public/js/host.js:
// 1) v2 {b,t,p,k} all integers in range (b 0..7, t 0..7, p 0..7, k 0..5) -> as-is;
// 2) legacy {s,p} integers 0..7 -> {b:1, t:s, p:p, k:1};
// 3) anything else -> {b:1, t:0, p:0, k:1}.
function validSkin(skin) {
  if (skin && typeof skin === 'object') {
    if (Number.isInteger(skin.b) && skin.b >= 0 && skin.b <= 7 &&
        Number.isInteger(skin.t) && skin.t >= 0 && skin.t <= 7 &&
        Number.isInteger(skin.p) && skin.p >= 0 && skin.p <= 7 &&
        Number.isInteger(skin.k) && skin.k >= 0 && skin.k <= 5) {
      return { b: skin.b, t: skin.t, p: skin.p, k: skin.k };
    }
    if (Number.isInteger(skin.s) && skin.s >= 0 && skin.s <= 7 &&
        Number.isInteger(skin.p) && skin.p >= 0 && skin.p <= 7) {
      return { b: 1, t: skin.s, p: skin.p, k: 1 };
    }
  }
  return { b: 1, t: 0, p: 0, k: 1 };
}

const ws = new WebSocket(url);
const log = (line) => console.log(`HOST-BOT: ${line}`);

function sendTo(id, d) {
  ws.send(JSON.stringify({ t: 'msg', to: id, d }));
}

function cast(d, except = null) {
  const msg = { t: 'cast', d };
  if (except !== null) msg.except = except;
  ws.send(JSON.stringify(msg));
}

function buildJoined(forId) {
  const players = [{ id: ownId, name: OWN.name, p: OWN.p, ry: OWN.ry, skin: OWN.skin }];
  for (const [id, m] of members) {
    if (id !== forId && m.helloed) players.push({ id, name: m.name, p: m.p, ry: m.ry, skin: m.skin });
  }
  const editList = [];
  for (const [key, id] of edits) {
    const [x, y, z] = key.split(',').map(Number);
    editList.push([x, y, z, id]);
  }
  return { t: 'joined', room: hostedRoom, seed, id: forId, players, edits: editList };
}

function handleGame(from, d) {
  const m = members.get(from);
  if (!m || !d || typeof d.t !== 'string') return; // no peer-in seen: ignore
  switch (d.t) {
    case 'hello': {
      m.name = typeof d.name === 'string' && d.name.trim()
        ? d.name.trim().slice(0, 16)
        : `玩家${from}`;
      m.skin = validSkin(d.skin);
      m.helloed = true;
      sendTo(from, buildJoined(from));
      cast({ t: 'pjoin', id: from, name: m.name, p: m.p, ry: m.ry, skin: m.skin }, from);
      log(`hello from #${from} "${m.name}" skin={b:${m.skin.b},t:${m.skin.t},p:${m.skin.p},k:${m.skin.k}} -> sent joined (seed=${seed}, edits=${edits.size}), cast pjoin`);
      break;
    }
    case 'move': {
      if (!m.helloed) return;
      if (!Array.isArray(d.p) || d.p.length !== 3 || !d.p.every(Number.isFinite)) return;
      if (!Number.isFinite(d.ry) || !Number.isFinite(d.rx)) return; // mirror public/js/host.js
      m.p = d.p;
      m.ry = Number(d.ry) || 0;
      cast({ t: 'pmove', id: from, p: d.p, ry: d.ry, rx: d.rx }, from);
      const now = Date.now();
      if (now - (moveLogAt.get(from) ?? 0) >= 2000) {
        moveLogAt.set(from, now);
        log(`move #${from} p=${d.p.map((v) => Number(v).toFixed(1)).join(',')} ry=${(Number(d.ry) || 0).toFixed(2)} -> pmove (logged 1/2s)`);
      }
      break;
    }
    case 'block': {
      if (!m.helloed) return;
      const { x, y, z, id } = d;
      if (![x, y, z, id].every(Number.isInteger)) return;
      // Mirror public/js/host.js bounds: 8 = max BLOCK id, 64 = HEIGHT —
      // both must track public/js/constants.js.
      if (id < 0 || id > 8 || y < 0 || y >= 64) return;
      edits.set(`${x},${y},${z}`, id);
      // Echo to ALL members INCLUDING the sender — mirror public/js/host.js
      // and DESIGN.md: the authoritative echo is what makes same-cell edits
      // converge (and what tools/load-scene.js counts for confirmation).
      cast({ t: 'block', x, y, z, id });
      log(`block #${from} (${x},${y},${z}) id=${id} -> recorded + cast-to-all (edits=${edits.size})`);
      break;
    }
    default:
      log(`unknown game msg from #${from}: ${JSON.stringify(d)}`);
  }
}

ws.on('open', () => {
  log(`connected ${url}`);
  ws.send(JSON.stringify({ t: 'host', room: roomName, public: true, meta: { n: '机器人房主' } }));
});

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  switch (msg.t) {
    case 'hosted':
      ownId = msg.id;
      hostedRoom = msg.room;
      console.log(`HOSTED ${msg.room}`);
      log(`hosting "${hostedRoom}" as #${ownId}, seed=${seed} — waiting for members`);
      break;
    case 'peer-in':
      members.set(msg.id, { name: null, skin: { b: 1, t: 0, p: 0, k: 1 }, p: OWN.p.slice(), ry: 0, helloed: false });
      log(`peer-in #${msg.id} (pending hello)`);
      break;
    case 'peer-out': {
      const m = members.get(msg.id);
      if (!m) return;
      members.delete(msg.id);
      moveLogAt.delete(msg.id);
      cast({ t: 'pleave', id: msg.id });
      log(`peer-out #${msg.id} "${m.name ?? '?'}" -> cast pleave (${members.size} members left)`);
      break;
    }
    case 'msg':
      handleGame(msg.from, msg.d);
      break;
    case 'error':
      log(`relay error: ${msg.code}`);
      if (msg.code === 'taken' || msg.code === 'bad-name') process.exit(1); // cannot host
      break;
    default:
      log(`relay: ${JSON.stringify(msg)}`);
  }
});

ws.on('close', () => {
  log('connection closed');
  process.exit(0);
});

ws.on('error', (e) => {
  log(`error ${e.message}`);
  process.exit(1);
});
