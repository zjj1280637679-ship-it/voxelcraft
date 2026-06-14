// main.js — orchestrator (DESIGN.md §F, v3 《永远的山根乡》). Boots the
// six-page menu + renderer, runs the zero-confirmation enter-world chain,
// drives the relay client in host or member mode, keeps the local world save
// fresh, runs the budgeted game loop, handles block interaction and host
// migration.

import { CHUNK, HEIGHT, BLOCK, HOTBAR, PLAYER, PALETTE, SKIN_TONES, BODIES, chunkKey } from './constants.js';
import {
  initUi, bindExit, getActiveChar, ensureCharacter, getHistory, getLastRoom,
  setLastRoom, getWorldSave, putWorldSave, normRoomKey, setEntryInfo,
  setRoomShowInfo, renderRoomSelect, recordHistory, showCreatePrompt,
  hideCreatePrompt, showMenuError, setConnStatus, hideMenu, setRoomLabel,
  buildHotbar, setHotbarSelection, onHotbarTap, toast, backToMenu,
} from './ui.js';
import { World } from './world.js';
import { SimDriver } from './sim/sim-driver.js';
import { perceive, buildTestArena } from './sim/perceive.js';
import { PROTO_BY_KEY } from './sim/prototypes.js';
import { effect, resolve } from './sim/effect.js';
import { WEAPONS } from './sim/modifiers.js';
import { Renderer } from './renderer.js';
import { Player } from './player.js';
import { initDesktopControls } from './controls-desktop.js';
import { isTouchDevice, initTouchControls } from './controls-touch.js';
import { RelayNet } from './network.js';
import { HostRoom } from './host.js';
import { startMenuBg } from './menubg.js';
import { Signals, RENDER_CONFIG, DEFAULT_PREFS, resolveWithPrefs } from './clientconfig.js';

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
let simDriver = null;        // pure sim kernel ↔ shell bridge (creatures); null when not in a game
// ---- client render-config (presentation-local; never enters the deterministic sim) ----
const renderSignals = new Signals();
let renderCfg = { resolution: 1, raytrace: true, framerate: 60 };
let cfgAcc = 0, lastRenderAt = 0, sigOverride = null;
let userPrefs = loadPrefs();   // the player's chosen ceilings (allowed max per knob), persisted
function loadPrefs() {
  try { const s = localStorage.getItem('vc-render-prefs'); if (s) return { ...DEFAULT_PREFS, ...JSON.parse(s) }; } catch (_) {}
  return { ...DEFAULT_PREFS };
}
function savePrefs() { try { localStorage.setItem('vc-render-prefs', JSON.stringify(userPrefs)); } catch (_) {} }
// re-resolve (player ceiling × adaptive pressure) and apply to the renderer. Called by the loop
// every 250ms AND immediately on a pref change so the UI readout never lags.
function applyRenderConfig() {
  renderCfg = resolveWithPrefs(userPrefs, { signals: sigOverride || renderSignals.values });
  renderer.setRenderScale(renderCfg.resolution);
}
let roomCode = '';           // the room's display name
let myId = -1;
let myName = '玩家';          // active character (ui.js owns storage/selection)
let mySkin = { b: 1, t: 0, p: 0, k: 1 }; // always a validated v2 skin
let pendingAction = null;    // 'join' | 'host' — lobby request awaiting a relay reply
let pendingRoom = '';        // room name of that request (find-first / taken-fallback)
let enterFlow = null;        // 'enter' | 'use' | 'create' — which UX started the chain
let stagedSave = null;       // {seed, edits} staged for a world-save rebuild host
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
let listInFlight = false;    // between listRooms() and `rooms` — statuses show 查询中…
let lastRoomsList = [];      // latest `rooms` reply, mapped to [{room, players}]
let worldSaveTimer = null;   // debounced (2 s) local world save (main may use timers)
let menuBg = null;           // running menubg handle ({stop}) | null
const MOVE_INTERVAL = 1000 / 12; // outbound move throttle (~12 Hz), lives here
const MENUBG_DEFAULT_SEED = 1337;

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
const _nullInput = { f: 0, b: 0, l: 0, r: 0, jump: false, down: 0, fire: false, useApple: false };
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

// ---- skin protocol v2 (the SHARED validation/migration rule) ----
// Implemented identically in host.js, here (member side + storage reads) and
// the tools bots. Checked in this order:
//   1. v2 shape {b,t,p,k} all integers in range -> copy as-is (drop extras);
//   2. legacy {s,p} integers 0..7 -> migrate {b:1, t:s, p:p, k:1};
//   3. anything else -> default {b:1, t:0, p:0, k:1}.
// Ranges per DESIGN: b 0..7 (BODIES), t/p 0..7 (PALETTE), k 0..5 (SKIN_TONES).
function cleanSkin(s) {
  if (s && typeof s === 'object') {
    if (
      Number.isInteger(s.b) && s.b >= 0 && s.b <= 7 &&
      Number.isInteger(s.t) && s.t >= 0 && s.t <= 7 &&
      Number.isInteger(s.p) && s.p >= 0 && s.p <= 7 &&
      Number.isInteger(s.k) && s.k >= 0 && s.k <= 5
    ) {
      return { b: s.b, t: s.t, p: s.p, k: s.k };
    }
    if (
      Number.isInteger(s.s) && s.s >= 0 && s.s <= 7 &&
      Number.isInteger(s.p) && s.p >= 0 && s.p <= 7
    ) {
      return { b: 1, t: s.s, p: s.p, k: 1 };
    }
  }
  return { b: 1, t: 0, p: 0, k: 1 };
}

