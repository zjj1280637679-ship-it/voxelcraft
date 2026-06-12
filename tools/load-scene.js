// Scene loader: joins an EXISTING room as a game-layer member and replays a
// scene file (docs/scenarios/worlds/*.json) block by block, rate-limited.
// The host echoes every accepted `block` back to ALL members including the
// sender (see public/js/host.js / DESIGN.md) — this tool counts those echoes
// as delivery confirmation and exits once every block has been confirmed.
//
// Usage: node tools/load-scene.js <scene.json> <roomName> [relayHost[:port]] [--interval=40] [--force]
//   scene.json  {name, seed, blocks:[[x,y,z,id],...]} (see docs/scenarios/worlds/README.md)
//   roomName    an existing room (full Unicode); the loader refuses to start
//               if the room's seed differs from the scene's (--force overrides)
//   relay       default localhost:8080
//
// Exit codes: 0 = all blocks echoed; 1 = error / seed mismatch / missing echoes.

import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const MAX_BLOCK_ID = 8; // mirror public/js/constants.js BLOCK (validated below by the host too)
const HEIGHT = 64;      // mirror public/js/constants.js HEIGHT
const ECHO_IDLE_LIMIT_MS = 15000;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const [sceneFile, roomName, target = 'localhost:8080'] = positional;
const force = flags.includes('--force');
const intervalFlag = flags.find((a) => a.startsWith('--interval='));
const intervalMs = Math.max(10, Number(intervalFlag?.split('=')[1]) || 40);

if (!sceneFile || !roomName) {
  console.log('usage: node tools/load-scene.js <scene.json> <roomName> [relayHost[:port]] [--interval=40] [--force]');
  process.exit(1);
}

const log = (line) => console.log(`LOAD-SCENE: ${line}`);

// ---- scene file ----
let scene;
try {
  scene = JSON.parse(readFileSync(sceneFile, 'utf8'));
} catch (e) {
  log(`无法读取场景文件 ${sceneFile}: ${e.message}`);
  process.exit(1);
}
if (!scene || typeof scene !== 'object' || !Array.isArray(scene.blocks)) {
  log('场景文件缺少 blocks 数组');
  process.exit(1);
}
if (!Number.isInteger(scene.seed)) {
  log('场景文件缺少整数 seed（坐标只在该种子的地形上成立）');
  process.exit(1);
}
for (const b of scene.blocks) {
  // Same bounds the host enforces (public/js/host.js): integers, id 0..8, y 0..63.
  if (
    !Array.isArray(b) || b.length !== 4 || !b.every(Number.isInteger) ||
    b[1] < 0 || b[1] >= HEIGHT || b[3] < 0 || b[3] > MAX_BLOCK_ID
  ) {
    log(`非法方块条目（需 [x,y,z,id] 整数，0<=y<${HEIGHT}，0<=id<=${MAX_BLOCK_ID}）: ${JSON.stringify(b)}`);
    process.exit(1);
  }
}
const total = scene.blocks.length;
if (total === 0) {
  log('场景为空，无事可做');
  process.exit(0);
}

// ---- echo bookkeeping (multiset: duplicate coords each expect their own echo) ----
const keyOf = (x, y, z, id) => `${x},${y},${z},${id}`;
const pending = new Map(); // key -> outstanding echo count
for (const [x, y, z, id] of scene.blocks) {
  const k = keyOf(x, y, z, id);
  pending.set(k, (pending.get(k) ?? 0) + 1);
}

// ---- relay connection ----
const url = `ws://${target.includes(':') ? target : target + ':8080'}/ws`;
const ws = new WebSocket(url);

let joined = false;     // got the host's `joined`
let sent = 0;
let echoed = 0;
let finished = false;
let sendTimer = null;
let idleTimer = null;
let startedAt = 0;

function sendToHost(d) {
  ws.send(JSON.stringify({ t: 'msg', d }));
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const missing = [...pending.entries()].filter(([, n]) => n > 0);
    log(`等待回声超时（${ECHO_IDLE_LIMIT_MS / 1000}s 无新回声）：已发送 ${sent}/${total}，已确认 ${echoed}/${total}`);
    for (const [k, n] of missing.slice(0, 5)) log(`  缺失回声 x${n}: [${k}]`);
    if (missing.length > 5) log(`  …共 ${missing.length} 个坐标未确认`);
    process.exit(1);
  }, ECHO_IDLE_LIMIT_MS);
}

