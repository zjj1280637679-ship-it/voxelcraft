// main.js — orchestrator (DESIGN.md §F, v2). Boots UI + renderer, drives the
// relay client in host or member mode, runs the budgeted game loop, handles
// block interaction and host migration.

import { CHUNK, HEIGHT, BLOCK, HOTBAR, PLAYER, PALETTE, chunkKey } from './constants.js';
import {
  initMenu, getActiveChar, showCreatePrompt, hideCreatePrompt, showMenuError,
  setConnStatus, renderRooms, setRoomsLoading, restoreRoomSections, hideMenu,
  setRoomLabel, buildHotbar, setHotbarSelection, onHotbarTap, toast, backToMenu,
  recordHistory,
} from './ui.js';
import { World } from './world.js';
import { Renderer } from './renderer.js';
import { Player } from './player.js';
import { initDesktopControls } from './controls-desktop.js';
import { isTouchDevice, initTouchControls } from './controls-touch.js';
import { RelayNet } from './network.js';
import { HostRoom } from './host.js';

const canvas = document.getElementById('gameCanvas');
const renderer = new Renderer(canvas);

// ---- session state ----
let net = null;
let connected = false;
let busy = false;            // create/join attempt in flight
let leaving = false;         // exit button pressed: next onClose is voluntary
let lobbySeq = 0;            // stamps lobby refreshes; stale ones must not touch UI
let playing = false;
let controlsInited = false;
let world = null;
let player = null;
let roomCode = '';           // the room's display name
let myId = -1;
let myName = '玩家';          // active character (ui.js owns storage/selection)
let mySkin = { s: 0, p: 0 }; // always a validated {s,p} pair
let pendingAction = null;    // 'join' | 'host' — lobby request awaiting a relay reply
let pendingRoom = '';        // room name of that request (find-first / taken-fallback)
let mode = null;             // 'host' | 'member' | null
let hostRoom = null;         // HostRoom instance while mode === 'host'
let currentHostId = -1;      // member mode: relay id of the current host
let RADIUS = 4;
let slot = 0;
let rafId = null;
let lastTime = 0;
let lastMoveSent = 0;
let replyTimer = null;       // deadline for any awaited relay reply (join/host/list)
let joinTimedOut = false;    // a join/host deadline fired: onClose shows a timeout message
let lobbyTimer = null;       // deadline between listRooms() and the relay's `rooms`
const MOVE_INTERVAL = 1000 / 12; // outbound move throttle (~12 Hz), lives here

// id -> {name, p:[x,y,z], ry, skin} for every remote player. Powers the room
// label, leave toasts and — critically — host migration (adoptMembers seed).
const remoteInfo = new Map();
const meshed = new Map();        // chunkKey -> [cx, cz] currently held by renderer
const farDirty = new Map();      // chunkKey -> [cx, cz] dirty but beyond mesh range
let lastPcx = null;              // last player chunk, for farDirty re-queue
let lastPcz = null;
let touchTick = null;            // per-frame hold evaluator from touch controls
let touchReset = null;           // clears all per-touch tracking on session end
let wakeLock = null;             // screen WakeLockSentinel while hosting on touch
let wakeLockPending = false;     // wake lock request in flight (single-flight guard)
const _movP = [0, 0, 0];         // scratch array for move sends (no per-frame alloc)

// Controls are initialized once but must keep driving the current Player
// instance across disconnect/rejoin, so they get this stable handle. The same
// handle doubles as HostRoom's playerRef (live .pos/.yaw for `joined`).
const _nullInput = { f: 0, b: 0, l: 0, r: 0, jump: false };
const _nullVec = { x: 0, y: 0, z: 0 };
const playerHandle = {
  get pos() { return player ? player.pos : _nullVec; },
  get vel() { return player ? player.vel : _nullVec; },
  get onGround() { return player ? player.onGround : false; },
  get input() { return player ? player.input : _nullInput; },
  get yaw() { return player ? player.yaw : 0; },
  set yaw(v) { if (player) player.yaw = v; },
  get pitch() { return player ? player.pitch : 0; },
  set pitch(v) { if (player) player.pitch = v; },
  eye() { return player ? player.eye() : { x: 0, y: 0, z: 0 }; },
  lookDir() { return player ? player.lookDir() : { x: 0, y: 0, z: -1 }; },
};