// Highest legitimate block id (HOTBAR places 1..MAX, break sends 0/AIR).
const MAX_BLOCK_ID = Math.max(...Object.values(BLOCK));

// Active character (ui.js owns the storage; this is our session copy used for
// hello payloads, hosting meta and HostRoom identity).
function setActiveChar(ch) {
  if (!ch || typeof ch !== 'object') return;
  if (typeof ch.name === 'string' && ch.name.trim()) {
    myName = ch.name.trim().slice(0, 16);
  }
  mySkin = cleanSkin(ch.skin);
}

// Random Chinese room name for the no-last-room enter path (mirrors the ui.js
// generator: adjective + place + 2-digit number, always <= 16 code points).
const RAND_ADJ = ['迷雾', '晨曦', '黄昏', '星空', '翡翠', '琥珀', '风暴', '宁静', '炽热', '苍翠'];
const RAND_PLACE = ['森林', '山谷', '海岸', '平原', '洞穴', '群岛', '高原', '绿洲', '峡谷', '雪原'];
function randomRoomName() {
  const a = RAND_ADJ[(Math.random() * RAND_ADJ.length) | 0];
  const p = RAND_PLACE[(Math.random() * RAND_PLACE.length) | 0];
  return a + p + (10 + ((Math.random() * 90) | 0)); // 10..99: always 2 digits
}

// ---- boot ----
const icons = HOTBAR.map((id) => renderer.atlas.blockIcon(id));
buildHotbar(icons);
setHotbarSelection(slot);
onHotbarTap(selectSlot);
initUi({
  onEnterWorld,
  onUseRoom,
  onCreateRoom,
  onRefreshRooms,
  onServerChange,
});
bindExit(handleExit);
// Adopt the saved active character (null on a fresh install — the enter-world
// chain runs ensureCharacter() and fills the gap silently).
setActiveChar(getActiveChar());
startBg();
refreshMenuInfo();
// Lobby auto-connect: list public rooms for the initial server value (which
// ui.js just prefilled into #serverInput). Failure only colors the status
// line — it must never block the menu.
refreshLobby(currentServerSpec());
// Character/history edits happen inside ui.js without a dedicated callback;
// a cheap deferred recompute after any menu interaction keeps the entry/show
// info blocks and list statuses fresh (runs after ui.js handlers).
document.getElementById('menu')?.addEventListener('click', () => {
  if (!playing) setTimeout(refreshMenuInfo, 0);
});
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

// ---- menu background (menubg.js drives its own loop; main owns lifecycle) ----
function startBg() {
  if (menuBg) return;
  const cv = document.getElementById('menuBgCanvas');
  if (!cv) return;
  const last = getLastRoom();
  const save = last ? getWorldSave(last) : null;
  const seed = save && Number.isFinite(save.seed) ? save.seed : MENUBG_DEFAULT_SEED;
  menuBg = startMenuBg(cv, seed); // never throws (contract); no-op handle on failure
}