function finish() {
  finished = true;
  if (sendTimer) clearInterval(sendTimer);
  if (idleTimer) clearTimeout(idleTimer);
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`DONE blocks=${total} echoed=${echoed} elapsed=${secs}s`);
  log(`加载完成：发送 ${total} 块，全部 ${echoed} 条回声已确认，用时 ${secs}s（间隔 ${intervalMs}ms）`);
  ws.close();
}

function startSending() {
  if (sendTimer) return;
  startedAt = Date.now();
  armIdleTimer();
  log(`开始发送 ${total} 块，间隔 ${intervalMs}ms（预计 ${(total * intervalMs / 1000).toFixed(1)}s）`);
  sendTimer = setInterval(() => {
    if (sent >= total) {
      clearInterval(sendTimer);
      sendTimer = null;
      return;
    }
    const [x, y, z, id] = scene.blocks[sent++];
    sendToHost({ t: 'block', x, y, z, id });
  }, intervalMs);
}

// Count one confirmed echo for (x,y,z,id) if it is still outstanding.
function confirm(x, y, z, id) {
  const k = keyOf(x, y, z, id);
  const n = pending.get(k);
  if (!n) return; // someone else's edit, or already confirmed
  pending.set(k, n - 1);
  echoed++;
  armIdleTimer();
  if (echoed === total && !finished) finish();
}

function handleGame(d) {
  if (!d || typeof d.t !== 'string') return;
  switch (d.t) {
    case 'joined': {
      if (joined) return; // duplicate (e.g. re-hello after migration)
      if (Number.isInteger(d.seed) && d.seed !== scene.seed) {
        log(`种子不匹配：房间 seed=${d.seed}，场景 "${scene.name ?? sceneFile}" 绑定 seed=${scene.seed}。`);
        log('换种子后地表高度不同，方块会悬空或被埋。请用 tools/host-bot.js 以场景种子开房，或加 --force 强行加载。');
        if (!force) process.exit(1);
        log('--force：忽略种子不匹配，继续加载');
      }
      joined = true;
      log(`已进入房间（seed=${d.seed}，房内已有 ${(d.players ?? []).length + 1} 人，存量修改 ${(d.edits ?? []).length} 条）`);
      startSending();
      break;
    }
    case 'block':
      confirm(d.x, d.y, d.z, d.id);
      break;
    case 'resync':
      // Host migration mid-load: the new host casts its full edit log. Any of
      // our blocks it already absorbed count as confirmed here.
      if (Array.isArray(d.edits)) {
        for (const e of d.edits) {
          if (Array.isArray(e) && e.length === 4) confirm(e[0], e[1], e[2], e[3]);
        }
      }
      break;
    default:
      break; // pjoin/pmove/pleave: irrelevant to loading
  }
}

ws.on('open', () => {
  log(`已连接 ${url}，加入房间「${roomName}」`);
  ws.send(JSON.stringify({ t: 'join', room: roomName }));
});

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  switch (msg.t) {
    case 'accepted':
      log(`accepted id=${msg.id} hostId=${msg.hostId} -> 发送 hello`);
      sendToHost({ t: 'hello', name: '场景搬运工', skin: { s: 3, p: 6 } });
      break;
    case 'newhost':
      log(`房主迁移 -> 新房主 #${msg.hostId}`);
      // Our hello (or in-flight blocks) may have died with the old host;
      // re-hello is idempotent per DESIGN.md. Unconfirmed blocks are healed by
      // the new host's resync, or reported by the idle watchdog.
      sendToHost({ t: 'hello', name: '场景搬运工', skin: { s: 3, p: 6 } });
      break;
    case 'promote':
      log('被提升为房主 —— 本工具无世界状态，无法当房主，断开以让中继提升下一位成员');
      ws.close();
      process.exit(1);
      break;
    case 'error':
      log(`中继错误: ${msg.code}${msg.code === 'no-room' ? '（房间不存在——先用 tools/host-bot.js 以场景种子开房）' : ''}`);
      process.exit(1);
      break;
    case 'msg':
      handleGame(msg.d);
      break;
    default:
      break;
  }
});

ws.on('close', () => {
  if (finished) process.exit(0);
  log('连接已断开（加载未完成）');
  process.exit(1);
});

ws.on('error', (e) => {
  log(`连接错误 ${e.message}`);
  process.exit(1);
});