// ---- boot ----
const icons = HOTBAR.map((id) => renderer.atlas.blockIcon(id));
buildHotbar(icons);
setHotbarSelection(slot);
onHotbarTap(selectSlot);
initMenu({
  onEnterRoom: enterRoom,
  onCreateRoom: createRoom,
  onRefresh: refreshLobby,
  onExit: handleExit,
  onCharPicked: setActiveChar,
});
// Adopt the saved active character (null on a fresh install — ui.js keeps the
// player on the profile page until one exists, and onCharPicked updates us).
setActiveChar(getActiveChar());
// Lobby auto-connect: list public rooms for the initial server value (which
// ui.js just prefilled into #serverInput). Failure only colors the status
// line — it must never block the menu.
refreshLobby(currentServerSpec());
window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => renderer.resize());
document.addEventListener('visibilitychange', () => {
  // Wake lock is auto-released when the tab hides; re-acquire when hosting.
  if (document.visibilityState === 'visible' && playing && mode === 'host' && isTouchDevice()) {
    acquireWakeLock();
  }
});

// ---- menu actions ----
function selectSlot(i) {
  if (!(i >= 0 && i < HOTBAR.length)) return;
  slot = i;
  setHotbarSelection(i);
}

// ---- lobby (menu = connection layer, decoupled from the game) ----
function currentServerSpec() {
  const el = document.getElementById('serverInput');
  return el ? el.value.trim() : '';
}

function serverLabel(server) {
  const s = (server || '').trim();
  return s || '本站';
}

// Highest legitimate block id (HOTBAR places 1..MAX, break sends 0/AIR).
const MAX_BLOCK_ID = Math.max(...Object.values(BLOCK));

// A skin from storage or the network must be {s,p} PALETTE indices.
function validSkin(s) {
  return !!s && typeof s === 'object' &&
    Number.isInteger(s.s) && s.s >= 0 && s.s < PALETTE.length &&
    Number.isInteger(s.p) && s.p >= 0 && s.p < PALETTE.length;
}

// Same collapse rule the host applies: invalid skin -> default {s:0, p:0}.
function cleanSkin(s) {
  return validSkin(s) ? { s: s.s, p: s.p } : { s: 0, p: 0 };
}

// Active character (ui.js owns the storage; this is our session copy used for
// hello payloads, hosting meta and HostRoom identity).
function setActiveChar(ch) {
  if (!ch || typeof ch !== 'object') return;
  if (typeof ch.name === 'string' && ch.name.trim()) {
    myName = ch.name.trim().slice(0, 16);
  }
  mySkin = cleanSkin(ch.skin);
}

// Connect (or reconnect, if the server address changed or the socket died)
// and refresh the public room list. Never throws and never blocks the menu.
async function refreshLobby(server) {
  if (busy || playing) return;
  const seq = ++lobbySeq;
  setRoomsLoading();
  try {
    await ensureConnected(server);
    if (seq !== lobbySeq || playing) return; // superseded by a newer action
    setConnStatus('已连接 · ' + serverLabel(server), true);
    net.listRooms();
    armLobbyTimer(seq);
  } catch (err) {
    console.log('[vc] lobby connect failed:', err && err.message);
    if (seq !== lobbySeq || playing) return;
    setConnStatus('未连接（检查服务器地址后点刷新）', false);
    renderRooms([], pickRoom);
  }
}

// Click on a public-room row: enter that room name (find-first flow). The
// server comes from the menu input; identity is the active character.
function pickRoom(roomName) {
  enterRoom(roomName, currentServerSpec());
}

function handleExit() {
  if (!playing || !net) return;
  leaving = true; // voluntary close: onClose shows no error message
  console.log('[vc] exit button pressed — leaving room');
  // Tear down synchronously: if the connection is already silently dead, the
  // browser's close event can take seconds, and the exit button must not
  // appear broken meanwhile. onClose then takes the non-playing branch and
  // uses `leaving` to restore the lobby.
  stopGame();
  backToMenu();
  net.close();
  // The close event can lag for seconds; until it fires the socket is
  // CLOSING and _send drops frames silently. Mark the session disconnected
  // now so ensureConnected never reuses it (it swaps and redials instead).
  connected = false;
}

// ---- enter / create (find-first flow, DESIGN steps 2–3) ----
// Step 2: try joining the named room first. `no-room` is the expected
// "doesn't exist yet" outcome and reveals the create prompt (see onError).
async function enterRoom(roomName, server) {
  if (busy || playing) return;
  const room = String(roomName == null ? '' : roomName).trim();
  if (!room) {
    showMenuError('请输入房间名');
    return;
  }
  busy = true;
  lobbySeq++; // supersede any in-flight lobby refresh
  hideCreatePrompt();
  setActiveChar(getActiveChar()); // pick up in-place edits of the active char
  pendingAction = 'join';
  pendingRoom = room;
  try {
    await ensureConnected(server);
    setConnStatus('已连接 · ' + serverLabel(server), true);
    net.joinRoom(room);
    armReplyTimer();
  } catch (err) {
    busy = false;
    console.error('[vc] connect failed:', err);
    setConnStatus('未连接（检查服务器地址后点刷新）', false);
    showMenuError('无法连接服务器');
    restoreRoomSections(); // clear a stale '刷新中…' from a superseded refresh
  }
}