function stopBg() {
  if (!menuBg) return;
  try { menuBg.stop(); } catch (err) { /* defensive — stop() must not throw */ }
  menuBg = null;
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

// publicToggle drives the silent host paths too (default true when absent).
function defaultPublic() {
  const el = document.getElementById('publicToggle');
  return el ? !!el.checked : true;
}

// ---- menu info upkeep (DESIGN §F「Menu info upkeep」) ----
// Recomputed after boot, every `rooms` reply, and any lastRoom / character /
// history change while the menu is visible. Status strings are composed here.
function statusFor(name) {
  if (listInFlight) return '查询中…';
  if (!connected) return '未连接服务器';
  const key = normRoomKey(name);
  for (const r of lastRoomsList) {
    if (normRoomKey(r.room) === key) return '在线 ' + r.players + ' 人';
  }
  return getWorldSave(name) ? '不在线·有存档' : '不在线';
}

function refreshMenuInfo() {
  if (playing) return;
  const ch = getActiveChar();
  const last = getLastRoom();
  const history = getHistory();
  const ownKeys = new Set();
  for (const e of history) {
    if (e.host === true) ownKeys.add(normRoomKey(e.room));
  }
  const own = last ? ownKeys.has(normRoomKey(last)) : false;
  const status = last ? statusFor(last) : (connected ? '' : '未连接服务器');
  setEntryInfo({ charName: ch ? ch.name : '—', roomName: last, own, status });
  setRoomShowInfo({ roomName: last, own, status });
  renderRoomSelect({
    current: last ? { name: last, own, status } : null,
    history: history.map((e) => ({
      name: e.room,
      own: e.host === true,
      status: statusFor(e.room),
    })),
    // ui.js filters found against history keys and vc-hidden itself.
    found: lastRoomsList.map((r) => ({ name: r.room, players: r.players })),
  });
}

// Connect (or reconnect, if the server address changed or the socket died)
// and refresh the public room list. Never throws and never blocks the menu.
async function refreshLobby(server) {
  if (busy || playing) return;
  const seq = ++lobbySeq;
  listInFlight = true;
  refreshMenuInfo(); // 查询中… while the request is in flight
  try {
    await ensureConnected(server);
    if (seq !== lobbySeq || playing) return; // superseded by a newer action
    setConnStatus('已连接 · ' + serverLabel(server), true);
    net.listRooms();
    armLobbyTimer(seq);
  } catch (err) {
    console.log('[vc] lobby connect failed:', err && err.message);
    if (seq !== lobbySeq || playing) return;
    listInFlight = false;
    lastRoomsList = [];
    setConnStatus('未连接（检查服务器地址后点刷新）', false);
    refreshMenuInfo();
  }
}

function onRefreshRooms() {
  refreshLobby(currentServerSpec());
}

function onServerChange(spec) {
  refreshLobby(spec); // reconnect-if-changed lives in ensureConnected
}

function handleExit() {
  if (!playing || !net) return;
  leaving = true; // voluntary close: onClose shows no error message
  console.log('[vc] exit button pressed — leaving room');
  // Tear down synchronously: if the connection is already silently dead, the
  // browser's close event can take seconds, and the exit button must not
  // appear broken meanwhile. stopGame flushes the pending world save first.
  // onClose then takes the non-playing branch and uses `leaving` to restore
  // the lobby.
  stopGame();
  returnToMenu();
  net.close();
  // The close event can lag for seconds; until it fires the socket is
  // CLOSING and _send drops frames silently. Mark the session disconnected
  // now so ensureConnected never reuses it (it swaps and redials instead).
  connected = false;
}

// backToMenu lands on entryPage (ui.js); main restarts menubg and the info.
function returnToMenu(msg) {
  backToMenu(msg);
  startBg();
  refreshMenuInfo();
}

// ---- enter world (zero-confirmation chain, DESIGN「Enter-world algorithm」) ----
// entryPage 进入世界: ensureCharacter -> last room (join, falling back to a
// world-save rebuild or a fresh same-name world) or a brand-new random room.
function onEnterWorld() {
  if (busy || playing) return;
  setActiveChar(ensureCharacter()); // silently creates + activates if missing
  const last = getLastRoom();
  if (!last) {
    // No last room: random Chinese name, brand-new public world, no prompts.
    startHost(randomRoomName(), true, null, 'enter');
    return;
  }
  startJoin(last, 'enter');
}

// room row 「使用」 / roomEnterBtn / findRoomBtn — same chain; the only
// difference is the dead end: no room + no save -> showCreatePrompt.
function onUseRoom(name) {
  if (busy || playing) return;
  const room = String(name == null ? '' : name).trim();
  if (!room) {
    showMenuError('请输入房间名');
    return;
  }
  if ([...room].length > 16) {
    showMenuError('房间名需为 1–16 个字符');
    return;
  }
  setActiveChar(ensureCharacter());
  startJoin(room, 'use');
}

// createRoomBtn / createPrompt confirm — explicitly a NEW world: never stages
// a world save (a stale save must not hijack a deliberately fresh room).
function onCreateRoom(name, isPublic) {
  if (busy || playing) return;
  let room = String(name == null ? '' : name).trim();
  if (!room) room = randomRoomName();
  if ([...room].length > 16) {
    showMenuError('房间名需为 1–16 个字符');
    return;
  }
  setActiveChar(ensureCharacter());
  startHost(room, !!isPublic, null, 'create');
}

// Step 2 of the chain: try joining first. `no-room` forks in onError (save
// rebuild / silent create / create prompt, depending on enterFlow).
async function startJoin(room, flow) {
  busy = true;
  lobbySeq++; // supersede any in-flight lobby refresh
  listInFlight = false;
  hideCreatePrompt();
  enterFlow = flow;
  stagedSave = null;
  pendingAction = 'join';
  pendingRoom = room;
  try {
    await ensureConnected(currentServerSpec());
    setConnStatus('已连接 · ' + serverLabel(currentServerSpec()), true);
    net.joinRoom(room);
    armReplyTimer();
  } catch (err) {
    connectFail(err);
  }
}

// Host a room. saved = {seed, edits} when rebuilding from a local world save
// (世界不消失), null for a fresh world. `taken` falls back to join in onError.
async function startHost(room, isPublic, saved, flow) {
  busy = true;
  lobbySeq++; // supersede any in-flight lobby refresh
  listInFlight = false;
  hideCreatePrompt();
  enterFlow = flow;
  stagedSave = saved || null;
  pendingAction = 'host';
  pendingRoom = room;
  try {
    await ensureConnected(currentServerSpec());
    setConnStatus('已连接 · ' + serverLabel(currentServerSpec()), true);
    net.hostRoom({ room, public: !!isPublic, meta: { n: myName.slice(0, 24) } });
    armReplyTimer();
  } catch (err) {
    connectFail(err);
  }
}

function connectFail(err) {
  busy = false;
  pendingAction = null;
  stagedSave = null;
  console.error('[vc] connect failed:', err);
  setConnStatus('未连接（检查服务器地址后点刷新）', false);
  showMenuError('无法连接服务器');
  refreshMenuInfo();
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
// socket) would otherwise leave the lobby stuck on 查询中… forever. On expiry
// mark the session disconnected and color the status line; a future refresh
// redials. Guarded by lobbySeq so a superseded refresh's timer is inert.
function armLobbyTimer(seq) {
  clearLobbyTimer();
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    if (seq !== lobbySeq || playing) return; // superseded or in a game
    console.log('[vc] room list never arrived — marking disconnected');
    connected = false;
    listInFlight = false;
    lastRoomsList = [];
    setConnStatus('未连接（检查服务器地址后点刷新）', false);
    refreshMenuInfo();
  }, 10000);
}

