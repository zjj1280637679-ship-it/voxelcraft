// VoxelCraft server: static file host + dumb game-agnostic WebSocket relay.
// v2: zero game knowledge — rooms are just a host connection plus member
// connections; payloads in `d` are forwarded opaquely, never parsed.
// Node 24 ESM. Only external dependency: ws.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { WebSocketServer } from 'ws';

// Windows consoles often default to a legacy code page (e.g. GBK) that
// garbles the UTF-8 Chinese banner; switch this console to UTF-8.
if (process.platform === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore' }); } catch { /* no console */ }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// VC_PUBLIC_REL is a build-time constant: tools/build-dist.mjs injects 'public'
// via esbuild `define` so the bundled dist/server.js serves its sibling
// dist/public/. Running from source (npm start) the identifier is undefined
// (typeof guard, no ReferenceError) and the default '../public' applies.
const PUBLIC_DIR = path.resolve(
  __dirname,
  typeof VC_PUBLIC_REL === 'string' ? VC_PUBLIC_REL : '../public',
);

const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

const ROOM_CAPACITY = 8; // host + 7 members

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  if (pathname.includes('\0')) {
    notFound(res);
    return;
  }

  // Resolve against public/ and verify the result never escapes it.
  const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    notFound(res);
    return;
  }

  const type = MIME[path.extname(filePath).toLowerCase()];
  if (!type) {
    notFound(res);
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    notFound(res);
  }
});

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

// ---------------------------------------------------------------------------
// Relay layer (no game state: no seed, no edits, no positions)
// ---------------------------------------------------------------------------

// rooms: Map<key, { name, host: ws, members: Map<id, ws>, public: bool, meta: any, created: number }>
// Room identity = a user-chosen NAME (full Unicode). key = normalized name
// lowercased; `name` = the normalized display form as the creator typed it.
// Map insertion order = join order, so members.entries().next() is the
// oldest member — the one promoted on host migration.
// `meta` is opaque to the relay: stored and echoed in room lists, never parsed.
const rooms = new Map();
let nextId = 1;