// Step 3: create confirmed via the prompt. `taken` (lost the create race)
// falls back to a plain join in onError.
async function createRoom(roomName, server, isPublic) {
  if (busy || playing) return;
  const room = String(roomName == null ? '' : roomName).trim();
  if (!room) {
    showMenuError('请输入房间名');
    return;
  }
  busy = true;
  lobbySeq++; // supersede any in-flight lobby refresh
  hideCreatePrompt();
  setActiveChar(getActiveChar());
  pendingAction = 'host';
  pendingRoom = room;
  try {
    await ensureConnected(server);
    setConnStatus('已连接 · ' + serverLabel(server), true);
    net.hostRoom({ room, public: !!isPublic, meta: { n: myName.slice(0, 24) } });
    armReplyTimer();
  } catch (err) {
    busy = false;
    console.error('[vc] connect failed:', err);
    setConnStatus('未连接（检查服务器地址后点刷新）', false);
    showMenuError('无法连接服务器');
    restoreRoomSections(); // clear a stale '刷新中…' from a superseded refresh
  }
}

// Reply deadline (anti-wedge), shared by every busy lobby request that awaits a
// relay reply: `join` (host accepts but never answers `hello`), `host` (relay
// drops the frame and never sends `hosted`). A wedged/malicious peer or a
// silently half-open socket — the relay's heartbeat keeps it alive — would
// otherwise leave `busy` stuck and the whole menu dead. net.close() routes
// through onClose, which resets busy and the lobby.
function armReplyTimer() {
  clearReplyTimer();
  replyTimer = setTimeout(() => {
    replyTimer = null;
    if (busy && !playing && net) {
      console.log('[vc] relay reply never arrived — giving up');
      joinTimedOut = true;
      net.close();
    }
  }, 10000);
}

function clearReplyTimer() {
  if (replyTimer !== null) {
    clearTimeout(replyTimer);
    replyTimer = null;
  }
}

// Lobby refresh deadline: a `list` whose frame was silently dropped (half-open
// socket) would otherwise leave the lobby stuck on '刷新中…' forever. On expiry
// mark the session disconnected and color the status line; a future refresh
// redials. Guarded by lobbySeq so a superseded refresh's timer is inert.
function armLobbyTimer(seq) {
  clearLobbyTimer();
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    if (seq !== lobbySeq || playing) return; // superseded or in a game
    console.log('[vc] room list never arrived — marking disconnected');
    connected = false;
    setConnStatus('未连接（检查服务器地址后点刷新）', false);
    renderRooms([], pickRoom);
  }, 10000);
}

function clearLobbyTimer() {
  if (lobbyTimer !== null) {
    clearTimeout(lobbyTimer);
    lobbyTimer = null;
  }
}

// Relay error code -> user-facing message (DESIGN step 2 mapping).
function errorText(code) {
  return code === 'no-room' ? '房间不存在'
    : code === 'full' ? '房间已满'
    : code === 'bad-name' ? '房间名需为 1–16 个字符'
    : '发生错误';
}

// Reuse the open socket when it still points at `server`; otherwise drop it
// silently (no onClose side effects) and dial the new address.
async function ensureConnected(server) {
  const spec = (server || '').trim();
  if (net && connected && net.connectedTo === spec) return;
  if (net) {
    const old = net;
    net = null;
    connected = false;
    old.onClose = null; // deliberate swap, not a disconnect
    // The discarded socket's onClose never runs, so its pending voluntary-
    // close flag must die with it — else the NEXT real disconnect on the new
    // socket would be mistaken for an exit and show no '连接已断开'.
    leaving = false;
    old.close();
  }
  const n = new RelayNet();
  wireNet(n);
  net = n;
  await n.connect(spec);
  // A newer ensureConnected may have swapped `net` while we awaited; marking
  // the session connected for a superseded socket would poison the reuse path.
  if (net !== n) throw new Error('connection superseded');
  connected = true;
}