function clearLobbyTimer() {
  if (lobbyTimer !== null) {
    clearTimeout(lobbyTimer);
    lobbyTimer = null;
  }
}

// Relay error code -> user-facing message.
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
    let seed;
    let savedEdits = null;
    if (stagedSave && Number.isFinite(stagedSave.seed)) {
      // World-save rebuild: the room is reborn from {seed, edits} (世界不消失).
      seed = Math.floor(stagedSave.seed);
      savedEdits = stagedSave.edits;
      console.log('[vc] rebuilding room from local save', room,
        'seed', seed, Array.isArray(savedEdits) ? savedEdits.length : 0, 'edits');
    } else {
      seed = Math.floor(Math.random() * 2 ** 31);
    }
    stagedSave = null;
    world = World.load(seed, savedEdits); // filters + applies edits via applyEdit
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
      // Expected find-first outcome. Fork (DESIGN §F point 1):
      //   (a) local world save -> host with the saved {seed, edits};
      //   (b) no save, enter-world flow -> silent same-name fresh world;
      //   (c) no save, use/find flow -> create prompt (busy must clear).
      const room = pendingRoom;
      if (enterFlow === 'create') {
        // Double race: lost the create (`taken` -> join fallback) and the
        // racing room died within the RTT. 建立新房间 = 全新世界 — a stale
        // save must never hijack it, and the user already confirmed once,
        // so never re-prompt: just re-issue a fresh host.
        console.log('[vc] create race lost and room died — re-hosting fresh:', room);
        pendingAction = 'host';
        stagedSave = null;
        n.hostRoom({ room, public: defaultPublic(), meta: { n: myName.slice(0, 24) } });
        armReplyTimer();
        return;
      }
      const save = getWorldSave(room);
      if (save && Number.isFinite(save.seed)) {
        console.log('[vc] room offline — rebuilding from local save:', room);
        pendingAction = 'host';
        stagedSave = { seed: save.seed, edits: Array.isArray(save.edits) ? save.edits : [] };
        n.hostRoom({ room, public: defaultPublic(), meta: { n: myName.slice(0, 24) } });
        armReplyTimer();
        return;
      }
      if (enterFlow === 'enter') {
        console.log('[vc] room not found — creating fresh world:', room);
        pendingAction = 'host';
        stagedSave = null;
        n.hostRoom({ room, public: defaultPublic(), meta: { n: myName.slice(0, 24) } });
        armReplyTimer();
        return;
      }
      busy = false;
      pendingAction = null;
      showMenuError('');
      showCreatePrompt(room); // ui.js auto-creates once for a generated name
      refreshMenuInfo();
      return;
    }
    if (code === 'taken' && pendingAction === 'host') {
      // Lost the create race — the room exists now, so just join it. Staged
      // save edits are discarded: the live room wins.
      console.log('[vc] room taken — joining instead:', pendingRoom);
      pendingAction = 'join';
      stagedSave = null;
      n.joinRoom(pendingRoom);
      armReplyTimer();
      return;
    }
    busy = false;
    pendingAction = null;
    stagedSave = null;
    showMenuError(errorText(code));
    refreshMenuInfo();
  };

  n.onRooms = (rooms) => {
    clearLobbyTimer();
    listInFlight = false;
    if (playing) return;
    // Relay trust boundary: the server address is user-supplied, so list
    // entries can be anything — drop non-objects before dereferencing.
    lastRoomsList = rooms
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ room: String(r.room ?? ''), players: Number(r.players) || 0 }));
    refreshMenuInfo();
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
    stagedSave = null;
    clearReplyTimer();
    clearLobbyTimer();
    listInFlight = false;
    console.log('[vc] ws closed');
    if (playing) {
      stopGame(); // flushes the pending world save
      // Voluntary exit shows no error; an unexpected drop does.
      returnToMenu(wasLeaving ? undefined : '连接已断开');
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
      }
      refreshMenuInfo();
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
  if (d.t === 'block') {
    // HostRoom applied a valid edit via world.applyEdit (the dirty pipeline
    // remeshes the chunk in the loop) — keep the local world save fresh.
    scheduleWorldSave();
    return;
  }
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
      // Same per-entry trust boundary as the 'resync' path (DESIGN: joined.edits
      // gets the identical filter — integers, in-range y and id). A poisoned
      // entry would otherwise enter world.edits and the initial putWorldSave,
      // then be silently dropped on a later World.load rebuild (lost edits).
      d.edits = Array.isArray(d.edits)
        ? d.edits.filter((e) =>
            Array.isArray(e) && e.length === 4 &&
            Number.isInteger(e[0]) && Number.isInteger(e[1]) &&
            Number.isInteger(e[2]) && Number.isInteger(e[3]) &&
            e[1] >= 0 && e[1] < HEIGHT && e[3] >= 0 && e[3] <= MAX_BLOCK_ID)
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
      scheduleWorldSave();
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
      scheduleWorldSave();
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
  // through the shared v2 rule, name capped at 16, ry must be finite —
  // mirroring the host-side rules).
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