// NFC + trim + collapse internal whitespace runs to a single space. Valid
// names are 1–16 code points after normalization; otherwise null (callers
// reply {t:'error', code:'bad-name'}).
function normalizeRoomName(raw) {
  const name = String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  const points = [...name].length; // code points, not UTF-16 units
  return points >= 1 && points <= 16 ? name : null;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// maxPayload caps inbound ws frames at 64 KB (ws auto-closes oversize frames
// with code 1009), so an unauthenticated client cannot push ~100 MB frames
// (ws's default) into the shared relay's parse/re-serialize path. 64 KB still
// covers a realistic `joined`/`resync` edit list.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

// A second instance is a common mistake — exit with a clear hint instead of a
// stack trace. ws re-emits the http server's listen error, so handle both.
function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用 (port in use)。`);
    console.error('  请先关闭已在运行的服务器窗口，或换一个端口启动:');
    console.error(`  $env:PORT=${PORT + 1}; npm start\n`);
    process.exit(1);
  }
  throw err;
}
server.on('error', onListenError);
wss.on('error', onListenError);

wss.on('connection', (ws) => {
  const st = { id: nextId++, room: null, role: null };
  ws._vc = st; // reachable from other connections' handlers (migration)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // ignore malformed JSON
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'host': {
        if (st.role) return; // already bound
        const name = normalizeRoomName(msg.room);
        if (name === null) {
          send(ws, { t: 'error', code: 'bad-name' });
          return;
        }
        const key = name.toLowerCase();
        if (rooms.has(key)) {
          send(ws, { t: 'error', code: 'taken' });
          return;
        }
        // Oversized meta (serialized form > 256 chars) is stored as null.
        let meta = msg.meta === undefined ? null : msg.meta;
        if (meta !== null) {
          const s = JSON.stringify(meta);
          if (s === undefined || s.length > 256) meta = null;
        }
        rooms.set(key, {
          name,
          host: ws,
          members: new Map(),
          public: msg.public !== false,
          meta,
          created: Date.now(),
        });
        st.room = key;
        st.role = 'host';
        send(ws, { t: 'hosted', room: name, id: st.id });
        console.log(`room "${name}" created by #${st.id}`);
        break;
      }

      case 'list': {
        // Allowed from any connection, including unbound ones.
        // Public rooms only, newest first, capped at 50 entries.
        const list = [...rooms.values()]
          .filter((room) => room.public)
          .sort((a, b) => b.created - a.created)
          .slice(0, 50)
          .map((room) => ({
            room: room.name,
            players: room.members.size + 1,
            meta: room.meta,
          }));
        send(ws, { t: 'rooms', rooms: list });
        break;
      }

      case 'join': {
        if (st.role) return;
        const name = normalizeRoomName(msg.room);
        if (name === null) {
          send(ws, { t: 'error', code: 'bad-name' });
          return;
        }
        const key = name.toLowerCase();
        const room = rooms.get(key);
        if (!room) {
          send(ws, { t: 'error', code: 'no-room' });
          return;
        }
        if (room.members.size >= ROOM_CAPACITY - 1) {
          send(ws, { t: 'error', code: 'full' });
          return;
        }
        room.members.set(st.id, ws);
        st.room = key;
        st.role = 'member';
        send(ws, { t: 'accepted', id: st.id, hostId: room.host._vc.id });
        send(room.host, { t: 'peer-in', id: st.id });
        console.log(`room "${room.name}": peer #${st.id} joined (${room.members.size + 1}/${ROOM_CAPACITY})`);
        break;
      }

      case 'msg': {
        const room = st.room ? rooms.get(st.room) : null;
        if (!room) return; // unbound or stale
        if (st.role === 'member') {
          send(room.host, { t: 'msg', from: st.id, d: msg.d });
        } else {
          const target = room.members.get(msg.to);
          if (!target) return; // `to` not in room
          send(target, { t: 'msg', d: msg.d });
        }
        break;
      }

      case 'cast': {
        const room = st.room ? rooms.get(st.room) : null;
        if (!room || st.role !== 'host') return;
        // `except` exists only for echo suppression. If that id already left
        // the room (its close raced this cast), exclusion is moot — broadcast
        // to all members rather than dropping the whole cast.
        const except = msg.except ?? null;
        const data = JSON.stringify({ t: 'msg', d: msg.d }); // once per payload
        for (const [id, peer] of room.members) {
          if (id !== except && peer.readyState === peer.OPEN) peer.send(data);
        }
        break;
      }

      default:
        break; // unknown message type: ignore
    }
  });

  ws.on('close', () => {
    const key = st.room;
    if (!key) return;
    st.room = null;
    const room = rooms.get(key);
    if (!room) return;

    if (st.role === 'member') {
      room.members.delete(st.id);
      send(room.host, { t: 'peer-out', id: st.id });
      console.log(`room "${room.name}": peer #${st.id} left`);
      return;
    }

    // Host left. room.host check guards stale closes after a prior migration.
    if (room.host !== ws) return;
    if (room.members.size === 0) {
      rooms.delete(key);
      console.log(`room "${room.name}" deleted (host #${st.id} left, empty)`);
      return;
    }
    // Host migration: promote the oldest member, room keeps its name.
    const [newId, newWs] = room.members.entries().next().value;
    room.members.delete(newId);
    room.host = newWs;
    newWs._vc.role = 'host';
    send(newWs, { t: 'promote', room: room.name, oldHostId: st.id, peers: [...room.members.keys()] });
    const data = JSON.stringify({ t: 'newhost', hostId: newId, oldHostId: st.id });
    for (const peer of room.members.values()) {
      if (peer.readyState === peer.OPEN) peer.send(data);
    }
    console.log(`room "${room.name}": host migrated #${st.id} -> #${newId}`);
  });

  ws.on('error', () => {
    // socket-level error: 'close' will follow, nothing else to do
  });
});

// Liveness sweep: without it an ungracefully dead host (wifi drop, power
// loss) stays OPEN until the OS TCP timeout — minutes of dead room. Browsers
// auto-answer protocol pings; terminate() fires 'close', so the existing
// migration path runs unchanged. (The no-timers rule applies to host.js only.)
const HEARTBEAT_MS = 10_000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  const urls = [`http://localhost:${PORT}`];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      const isV4 = iface.family === 'IPv4' || iface.family === 4;
      if (isV4 && !iface.internal) urls.push(`http://${iface.address}:${PORT}`);
    }
  }
  console.log('==============================================');
  console.log('  VoxelCraft server is running');
  console.log('----------------------------------------------');
  for (const u of urls) console.log('  ' + u);
  console.log('----------------------------------------------');
  console.log('  手机需连接同一 Wi-Fi，访问上面的局域网地址。');
  console.log('  (Phones must be on the same Wi-Fi network.)');
  console.log('==============================================');
});