// ---- relay callbacks ----
// All handlers dispatch on the *current* mode/hostRoom, so promotion needs no
// literal re-wiring: flipping `mode` and creating `hostRoom` re-routes them.
function wireNet(n) {
  n.onHosted = ({ room, id }) => {
    clearReplyTimer();
    busy = false;
    pendingAction = null;
    mode = 'host';
    myId = id;
    const seed = Math.floor(Math.random() * 2 ** 31);
    world = new World(seed);
    hostRoom = new HostRoom({
      net: n, world, room, hostId: id, hostName: myName, hostSkin: mySkin,
      playerRef: playerHandle,
    });
    console.log('[vc] hosting room', room, 'seed', seed);
    startGame({ room, id, seed, players: [], edits: [] });
  };

  n.onAccepted = ({ id, hostId }) => {
    mode = 'member';
    myId = id;
    currentHostId = hostId;
    n.sendToHost({ t: 'hello', name: myName, skin: mySkin });
    console.log('[vc] accepted as player', id, 'host is', hostId);
  };

  n.onError = (code) => {
    clearReplyTimer();
    console.error('[vc] relay error:', code);
    if (playing) {
      busy = false;
      toast(errorText(code));
      return;
    }
    if (code === 'no-room' && pendingAction === 'join') {
      // Expected find-first outcome, not an error: offer to create the room.
      // busy must clear here or the menu wedges.
      busy = false;
      showMenuError('');
      restoreRoomSections(); // clear a stale '刷新中…' from a superseded refresh
      showCreatePrompt(pendingRoom);
      return;
    }
    if (code === 'taken' && pendingAction === 'host') {
      // Lost the create race — the room exists now, so just join it.
      console.log('[vc] room taken — joining instead:', pendingRoom);
      pendingAction = 'join';
      n.joinRoom(pendingRoom);
      armReplyTimer();
      return;
    }
    busy = false;
    showMenuError(errorText(code));
    restoreRoomSections(); // clear a stale '刷新中…' from a superseded refresh
  };

  n.onRooms = (rooms) => {
    clearLobbyTimer();
    if (playing) return;
    // Relay trust boundary: the server address is user-supplied, so list
    // entries can be anything — drop non-objects before dereferencing.
    const mapped = rooms
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ room: r.room, players: r.players }));
    renderRooms(mapped, pickRoom);
  };

  n.onPeerIn = (id) => {
    if (!hostRoom) return;
    hostRoom.handlePeerIn(id);
    console.log('[vc] peer-in', id);
  };

  n.onPeerOut = (id) => {
    if (!hostRoom) return;
    hostRoom.handlePeerOut(id);
    dropRemote(id, true);
    console.log('[vc] peer-out', id);
  };

  n.onMsg = (d, from) => {
    if (mode === 'host') hostOnMsg(d, from);
    else memberOnMsg(d);
  };

  n.onPromote = handlePromote;
  n.onNewHost = handleNewHost;

  n.onClose = () => {
    const wasBusy = busy;
    const wasLeaving = leaving;
    const wasTimeout = joinTimedOut;
    connected = false;
    busy = false;
    leaving = false;
    joinTimedOut = false;
    pendingAction = null;
    clearReplyTimer();
    clearLobbyTimer();
    console.log('[vc] ws closed');
    if (playing) {
      stopGame();
      // Voluntary exit shows no error; an unexpected drop does.
      if (wasLeaving) backToMenu();
      else backToMenu('连接已断开');
      // Bring the lobby back: reconnect to the same relay, refresh the list.
      refreshLobby(n.connectedTo);
    } else {
      mode = null;
      hostRoom = null;
      currentHostId = -1;
      if (wasLeaving) {
        // Voluntary exit: handleExit already tore down the session and
        // restored the menu — just bring the lobby back, no error.
        refreshLobby(n.connectedTo);
        return;
      }
      setConnStatus('未连接（检查服务器地址后点刷新）', false);
      // Only surface an error if a create/join attempt died with the socket;
      // an idle lobby socket closing must not block the menu.
      if (wasBusy) {
        showMenuError(wasTimeout ? '加入超时，请重试' : '连接已断开');
        restoreRoomSections(); // clear a stale '刷新中…' from a superseded refresh
      }
    }
  };
}

// Host mode: let HostRoom run the authoritative logic, then mirror its
// effects into this tab's own render/UI state (the host receives no casts).
function hostOnMsg(d, from) {
  if (!hostRoom || from == null || !d || typeof d.t !== 'string') return;
  const before = hostRoom.members.get(from);
  const wasHelloed = !!(before && before.helloed);
  hostRoom.handleMsg(from, d);
  const m = hostRoom.members.get(from);
  if (!m) return;
  if (d.t === 'hello' && !wasHelloed && m.helloed) {
    addRemote(from, m.name, m.p, m.ry, m.skin); // m.skin already host-validated
  } else if (d.t === 'move' && wasHelloed) {
    // m.p/m.ry hold the validated values (unchanged if the payload was bad).
    const info = remoteInfo.get(from);
    if (info) {
      info.p = m.p;
      info.ry = m.ry;
    }
    if (playing) {
      renderer.updatePlayer(from, m.p, m.ry, Number.isFinite(d.rx) ? d.rx : 0);
    }
  }
  // 'block' needs no mirror: HostRoom applied it via world.applyEdit and the
  // dirty pipeline remeshes the chunk in the loop.
}

// A position from the network must be a [x,y,z] array of finite numbers.
function validPos(p) {
  return Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
}