// ---- local world save upkeep (DESIGN「世界本地存档」; host AND members) ----
// Every world mutation schedules a save debounced 2 s (trailing edge kept:
// continuous building still persists at least every ~2 s). The timer lives
// here — the no-timer rule binds host.js only. Flushed synchronously on
// stopGame / exit / disconnect.
function scheduleWorldSave() {
  if (!playing || !world) return;
  if (worldSaveTimer !== null) return;
  worldSaveTimer = setTimeout(() => {
    worldSaveTimer = null;
    flushWorldSave();
  }, 2000);
}

function flushWorldSave() {
  if (worldSaveTimer !== null) {
    clearTimeout(worldSaveTimer);
    worldSaveTimer = null;
  }
  if (!world || !roomCode) return;
  putWorldSave(roomCode, world.seed, world.serializeEdits());
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
  // §0.7: the player is an object bound to the 'player' prototype. 变身术 rebinds this
  // to a creature/boss code; the uid tag travels with the identity-core so player-bane
  // still finds "you" through any form (用代号不用名字,防同义字乌龙).
  player.form = 'player';
  player.uidTag = '玩家.' + (myId >= 0 ? myId : 'me');
  player.baseSkin = { ...mySkin };

  hideMenu();
  stopBg(); // menubg never runs (loop + GL) behind a live game session
  setRoomLabel(roomCode, msg.players.length + 1);
  initControlsOnce();

  remoteInfo.clear();
  for (const p of msg.players) {
    // Host trust boundary, same rules as pjoin: skin through the shared v2
    // rule, name capped, ry finite (NaN would poison the avatar transform).
    const skin = cleanSkin(p.skin);
    const name = String(p.name ?? p.id).slice(0, 16);
    const ry = Number.isFinite(p.ry) ? p.ry : 0;
    remoteInfo.set(p.id, { name, p: [p.p[0], p.p[1], p.p[2]], ry, skin });
    renderer.addPlayer(p.id, name, skin);
    renderer.updatePlayer(p.id, p.p, ry, 0);
  }

  // Pure sim kernel: spawn a couple of skittish fowl near spawn (placeholder 小人
  // model — all creatures render as the avatar until real models land, 显现可换数据).
  simDriver = new SimDriver(renderer, world);
  // Spawn a MIX by string CODE (generality: each is just a registry entry — distinct
  // speed/skittishness from data alone, zero kernel change). All render as 小人 (占位).
  simDriver.spawn('fowl_small', 'skittish_flee', 12.5, 11.5, 0x1a2b3c);
  simDriver.spawn('rabbit',     'jumpy_flee',     5.5, 13.5, 0x4d5e6f);
  simDriver.spawn('golem',      'fearless',      14.5,  6.5, 0x778899);

  playing = true;
  lastTime = performance.now();
  lastMoveSent = 0;
  rafId = requestAnimationFrame(loop);
  // Session bookkeeping: last room + 足迹 (host = 创建过, sticky in ui.js) +
  // the immediate initial world save (members save too — every player who
  // entered the room can rebuild it later; that is the 「世界不消失」 point).
  setLastRoom(roomCode);
  recordHistory(roomCode, mode === 'host');
  putWorldSave(roomCode, world.seed, world.serializeEdits());
  if (mode === 'host' && isTouchDevice()) acquireWakeLock();
  console.log('[vc] joined room', roomCode, 'as player', myId, '(' + mode + ')');
}

