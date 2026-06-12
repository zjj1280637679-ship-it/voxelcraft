// Game-layer MEMBER bot for testing browsers as hosts: joins a room by NAME
// (full Unicode, e.g. 机器人的世界), says hello with its skin, stands at a
// fixed spot sending 10 Hz moves with an oscillating yaw, optionally places
// one brick block. Runs until killed (Ctrl+C).
// Usage: node tools/member-bot.js ROOM-NAME px py pz [bx by bz]

import WebSocket from 'ws';

const [room, px, py, pz, bx, by, bz] = process.argv.slice(2);
if (!room || px === undefined || py === undefined || pz === undefined) {
  console.log('usage: node tools/member-bot.js ROOM-NAME px py pz [bx by bz]');
  process.exit(1);
}
const pos = [Number(px), Number(py), Number(pz)];
const block = bx !== undefined && by !== undefined && bz !== undefined
  ? [Number(bx), Number(by), Number(bz)]
  : null;

// Relay port: PORT env var, default 8080 (matches the server's own default).
const ws = new WebSocket(`ws://localhost:${Number(process.env.PORT) || 8080}/ws`);
const log = (line) => console.log(`MEMBER-BOT: ${line}`);

let myId = null;
let hostId = null;
let joined = false; // got 'joined' from the host (needed for newhost re-hello)
let moveTimer = null;
let ticks = 0;
let lastMoveLog = 0;

function sendToHost(d) {
  ws.send(JSON.stringify({ t: 'msg', d }));
}

function startMoving() {
  if (moveTimer) return;
  moveTimer = setInterval(() => {
    ticks++;
    sendToHost({ t: 'move', p: pos, ry: Math.sin(ticks * 0.1) * 0.6, rx: 0 });
  }, 100); // 10 Hz
  if (block) {
    setTimeout(() => {
      sendToHost({ t: 'block', x: block[0], y: block[1], z: block[2], id: 8 });
      log(`placed block id=8 at ${block.join(',')}`);
    }, 1000);
  }
}

function handleGame(d) {
  if (!d || typeof d.t !== 'string') return;
  switch (d.t) {
    case 'joined': {
      joined = true;
      const players = (d.players ?? [])
        .map((p) => `${p.id}:${p.name}(skin=${p.skin ? `s${p.skin.s}/p${p.skin.p}` : 'none'})`)
        .join('|') || '-';
      console.log(`JOINED id=${d.id} hostId=${hostId} seed=${d.seed} players=${players} edits=${(d.edits ?? []).length}`);
      startMoving();
      break;
    }
    case 'pmove': {
      const now = Date.now();
      if (now - lastMoveLog >= 2000) {
        lastMoveLog = now;
        log(`pmove id=${d.id} p=${(d.p ?? []).map((v) => Number(v).toFixed(1)).join(',')} ry=${(Number(d.ry) || 0).toFixed(2)} (logged 1/2s)`);
      }
      break;
    }
    case 'pjoin':
    case 'pleave':
    case 'block':
      log(`${d.t} ${JSON.stringify(d)}`);
      break;
    default:
      log(`game: ${JSON.stringify(d)}`);
  }
}

ws.on('open', () => {
  log('connected, joining ' + room);
  ws.send(JSON.stringify({ t: 'join', room }));
});

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  switch (msg.t) {
    case 'accepted':
      myId = msg.id;
      hostId = msg.hostId;
      log(`accepted id=${myId} hostId=${hostId} -> sending hello`);
      sendToHost({ t: 'hello', name: '手机玩家', skin: { s: 2, p: 6 } });
      break;
    case 'error':
      log(`error ${msg.code}`);
      process.exit(1);
      break;
    case 'newhost':
      hostId = msg.hostId;
      log(`newhost ${JSON.stringify(msg)}`);
      if (!joined) {
        // Migration raced our initial hello (it died with the old host):
        // re-hello the new host per DESIGN.md, else 'joined' never arrives.
        log('joined never arrived -> re-sending hello to new host');
        sendToHost({ t: 'hello', name: '手机玩家', skin: { s: 2, p: 6 } });
      }
      break;
    case 'promote':
      // This bot cannot act as a game host (no world state): disconnect so
      // the relay promotes the next member (DESIGN.md accepted edge).
      log(`promote ${JSON.stringify(msg)} -> cannot host, disconnecting`);
      ws.close();
      break;
    case 'msg':
      handleGame(msg.d);
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