// Member mode: game messages forwarded by the host (no `from` id). The host
// is just another player's browser — same trust boundary as relay meta — so
// every shape startGame/renderer dereferences is validated here first.
function memberOnMsg(d) {
  if (!d || typeof d.t !== 'string') return;
  switch (d.t) {
    case 'joined':
      // A malformed payload must not crash between hideMenu() and
      // playing=true (that would brick the tab). Invalid -> ignore; the
      // join deadline recovers the menu. room is persisted (vc-history) and
      // rendered, so mirror the relay's 1–16 code point rule.
      if (typeof d.room !== 'string' || [...d.room].length < 1 || [...d.room].length > 16) {
        console.error('[vc] malformed joined payload — ignored');
        return;
      }
      if (!Array.isArray(d.players) || !d.players.every((q) => q && validPos(q.p))) {
        console.error('[vc] malformed joined payload — ignored');
        return;
      }
      d.edits = Array.isArray(d.edits)
        ? d.edits.filter((e) => Array.isArray(e) && e.length === 4 && e.every(Number.isFinite))
        : [];
      clearReplyTimer();
      busy = false;
      pendingAction = null;
      startGame(d);
      break;
    case 'pjoin':
      if (!playing || d.id === myId) return;
      addRemote(d.id, d.name, d.p, d.ry, d.skin);
      break;
    case 'pmove': {
      if (!playing || d.id === myId) return;
      if (!validPos(d.p)) return;
      // ry crosses the host trust boundary too: a non-finite value would NaN
      // the avatar's matrix permanently (renderer integrates angleDelta).
      const ry = Number.isFinite(d.ry) ? d.ry : 0;
      const info = remoteInfo.get(d.id);
      if (info) {
        info.p = d.p;
        info.ry = ry;
      }
      renderer.updatePlayer(d.id, d.p, ry, Number.isFinite(d.rx) ? d.rx : 0);
      break;
    }
    case 'pleave':
      if (!playing) return;
      dropRemote(d.id, true);
      break;
    case 'block':
      // Mirror host.js validation: an unchecked apply would pollute the
      // member's authoritative edit log (NaN keys, out-of-range ids) and
      // propagate after promotion.
      if (!world) return;
      if (
        !Number.isInteger(d.x) || !Number.isInteger(d.y) || !Number.isInteger(d.z) ||
        !Number.isInteger(d.id) || d.id < 0 || d.id > MAX_BLOCK_ID ||
        d.y < 0 || d.y >= HEIGHT
      ) return;
      world.applyEdit(d.x, d.y, d.z, d.id);
      break;
    case 'resync': {
      // Full edit-log snapshot from the new host after migration. Merge each
      // entry idempotently (world.applyEdit marks affected chunks dirty so the
      // loop remeshes them). Ignore unless we are a member with a live world.
      if (mode !== 'member' || !world) return;
      if (!Array.isArray(d.edits)) return;
      for (const e of d.edits) {
        // Same per-entry trust boundary as the 'block' path: integers, in-range
        // y and id. A poisoned entry from a malicious host would otherwise
        // pollute this member's authoritative edit log (and propagate if it is
        // later promoted).
        if (
          !Array.isArray(e) || e.length !== 4 ||
          !Number.isInteger(e[0]) || !Number.isInteger(e[1]) ||
          !Number.isInteger(e[2]) || !Number.isInteger(e[3]) ||
          e[1] < 0 || e[1] >= HEIGHT || e[3] < 0 || e[3] > MAX_BLOCK_ID
        ) continue;
        world.applyEdit(e[0], e[1], e[2], e[3]);
      }
      break;
    }
    default:
      break;
  }
}

// ---- remote player tracking (shared by both modes) ----
function addRemote(id, name, p, ry, skin) {
  if (!playing) return;
  // pjoin crosses the host trust boundary unvalidated: sanitize here (skin
  // collapses to {s:0,p:0}, name capped at 16, ry must be finite — mirroring
  // the host-side rules).
  if (!validPos(p)) p = [8, 40, 8];
  name = String(name ?? id).slice(0, 16);
  ry = Number.isFinite(ry) ? ry : 0;
  skin = cleanSkin(skin);
  remoteInfo.set(id, { name, p: [p[0], p[1], p[2]], ry, skin });
  renderer.addPlayer(id, name, skin);
  renderer.updatePlayer(id, p, ry, 0);
  setRoomLabel(roomCode, remoteInfo.size + 1);
  toast(name + ' 加入了房间');
  console.log('[vc] player joined', id, name);
}

function dropRemote(id, announce) {
  const info = remoteInfo.get(id);
  if (!info) return;
  remoteInfo.delete(id);
  renderer.removePlayer(id);
  if (playing) {
    setRoomLabel(roomCode, remoteInfo.size + 1);
    if (announce && info.name) toast(info.name + ' 离开了房间');
  }
  console.log('[vc] player left', id, info.name);
}