function stopGame() {
  flushWorldSave(); // synchronous, before the world is torn down
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
  if (simDriver) { simDriver.clear(); simDriver = null; }
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
  const rawDtMs = now - lastTime;        // un-clamped frame delta, for the pressure probe
  lastTime = now;
  if (dt < 0) dt = 0;
  if (dt > 0.05) dt = 0.05;

  // client render-config: sample pressure, re-resolve 4×/s, apply resolution (presentation-only).
  renderSignals.sample(rawDtMs);
  cfgAcc += rawDtMs;
  if (cfgAcc >= 250) { cfgAcc = 0; applyRenderConfig(); }

  if (touchTick) touchTick(now);

  player.update(dt);
  if (simDriver) simDriver.tick(dt, player.pos);
  // dragon-form actions: G eats the 变龙苹果 (toggle form), F breathes fire (cooldown).
  if (player.input.useApple) { player.input.useApple = false; toast(useItem('dragon_apple')); }
  if (fireCd > 0) fireCd -= dt;
  if (player.input.fire && fireCd <= 0) {
    const pf = PROTO_BY_KEY.get(player.form);
    if (pf && pf.fire) { breatheFire(); fireCd = 0.25; }
  }
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

  // framerate cap (presentation): skip the draw if under the resolved budget (sim still advances).
  const minFrame = 1000 / (renderCfg.framerate || 60);
  if (now - lastRenderAt >= minFrame - 2) {
    lastRenderAt = now;
    renderer.render(eye, player.yaw, player.pitch);
  }
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
  scheduleWorldSave();
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
  scheduleWorldSave();
}

function blockIntersectsPlayer(bx, by, bz) {
  const hw = PLAYER.WIDTH / 2;
  const p = player.pos;
  return bx < p.x + hw && bx + 1 > p.x - hw &&
         by < p.y + PLAYER.HEIGHT && by + 1 > p.y &&
         bz < p.z + hw && bz + 1 > p.z - hw;
}

// Debug handle for devtools and scripted testing — not used by game code.
// ---- perception / 变身术 play helpers (exposed on __vc; drive the game by code) ----
let vcMarks = null;   // default mark selector used by __vc.perceive() when none passed

// A form's placeholder avatar skin, derived from its protoId (valid by construction —
// real models land later, 显现可换数据). The 'player' form restores your own skin.
function skinForForm(proto) {
  const id = (proto.protoId >>> 0) + 1;
  return cleanSkin({
    b: id % BODIES.length,
    t: (id * 3 + 2) % PALETTE.length,
    p: (id * 5 + 1) % PALETTE.length,
    k: id % SKIN_TONES.length,
  });
}

function rebroadcastSkin() {
  // best-effort: let other players see the new form (member→host hello re-announces skin)
  try { if (mode === 'member' && net) net.sendToHost({ t: 'hello', name: myName, skin: mySkin }); } catch (_) {}
}

// 变身术: rebind the player's identity to another prototype (boss / creature). No
// player-special code — the same registry the kernel reads for a dragon. Display
// (skin) is bound data and swaps with zero kernel change.
function transformPlayer(formKey) {
  if (!player) return '未进入游戏';
  const proto = PROTO_BY_KEY.get(formKey);
  if (!proto) return '未知形态: ' + formKey + ' — 可用: ' + [...PROTO_BY_KEY.keys()].join(', ');
  player.form = formKey;
  player.fly = !!proto.fly;                    // 会飞的形态(龙)→ 关重力,进入飞行
  if (!player.fly) { player.input.jump = false; player.input.down = 0; }
  mySkin = formKey === 'player' ? cleanSkin(player.baseSkin) : skinForForm(proto);
  rebroadcastSkin();
  const tags = proto.tags.concat(player.uidTag ? [player.uidTag] : []);
  const caps = [proto.fly ? '会飞' : null, proto.fire ? '会喷火' : null].filter(Boolean).join('·');
  return `🪄 变身 → ${proto.name}(${formKey}) [${tags.join(',')}] hp上限${proto.hp}${caps ? ' ' + caps : ''}`;
}

// 使用物品:读 proto.use 数据决定效果(无物品专用代码)。变龙苹果 → 变身;再吃一次变回。
function useItem(key) {
  const proto = PROTO_BY_KEY.get(key);
  if (!proto || !proto.use) return '该物品不可使用: ' + key;
  if (proto.use.kind === 'transform') {
    const target = (player && player.form === proto.use.form) ? 'player' : proto.use.form;
    return `🍎 吃下${proto.name} → ` + transformPlayer(target);
  }
  return '未知使用效果: ' + proto.use.kind;
}

// nudge altitude (drive flight by code, like walk drives the plane). Needs a flying form.
function flyPlayer(dy) {
  if (!player) return '未进入游戏';
  if (!player.fly) return '当前形态不会飞(先变身成龙)';
  player.pos.y += Number(dy) || 0;
  return `升降 ${dy} → 高度 y=${player.pos.y.toFixed(1)}`;
}

// 8 baked headings (match kernel DIRS order) for picking a projectile's launch index.
const FIRE_DIRS = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];
let fireCd = 0;   // seconds until the dragon can breathe again

