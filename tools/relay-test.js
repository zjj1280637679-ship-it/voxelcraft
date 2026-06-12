// Self-contained relay protocol test. Spawns the relay server on port 18097
// (never 8080), runs the full relay-layer contract with raw ws clients, prints
// one PASS/FAIL line per assertion, kills the child, exits 0 only if all pass.
// v2 named rooms: room identity is a user-chosen Unicode NAME (NFC + trim +
// whitespace-collapse, key lowercased, 1-16 code points).
// Usage: node tools/relay-test.js

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 18097;
const HTTP_URL = `http://localhost:${PORT}/`;
const WS_URL = `ws://localhost:${PORT}/ws`;

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ' — got ' + detail : ''}`);
  }
}

// ws client wrapper with a message queue so assertions can await messages
// in order or assert that none arrive within a window.
class Client {
  constructor() {
    this.ws = new WebSocket(WS_URL);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const w = this.waiters.shift();
      if (w) w.resolve(msg);
      else this.queue.push(msg);
    });
    this.ws.on('error', () => {}); // surfaced via open() reject / timeouts
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  next(timeout = 3000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const w = {};
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('timeout'));
      }, timeout);
      w.resolve = (msg) => { clearTimeout(timer); resolve(msg); };
      this.waiters.push(w);
    });
  }

  // null if nothing arrives within `timeout` — used for absence assertions.
  async nextOrNull(timeout) {
    try { return await this.next(timeout); } catch { return null; }
  }

  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false; // e.g. EADDRINUSE
    try {
      const res = await fetch(HTTP_URL);
      if (res.status > 0) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

async function run(child) {
  if (!(await waitForServer(child))) {
    check('relay server starts on :' + PORT, false, 'no HTTP response (port busy?)');
    return;
  }

  const ROOM = '测试小屋';

  // -- host creates a named room (Chinese name + meta) -------------------------
  const host = new Client();
  await host.open();
  host.send({ t: 'host', room: ROOM, meta: { n: '房主甲' } });
  const hosted = await host.next();
  check(
    "host '测试小屋' -> hosted(display name, id)",
    hosted.t === 'hosted' && hosted.room === ROOM && Number.isInteger(hosted.id),
    JSON.stringify(hosted),
  );
  const hostId = hosted.id;

  // -- second host, same name with extra spaces -> taken -----------------------
  const rival = new Client();
  await rival.open();
  rival.send({ t: 'host', room: ` ${ROOM} ` });
  const taken = await rival.next();
  check(
    "second host ' 测试小屋 ' -> error taken",
    taken.t === 'error' && taken.code === 'taken',
    JSON.stringify(taken),
  );
  rival.close();

  // -- bad names ----------------------------------------------------------------
  const badHost = new Client();
  await badHost.open();
  badHost.send({ t: 'host', room: '   ' }); // empty after trim
  const errEmpty = await badHost.next();
  check(
    'host empty name -> error bad-name',
    errEmpty.t === 'error' && errEmpty.code === 'bad-name',
    JSON.stringify(errEmpty),
  );
  badHost.send({ t: 'host', room: '一二三四五六七八九十一二三四五六七' }); // 17 code points
  const errLong = await badHost.next();
  check(
    'host 17-codepoint name -> error bad-name',
    errLong.t === 'error' && errLong.code === 'bad-name',
    JSON.stringify(errLong),
  );
  // 16 astral code points = 32 UTF-16 units: must be VALID (count code points).
  const emojiRoom = '😀'.repeat(16);
  badHost.send({ t: 'host', room: emojiRoom, public: false });
  const emojiHosted = await badHost.next();
  check(
    'host 16-codepoint emoji name (32 UTF-16 units) -> hosted',
    emojiHosted.t === 'hosted' && emojiHosted.room === emojiRoom,
    JSON.stringify(emojiHosted),
  );
  badHost.close(); // deletes the emoji room

  const badJoin = new Client();
  await badJoin.open();
  badJoin.send({ t: 'join', room: '' });
  const errJoin = await badJoin.next();
  check(
    'join empty name -> error bad-name',
    errJoin.t === 'error' && errJoin.code === 'bad-name',
    JSON.stringify(errJoin),
  );
  badJoin.close();

  // -- member 1 joins by name with extra spaces (same normalized key) ----------
  const m1 = new Client();
  await m1.open();
  m1.send({ t: 'join', room: ` ${ROOM} ` });
  const acc1 = await m1.next();
  check(
    "join ' 测试小屋 ' -> accepted (same room, id, hostId)",
    acc1.t === 'accepted' && Number.isInteger(acc1.id) && acc1.hostId === hostId,
    JSON.stringify(acc1),
  );
  const pin1 = await host.next();
  check('host gets peer-in', pin1.t === 'peer-in' && pin1.id === acc1.id, JSON.stringify(pin1));

  // -- member -> host message (hello with skin travels opaquely) ---------------
  m1.send({ t: 'msg', d: { t: 'hello', name: '测试员', skin: { s: 2, p: 6 } } });
  const fwd = await host.next();
  check(
    "member msg d -> host gets {t:'msg',from,d} with skin intact",
    fwd.t === 'msg' && fwd.from === acc1.id && fwd.d?.t === 'hello' &&
      fwd.d?.name === '测试员' && fwd.d?.skin?.s === 2 && fwd.d?.skin?.p === 6,
    JSON.stringify(fwd),
  );

  // -- host -> single member message --------------------------------------------
  host.send({ t: 'msg', to: acc1.id, d: { t: 'joined', seed: 42 } });
  const uni = await m1.next();
  check(
    "host msg to -> that member gets {t:'msg',d}",
    uni.t === 'msg' && uni.from === undefined && uni.d?.t === 'joined' && uni.d?.seed === 42,
    JSON.stringify(uni),
  );

  // -- member 2 joins by the exact display name ---------------------------------
  const m2 = new Client();
  await m2.open();
  m2.send({ t: 'join', room: ROOM });
  const acc2 = await m2.next();
  const pin2 = await host.next();
  check(
    'second member joins',
    acc2.t === 'accepted' && Number.isInteger(acc2.id) && acc2.id !== acc1.id &&
      acc2.hostId === hostId && pin2.t === 'peer-in' && pin2.id === acc2.id,
    JSON.stringify(acc2) + ' / ' + JSON.stringify(pin2),
  );

  // -- cast with except ----------------------------------------------------------
  host.send({ t: 'cast', d: { t: 'block', x: 1, y: 2, z: 3, id: 8 }, except: acc1.id });
  const castMsg = await m2.next();
  check(
    'cast except=m1 -> m2 receives',
    castMsg.t === 'msg' && castMsg.d?.t === 'block' && castMsg.d?.x === 1 &&
      castMsg.d?.y === 2 && castMsg.d?.z === 3 && castMsg.d?.id === 8,
    JSON.stringify(castMsg),
  );
  const leaked = await m1.nextOrNull(600);
  check('cast except=m1 -> m1 does not receive', leaked === null, JSON.stringify(leaked));

  // -- join an unknown name -> no-room -------------------------------------------
  const stranger = new Client();
  await stranger.open();
  stranger.send({ t: 'join', room: '不存在的房间' });
  const err = await stranger.next();
  check(
    'join unknown name -> error no-room',
    err.t === 'error' && err.code === 'no-room',
    JSON.stringify(err),
  );
  stranger.close();

  // -- member 1 disconnects --------------------------------------------------
  m1.close();
  const pout = await host.next();
  check('member1 close -> host gets peer-out', pout.t === 'peer-out' && pout.id === acc1.id, JSON.stringify(pout));

  // -- host disconnects: m2 (only member left) is promoted, room keeps its name --
  host.close();
  const promo = await m2.next();
  check(
    'host close -> m2 gets promote(room display name, empty peers)',
    promo.t === 'promote' && promo.room === ROOM && promo.oldHostId === hostId &&
      Array.isArray(promo.peers) && promo.peers.length === 0,
    JSON.stringify(promo),
  );

  m2.close();
  await sleep(200); // let the previous rooms' close/delete settle

  // -- ASCII name: trim + whitespace collapse + case-insensitive join ------------
  const hostC = new Client();
  await hostC.open();
  hostC.send({ t: 'host', room: '  Sky   Land ', public: false });
  const hostedC = await hostC.next();
  check(
    "host '  Sky   Land ' -> display name 'Sky Land' (trim + collapse)",
    hostedC.t === 'hosted' && hostedC.room === 'Sky Land',
    JSON.stringify(hostedC),
  );
  const mC = new Client();
  await mC.open();
  mC.send({ t: 'join', room: 'sKY lAND' });
  const accC = await mC.next();
  check(
    "join 'sKY lAND' -> accepted (ASCII join is case-insensitive)",
    accC.t === 'accepted' && accC.hostId === hostedC.id,
    JSON.stringify(accC),
  );
  await hostC.next(); // drain peer-in
  mC.close();
  await hostC.next(); // drain peer-out before closing the host (avoid promote race)
  hostC.close();
  await sleep(200);

  // -- lobby: 'list' / 'rooms' echo the display name ------------------------------
  const hostA = new Client();
  await hostA.open();
  hostA.send({ t: 'host', room: '公开大厅 ', public: true, meta: { n: '测试' } });
  const hostedA = await hostA.next();
  const roomA = hostedA.room;

  // list from a fresh connection that never sent host/join (unbound)
  const lister1 = new Client();
  await lister1.open();
  lister1.send({ t: 'list' });
  const list1 = await lister1.next();
  const entryA = (list1.rooms ?? []).find((r) => r.room === '公开大厅');
  check(
    'list from unbound conn -> display name with players=1 and meta echoed',
    hostedA.t === 'hosted' && roomA === '公开大厅' && list1.t === 'rooms' && !!entryA &&
      entryA.players === 1 && JSON.stringify(entryA.meta) === JSON.stringify({ n: '测试' }) &&
      list1.rooms[0].room === roomA, // newest first
    JSON.stringify(list1),
  );
  lister1.close();

  // -- private room is not listed ---------------------------------------------
  const hostB = new Client();
  await hostB.open();
  hostB.send({ t: 'host', room: '私密基地', public: false, meta: { n: '私密' } });
  const hostedB = await hostB.next();
  const roomB = hostedB.room;

  const lister2 = new Client();
  await lister2.open();
  lister2.send({ t: 'list' });
  const list2 = await lister2.next();
  check(
    'private room hidden from list (public one still shown)',
    hostedB.t === 'hosted' && list2.t === 'rooms' &&
      !(list2.rooms ?? []).some((r) => r.room === roomB) &&
      (list2.rooms ?? []).some((r) => r.room === roomA),
    JSON.stringify(list2),
  );
  lister2.close();

  // -- player count updates in a fresh list ------------------------------------
  const mA = new Client();
  await mA.open();
  mA.send({ t: 'join', room: roomA });
  const accA = await mA.next();
  check('member joins listed public room', accA.t === 'accepted', JSON.stringify(accA));
  await hostA.next(); // drain peer-in

  const lister3 = new Client();
  await lister3.open();
  lister3.send({ t: 'list' });
  const list3 = await lister3.next();
  const entryA2 = (list3.rooms ?? []).find((r) => r.room === roomA);
  check(
    'after member join, fresh list shows players=2',
    list3.t === 'rooms' && !!entryA2 && entryA2.players === 2,
    JSON.stringify(list3),
  );
  lister3.close();

  mA.close();
  hostA.close();
  hostB.close();
}

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

try {
  await run(child);
} catch (e) {
  failed++;
  console.log(`FAIL unexpected: ${e.message}`);
} finally {
  child.kill();
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