// ---- host migration ----
function handlePromote(msg) {
  if (!playing || !world) {
    // Accepted edge: promoted before receiving `joined` — no world to host
    // with. Disconnect so the relay promotes the next member.
    console.log('[vc] promoted without world state — disconnecting');
    if (net) net.close();
    return;
  }
  mode = 'host';
  roomCode = msg.room;
  currentHostId = -1;
  hostRoom = new HostRoom({
    net, world, room: msg.room, hostId: myId, hostName: myName, hostSkin: mySkin,
    playerRef: playerHandle,
  });
  const peers = Array.isArray(msg.peers) ? msg.peers : [];
  const adopted = new Map();
  for (const pid of peers) {
    if (pid === msg.oldHostId) continue;
    const info = remoteInfo.get(pid);
    if (info) {
      adopted.set(pid, { name: info.name, p: info.p, ry: info.ry, skin: info.skin });
    } else {
      // Peer the relay knows but we never saw helloed (e.g. its hello was in
      // flight to the old host): register as pending so its hello still works.
      hostRoom.handlePeerIn(pid);
    }
  }
  hostRoom.adoptMembers(adopted);
  // The relay's `peers` list is authoritative: any tracked player absent from
  // it left while the old host was dead/dying (its pleave was lost). Prune it
  // here and cast pleave so the other surviving members heal too. (The relay
  // flipped this connection's role to host before sending promote, so the
  // cast is accepted; members without the id ignore the pleave.)
  const live = new Set(peers);
  for (const id of [...remoteInfo.keys()]) {
    if (id !== msg.oldHostId && !live.has(id)) {
      dropRemote(id, true);
      net.cast({ t: 'pleave', id }, null);
    }
  }
  dropRemote(msg.oldHostId, false);
  // Resync: cast the new host's full edit log so every surviving member
  // converges on this tab's authoritative world, healing any divergence from
  // the dead-host window. Members merge it idempotently via world.applyEdit.
  net.cast(hostRoom.buildResync(), null);
  toast('你已接任房主');
  if (isTouchDevice()) acquireWakeLock();
  console.log('[vc] promoted to host, room', msg.room);
}

function handleNewHost(msg) {
  currentHostId = msg.hostId;
  // Re-hello the new host UNCONDITIONALLY (DESIGN: idempotent). Two windows
  // need it: (a) caught mid-join, our hello died with the old host and `joined`
  // will never come; (b) already playing but the new host never saw our hello
  // (it died with the old host before promotion), leaving us a ghost member on
  // its side — the re-hello makes it announce us via `pjoin`, closing the gap.
  // A host that already knows us just re-unicasts `joined`, which a playing
  // member ignores (startGame's playing guard).
  if (mode === 'member' && net) net.sendToHost({ t: 'hello', name: myName, skin: mySkin });
  if (!playing) return;
  const oldInfo = remoteInfo.get(msg.oldHostId);
  const oldName = (oldInfo && oldInfo.name) || String(msg.oldHostId);
  const newInfo = remoteInfo.get(msg.hostId);
  const newName = (newInfo && newInfo.name) || String(msg.hostId);
  dropRemote(msg.oldHostId, false);
  toast(oldName + ' 离开，' + newName + ' 接任房主');
  console.log('[vc] new host', msg.hostId, 'was', msg.oldHostId);
}

// ---- wake lock (hosting on touch devices: keep the authority tab alive) ----
async function acquireWakeLock() {
  if (wakeLock || wakeLockPending) return; // resolved or in flight
  wakeLockPending = true;
  try {
    const wl = await navigator.wakeLock?.request('screen');
    if (!wl) return;
    if (!playing || mode !== 'host') {
      // Session ended (or host role lost) while the request was in flight.
      wl.release().catch(() => {});
      return;
    }
    wakeLock = wl;
    wl.addEventListener('release', () => {
      if (wakeLock === wl) wakeLock = null;
    });
    console.log('[vc] wake lock acquired');
  } catch (err) {
    console.log('[vc] wake lock unavailable:', err && err.message);
  } finally {
    wakeLockPending = false;
  }
}

function releaseWakeLock() {
  const wl = wakeLock;
  wakeLock = null;
  if (wl) {
    try { wl.release().catch(() => {}); } catch (err) { /* already released */ }
  }
}