// 喷火: the dragon's breath weapon. Forward cone → EffectResolver applies fire to every
// creature in range (HP drop / kill); plus a few short-lived fire motes for the visual.
// 火也用攻击器产伤 = 复用 effect(),无独立火系统。
function breatheFire() {
  if (!player || !simDriver) return '未进入游戏';
  const proto = PROTO_BY_KEY.get(player.form);
  const fire = proto && proto.fire;
  if (!fire) return '当前形态不会喷火(先变身成龙)';
  // forward horizontal heading from yaw (yaw 0 looks toward -z)
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const px = player.pos.x, pz = player.pos.z, py = player.pos.y;
  const R = 8, COS = 0.6;            // range 8 blocks, cone half-angle ~53°
  const atkTags = proto.tags.concat(player.uidTag ? [player.uidTag] : []);  // the dragon's own tags
  const atkPack = { mods: fire.mods, use: fire.use, only: fire.only, except: fire.except };
  const hits = [], kills = [];
  for (const e of [...simDriver.state.ents.values()]) {
    const ep = PROTO_BY_KEY.get(e.m.p);
    if (!ep || ep.fly) continue;     // don't torch our own fire motes
    const dx = e.x - px, dz = e.z - pz;
    const d = Math.hypot(dx, dz);
    if (d < 0.001 || d > R) continue;
    if ((dx * fx + dz * fz) / d < COS) continue;   // outside the cone
    // two-sided: dragon offense (fire) vs target tags + target defense (combat.def) vs dragon tags
    const dmg = resolve(fire.base, atkPack, ep.tags, ep.combat && ep.combat.def, atkTags);
    e.hp = Math.round((e.hp - dmg) * 10) / 10;
    if (e.hp <= 0) { simDriver.kill(e.id); kills.push(ep.name); }
    else hits.push(`${ep.name}(-${dmg.toFixed(0)}→hp${e.hp})`);
  }
  // 1-2 visible fire motes along the nearest baked heading
  let bi = 0, best = -Infinity;
  for (let i = 0; i < 8; i++) { const dot = FIRE_DIRS[i][0] * fx + FIRE_DIRS[i][1] * fz; if (dot > best) { best = dot; bi = i; } }
  for (let n = 1; n <= 2; n++) simDriver.spawnProjectile('fire', 'fire_breath', px + fx * n, py + 1, pz + fz * n, bi, 0xf1 * n);
  return `🔥 喷火 命中${hits.length}${kills.length ? ' 烧死[' + kills.join(',') + ']' : ''}${hits.length ? ': ' + hits.join(' ') : ''}`;
}

// Nudge the player across the plane by a compass direction (drive navigation by reading
// perceive() → walk → perceive). Diagonals move one block per axis.
const COMPASS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0], NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1] };
function walkPlayer(compass, blocks) {
  if (!player) return '未进入游戏';
  const d = COMPASS[String(compass || '').toUpperCase()];
  if (!d) return '方向? 用 N/S/E/W/NE/NW/SE/SW';
  const n = Number(blocks) || 1;
  player.pos.x += d[0] * n;
  player.pos.z += d[1] * n;
  return `走 ${String(compass).toUpperCase()} ${n} → @(${player.pos.x.toFixed(1)},${player.pos.z.toFixed(1)})`;
}

// Run the EffectResolver for a weapon vs a target (self form / proto code / entity id).
// Proves the data path: who you ARE (your form's tags) decides what a weapon does to you.
function computeHit(weaponKey, target) {
  const w = WEAPONS[weaponKey] || WEAPONS.fist;
  let defTags = [], defPack = {}, label = '?';
  if (target == null || target === 'self') {
    const f = player && player.form ? PROTO_BY_KEY.get(player.form) : null;
    defTags = f ? f.tags.concat(player.uidTag ? [player.uidTag] : []) : [];
    defPack = (f && f.combat && f.combat.def) || {};
    label = '你(' + (f ? f.name : '?') + ')';
  } else if (typeof target === 'number') {
    const e = simDriver && simDriver.state.ents.get(target);
    const f = e && PROTO_BY_KEY.get(e.m.p);
    defTags = f ? f.tags : []; defPack = (f && f.combat && f.combat.def) || {}; label = f ? f.name : '#' + target;
  } else {
    const f = PROTO_BY_KEY.get(target);
    defTags = f ? f.tags : []; defPack = (f && f.combat && f.combat.def) || {}; label = f ? f.name : String(target);
  }
  // attacker tags = your form tags (+uid) + the weapon's own damage-type tags (drive defender armour)
  const af = player && player.form ? PROTO_BY_KEY.get(player.form) : null;
  const atkTags = (af ? af.tags : []).concat(player && player.uidTag ? [player.uidTag] : []).concat(w.tags || []);
  const atkPack = { mods: w.mods, use: w.use, only: w.only, except: w.except };
  const v = resolve(w.base, atkPack, defTags, defPack, atkTags);
  const kind = v > 0 ? `伤害 ${v.toFixed(1)}` : (v < 0 ? `回血 ${(-v).toFixed(1)} (被按摩)` : '免疫 0');
  return `${w.name}→${label}[${defTags.join(',')}]: ${kind}`;
}

// ---- in-game settings page: player drives the global quality CEILINGS (实际随算力自适应降低) ----
const SEG = {
  resolution: [['省电', 0.5], ['标准', 1], ['高', 1.5], ['极致', 2]],
  raytrace: [['关', false], ['开', true]],
  framerate: [['30', 30], ['60', 60], ['120', 120]],
};
const SEG_EL = { resolution: 'segResolution', raytrace: 'segRaytrace', framerate: 'segFramerate' };
let settingsInited = false;
let settingsTimer = null;

function refreshSegs() {
  for (const key in SEG_EL) {
    const el = document.getElementById(SEG_EL[key]);
    if (!el) continue;
    for (const b of el.children) b.classList.toggle('active', JSON.parse(b.dataset.val) === userPrefs[key]);
  }
}
function refreshActual() {
  const el = document.getElementById('settingsActual');
  if (!el) return;
  const r = renderCfg, fps = (sigOverride || renderSignals.values).fps;
  const res = `分辨率 ≤${userPrefs.resolution}×${r.resolution !== userPrefs.resolution ? ' → 当前 ' + r.resolution + '×(自适应)' : ''}`;
  const rt = `光追 ${userPrefs.raytrace ? '开' : '关'}${r.raytrace !== userPrefs.raytrace ? ' → 当前 ' + (r.raytrace ? '开' : '关') : ''}`;
  const fr = `帧率 ≤${userPrefs.framerate}${r.framerate !== userPrefs.framerate ? ' → 当前 ' + r.framerate : ''}`;
  el.textContent = `${res}　${rt}　${fr}　(实时 ${fps}fps)`;
}
function openSettings() {
  try { if (document.exitPointerLock) document.exitPointerLock(); } catch (_) {}
  document.getElementById('settingsPanel').classList.remove('hidden');
  refreshSegs(); refreshActual();
  settingsTimer = setInterval(refreshActual, 400);
}
function closeSettings() {
  document.getElementById('settingsPanel').classList.add('hidden');
  if (settingsTimer) { clearInterval(settingsTimer); settingsTimer = null; }
}
function initSettingsUI() {
  if (settingsInited) return;
  settingsInited = true;
  for (const key in SEG_EL) {
    const el = document.getElementById(SEG_EL[key]);
    if (!el) continue;
    el.innerHTML = '';
    for (const [label, val] of SEG[key]) {
      const b = document.createElement('button');
      b.className = 'seg-btn';
      b.textContent = label;
      b.dataset.val = JSON.stringify(val);
      b.addEventListener('click', () => { userPrefs[key] = val; savePrefs(); applyRenderConfig(); refreshSegs(); refreshActual(); });
      el.appendChild(b);
    }
  }
  const btn = document.getElementById('settingsBtn');
  if (btn) {
    btn.addEventListener('click', openSettings);
    btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  }
  const closeBtn = document.getElementById('settingsCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeSettings);
  const exitBtn = document.getElementById('exitBtn');           // exit lives in the panel; also close it
  if (exitBtn) exitBtn.addEventListener('click', closeSettings);
}
initSettingsUI();

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
  get simDriver() { return simDriver; },   // pure sim kernel bridge (creatures)
  get renderer() { return renderer; },     // for debugging avatar/scene state
  // perceive(11)  or  perceive({radius, step, marks})  — `marks` overrides the default
  // set from __vc.mark(...). step = 增减像素(blocks/char). marks = 'all' | 'golem' | [ids] | fn.
  perceive(opts) {
    const o = (typeof opts === 'number') ? { radius: opts } : (opts || {});
    return perceive({ world, simDriver, player, marks: vcMarks, radius: 10, ...o });
  },
  mark(filter) { vcMarks = filter ?? null; return '标记选择器 = ' + JSON.stringify(filter ?? null); },
  transform: transformPlayer,                  // 变身术
  use: useItem,                               // 吃物品:use('dragon_apple') = 变身/变回
  forms() { return [...PROTO_BY_KEY.keys()]; }, // 可变身的形态代号
  walk: walkPlayer,                            // 用感知器导航:perceive → walk → perceive
  fly: flyPlayer,                             // 龙形升降:fly(5) 上升 / fly(-3) 下降
  breathe: breatheFire,                       // 喷火(锥形 EffectResolver 伤害 + 火焰投射物)
  hit: computeHit,                            // EffectResolver 试算:hit('wood_shovel','self')
  // client render-config (presentation-local): inspect resolved knobs + override signals for testing
  get renderConfig() { return { prefs: userPrefs, resolved: renderCfg, signals: sigOverride || renderSignals.values, config: RENDER_CONFIG }; },
  setPref(k, v) { userPrefs[k] = v; savePrefs(); applyRenderConfig(); refreshSegs(); refreshActual(); return userPrefs; },   // player ceiling
  simSignal(obj) { sigOverride = obj || null; return sigOverride; },   // e.g. simSignal({fps:25,gpu:0.95})
  testArena() { return buildTestArena({ world, simDriver, renderer, player, spawn: (...a) => simDriver.spawn(...a) }); },
  // Local world-save entry: live session snapshot in the vc-worlds format.
  get worldSave() {
    return world && roomCode
      ? { room: roomCode, seed: world.seed, edits: world.serializeEdits() }
      : null;
  },
  flushWorldSave,
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