// ---- session lifecycle ----
// msg: {room, id, seed, players, edits} — the member's `joined` payload, or a
// host-built equivalent. In host mode `world` already exists (HostRoom holds it).
function startGame(msg) {
  // Network trust boundary: a duplicate 'joined' frame must not start a
  // second rAF loop / second world on top of a live session.
  if (playing) return;
  roomCode = msg.room;
  myId = msg.id;
  if (!world) world = new World(msg.seed);
  if (Array.isArray(msg.edits)) {
    for (const e of msg.edits) world.applyEdit(e[0], e[1], e[2], e[3]);
  }
  RADIUS = isTouchDevice() ? 3 : 4;
  renderer.setFogForRadius(RADIUS);

  // Generate the whole initial area synchronously around spawn column (8,8).
  while (world.ensureAround(8, 8, RADIUS, 16) > 0) { /* keep generating */ }

  // Initial load is exempt from the 2-meshes-per-frame budget: mesh everything.
  for (const key of Array.from(world.dirty)) {
    world.dirty.delete(key);
    const comma = key.indexOf(',');
    const cx = +key.slice(0, comma);
    const cz = +key.slice(comma + 1);
    renderer.updateChunk(world, cx, cz);
    meshed.set(key, [cx, cz]);
  }
  console.log('[vc] chunk-gen complete:', meshed.size, 'chunks');

  player = new Player(world, { x: 8.5, y: world.surfaceHeight(8, 8) + 1, z: 8.5 });

  hideMenu();
  setRoomLabel(roomCode, msg.players.length + 1);
  initControlsOnce();

  remoteInfo.clear();
  for (const p of msg.players) {
    // Host trust boundary, same rules as pjoin: skin collapses, name capped,
    // ry must be finite (NaN would poison the avatar transform forever).
    const skin = cleanSkin(p.skin);
    const name = String(p.name ?? p.id).slice(0, 16);
    const ry = Number.isFinite(p.ry) ? p.ry : 0;
    remoteInfo.set(p.id, { name, p: [p.p[0], p.p[1], p.p[2]], ry, skin });
    renderer.addPlayer(p.id, name, skin);
    renderer.updatePlayer(p.id, p.p, ry, 0);
  }

  playing = true;
  lastTime = performance.now();
  lastMoveSent = 0;
  rafId = requestAnimationFrame(loop);
  // 我的足迹: host=true only when this player created the room (sticky in ui.js).
  recordHistory(roomCode, mode === 'host');
  if (mode === 'host' && isTouchDevice()) acquireWakeLock();
  console.log('[vc] joined room', roomCode, 'as player', myId, '(' + mode + ')');
}

function stopGame() {
  playing = false;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (document.pointerLockElement && document.exitPointerLock) {
    document.exitPointerLock();
  }
  // Clear per-touch tracking (joystick anchor, look touches, jump ids, move
  // input) so a finger held across exit cannot drive or mis-trigger (ghost
  // break / joystick drift) the next session.
  if (touchReset) touchReset();
  releaseWakeLock();
  renderer.setHighlight(null);
  for (const cc of meshed.values()) renderer.removeChunk(cc[0], cc[1]);
  meshed.clear();
  farDirty.clear();
  lastPcx = null;
  lastPcz = null;
  for (const id of remoteInfo.keys()) renderer.removePlayer(id);
  remoteInfo.clear();
  player = null;
  world = null;
  roomCode = '';
  mode = null;
  hostRoom = null;
  currentHostId = -1;
}

// ---- game loop ----
function loop(now) {
  if (!playing) return;
  rafId = requestAnimationFrame(loop);

  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt < 0) dt = 0;
  if (dt > 0.05) dt = 0.05;

  if (touchTick) touchTick(now);

  player.update(dt);
  const px = player.pos.x;
  const py = player.pos.y;
  const pz = player.pos.z;
  const pcx = Math.floor(px / CHUNK);
  const pcz = Math.floor(pz / CHUNK);

  // On chunk-boundary crossing, re-queue parked far-dirty chunks that came
  // back into mesh range (bounded ring scan, not a farDirty-wide scan).
  if (pcx !== lastPcx || pcz !== lastPcz) {
    lastPcx = pcx;
    lastPcz = pcz;
    if (farDirty.size > 0) {
      const r = RADIUS + 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const key = chunkKey(pcx + dx, pcz + dz);
          if (farDirty.delete(key)) world.dirty.add(key);
        }
      }
    }
  }

  // budgeted chunk generation (<= 2 new chunks per frame)
  world.ensureAround(px, pz, RADIUS, 2);

  // rebuild <= 2 dirty chunks per frame, nearest first; out-of-range entries
  // are parked in farDirty so this scan stays bounded by the in-range set
  for (let n = 0; n < 2 && world.dirty.size > 0; n++) {
    let bestKey = null;
    let bestD = Infinity;
    let bcx = 0;
    let bcz = 0;
    for (const key of world.dirty) {
      const comma = key.indexOf(',');
      const cx = +key.slice(0, comma);
      const cz = +key.slice(comma + 1);
      const d = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
      if (d > RADIUS + 1) {
        world.dirty.delete(key);
        farDirty.set(key, [cx, cz]);
        continue;
      }
      if (d < bestD) {
        bestD = d;
        bestKey = key;
        bcx = cx;
        bcz = cz;
      }
    }
    if (bestKey === null) break;
    world.dirty.delete(bestKey);
    renderer.updateChunk(world, bcx, bcz);
    if (!meshed.has(bestKey)) meshed.set(bestKey, [bcx, bcz]);
  }

  // unload renderer chunks beyond RADIUS+1
  for (const [key, cc] of meshed) {
    if (Math.max(Math.abs(cc[0] - pcx), Math.abs(cc[1] - pcz)) > RADIUS + 1) {
      renderer.removeChunk(cc[0], cc[1]);
      meshed.delete(key);
      // Chunk stays generated in world but lost its mesh; park it so the
      // dirty pipeline rebuilds it when the player comes back in range.
      farDirty.set(key, cc);
    }
  }

  // aim highlight
  const eye = player.eye();
  const hit = world.raycast(eye, player.lookDir(), PLAYER.REACH);
  renderer.setHighlight(hit || null);

  // movement broadcast, throttled to ~12 Hz here in main
  if (now - lastMoveSent >= MOVE_INTERVAL) {
    lastMoveSent = now;
    _movP[0] = px;
    _movP[1] = py;
    _movP[2] = pz;
    if (mode === 'host' && hostRoom) {
      hostRoom.castOwnMove(_movP, player.yaw, player.pitch);
    } else if (net) {
      // serialized synchronously inside sendToHost, so the scratch array is safe
      net.sendToHost({ t: 'move', p: _movP, ry: player.yaw, rx: player.pitch });
    }
  }

  renderer.render(eye, player.yaw, player.pitch);
}

// ---- controls & block interaction ----
function initControlsOnce() {
  if (controlsInited) return;
  controlsInited = true;
  const hooks = {
    onBreak: doBreak,
    onPlace: doPlace,
    onSelect: selectSlot,
    getSelected: () => slot,
    isPlaying: () => playing,
  };
  initDesktopControls(canvas, playerHandle, hooks);
  if (isTouchDevice()) {
    const tc = initTouchControls(playerHandle, hooks);
    if (tc && typeof tc.tick === 'function') touchTick = tc.tick;
    if (tc && typeof tc.reset === 'function') touchReset = tc.reset;
  }
}

function sendBlockEdit(x, y, z, id) {
  if (mode === 'host' && hostRoom) hostRoom.castOwnBlock(x, y, z, id);
  else if (net) net.sendToHost({ t: 'block', x, y, z, id });
}

function doBreak() {
  if (!playing || !player || !world) return;
  const hit = world.raycast(player.eye(), player.lookDir(), PLAYER.REACH);
  if (!hit || hit.y <= 0) return; // y=0 layer is unbreakable
  world.setBlock(hit.x, hit.y, hit.z, BLOCK.AIR);
  sendBlockEdit(hit.x, hit.y, hit.z, BLOCK.AIR);
}

function doPlace() {
  if (!playing || !player || !world) return;
  const hit = world.raycast(player.eye(), player.lookDir(), PLAYER.REACH);
  if (!hit) return;
  const tx = hit.x + hit.face[0];
  const ty = hit.y + hit.face[1];
  const tz = hit.z + hit.face[2];
  if (ty < 1 || ty >= HEIGHT) return;
  if (world.getBlock(tx, ty, tz) !== BLOCK.AIR) return;
  if (blockIntersectsPlayer(tx, ty, tz)) return;
  const id = HOTBAR[slot];
  world.setBlock(tx, ty, tz, id);
  sendBlockEdit(tx, ty, tz, id);
}

function blockIntersectsPlayer(bx, by, bz) {
  const hw = PLAYER.WIDTH / 2;
  const p = player.pos;
  return bx < p.x + hw && bx + 1 > p.x - hw &&
         by < p.y + PLAYER.HEIGHT && by + 1 > p.y &&
         bz < p.z + hw && bz + 1 > p.z - hw;
}

// Debug handle for devtools and scripted testing — not used by game code.
window.__vc = {
  get world() { return world; },
  get player() { return player; },
  get playing() { return playing; },
  get roomCode() { return roomCode; },
  get myId() { return myId; },
  get mode() { return mode; },
  get hostRoom() { return hostRoom; },
  get remoteInfo() { return remoteInfo; },
  get net() { return net; },
  // v1 compat: Map<id, name>
  get remotePlayers() {
    const m = new Map();
    for (const [id, info] of remoteInfo) m.set(id, info.name);
    return m;
  },
  doBreak,
  doPlace,
  selectSlot,
};
