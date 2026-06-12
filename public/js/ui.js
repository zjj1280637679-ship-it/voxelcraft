// UI shell: two-page menu (profile/characters + lobby), HUD, hotbar, toasts.
// DOM only — no three.js, no network or game knowledge. Owns character
// storage: localStorage 'vc-chars' = JSON [{name, skin:{s,p}}], 'vc-active'
// = active index; and room history 'vc-history' = JSON [{room, host, t}].
// Names and room names are user/attacker content: rendered exclusively via
// textContent, never innerHTML.

import { PALETTE } from './constants.js';

const $ = (id) => document.getElementById(id);

const SKIN_TONE = '#e0ac69'; // avatar head color (matches renderer)

let hotbarTapCb = null;
let hotbarBound = false;

// ---------- guarded storage (private mode / blocked site data can throw) ----

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

// ---------- character store ----------

let chars = [];        // [{name, skin:{s,p}}]
let activeIndex = -1;
let charPickedCb = null;

function sanitizeSkin(skin) {
  const ok = (v) => Number.isInteger(v) && v >= 0 && v < PALETTE.length;
  return {
    s: skin && ok(skin.s) ? skin.s : 0,
    p: skin && ok(skin.p) ? skin.p : 0,
  };
}

function loadChars() {
  chars = [];
  const raw = lsGet('vc-chars');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const name = c && typeof c.name === 'string' ? c.name.trim().slice(0, 16) : '';
          if (!name) continue;
          chars.push({ name, skin: sanitizeSkin(c.skin) });
        }
      }
    } catch (e) { /* corrupted JSON -> start fresh */ }
  }
  const ai = Number(lsGet('vc-active'));
  activeIndex = Number.isInteger(ai) && ai >= 0 && ai < chars.length
    ? ai
    : (chars.length ? 0 : -1);
}

function persistChars() {
  lsSet('vc-chars', JSON.stringify(chars));
  lsSet('vc-active', String(activeIndex));
}

export function getActiveChar() {
  if (activeIndex < 0 || activeIndex >= chars.length) return null;
  const c = chars[activeIndex];
  return { name: c.name, skin: { s: c.skin.s, p: c.skin.p } };
}

// ---------- avatar preview ----------

// Front view of the boxy avatar, renderer proportions: head 0.5 wide/tall
// (skin tone), torso 0.6x0.6 (shirt), legs 0.6x0.6 (pants) — 1.7 units tall.
function drawAvatar(canvas, skin) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const sk = sanitizeSkin(skin);
  const u = Math.min(h / 1.9, w / 0.75);
  const top = Math.round((h - 1.7 * u) / 2);
  const cx = w / 2;
  const box = (color, x, y, bw, bh) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(bw), Math.round(bh));
  };
  box(SKIN_TONE, cx - 0.25 * u, top, 0.5 * u, 0.5 * u);
  box(PALETTE[sk.s], cx - 0.3 * u, top + 0.5 * u, 0.6 * u, 0.6 * u);
  box(PALETTE[sk.p], cx - 0.3 * u, top + 1.1 * u, 0.6 * u, 0.6 * u);
  // blocky 3D hint: darker right edge + leg gap
  box('rgba(0,0,0,0.18)', cx + 0.13 * u, top, 0.12 * u, 0.5 * u);
  box('rgba(0,0,0,0.18)', cx + 0.18 * u, top + 0.5 * u, 0.12 * u, 1.2 * u);
  box('rgba(0,0,0,0.25)', cx - 1, top + 1.12 * u, 2, 0.58 * u);
}

// ---------- menu pages ----------

function showPage(which) {
  $('profilePage').classList.toggle('active', which === 'profile');
  $('lobbyPage').classList.toggle('active', which === 'lobby');
}

function updateActiveCharLabel() {
  const c = getActiveChar();
  $('activeCharLabel').textContent = '人物：' + (c ? c.name : '—');
}

// ---------- character editor ----------

let editIndex = -1;            // index being edited; -1 = creating new
let editSkin = { s: 0, p: 0 };

function buildSwatchRow(rowEl, key) {
  rowEl.textContent = '';
  for (let i = 0; i < PALETTE.length; i++) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.style.backgroundColor = PALETTE[i];
    sw.setAttribute('aria-label', (key === 's' ? '上衣颜色 ' : '裤子颜色 ') + (i + 1));
    sw.addEventListener('click', () => {
      editSkin[key] = i;
      refreshSwatches();
      drawAvatar($('charPreview'), editSkin);
    });
    rowEl.appendChild(sw);
  }
}

function refreshSwatches() {
  const mark = (rowEl, sel) => {
    const kids = rowEl.children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('selected', i === sel);
  };
  mark($('shirtSwatches'), editSkin.s);
  mark($('pantsSwatches'), editSkin.p);
}

function openEditor(i) {
  editIndex = i;
  const c = i >= 0 ? chars[i] : null;
  $('charEditorTitle').textContent = c ? '编辑人物' : '新建人物';
  $('charNameInput').value = c ? c.name : '';
  editSkin = c
    ? { s: c.skin.s, p: c.skin.p }
    : { s: chars.length % PALETTE.length, p: (chars.length + 3) % PALETTE.length };
  $('deleteCharBtn').classList.toggle('hidden', i < 0);
  $('charPicker').classList.add('hidden');
  $('charEditor').classList.add('show');
  refreshSwatches();
  drawAvatar($('charPreview'), editSkin);
}

function closeEditor() {
  editIndex = -1;
  $('charEditor').classList.remove('show');
  $('charPicker').classList.remove('hidden');
  renderCharList();
}

function saveChar() {
  const name = $('charNameInput').value.trim().slice(0, 16);
  if (!name) { toast('请输入名字'); $('charNameInput').focus(); return; }
  const ch = { name, skin: { s: editSkin.s, p: editSkin.p } };
  if (editIndex >= 0) chars[editIndex] = ch;
  else chars.push(ch);
  activeIndex = editIndex >= 0 ? editIndex : chars.length - 1;
  persistChars();
  closeEditor();
  updateActiveCharLabel();
  if (charPickedCb) charPickedCb(getActiveChar());
  showPage('lobby');
}

function deleteChar() {
  if (editIndex < 0) return;
  chars.splice(editIndex, 1);
  if (activeIndex === editIndex) activeIndex = chars.length ? 0 : -1;
  else if (activeIndex > editIndex) activeIndex -= 1;
  persistChars();
  updateActiveCharLabel();
  closeEditor(); // back to the (possibly empty) character list
}

function pickChar(i) {
  if (i < 0 || i >= chars.length) return;
  activeIndex = i;
  persistChars();
  updateActiveCharLabel();
  if (charPickedCb) charPickedCb(getActiveChar());
  showPage('lobby');
}

function renderCharList() {
  const list = $('charList');
  list.textContent = '';
  if (chars.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'char-empty';
    hint.textContent = '还没有人物，先创建一个吧';
    list.appendChild(hint);
    return;
  }
  chars.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = i === activeIndex ? 'char-card current' : 'char-card';

    const cv = document.createElement('canvas');
    cv.width = 32;
    cv.height = 48;
    drawAvatar(cv, c.skin);
    card.appendChild(cv);

    const nm = document.createElement('div');
    nm.className = 'char-name';
    nm.textContent = c.name;
    nm.title = c.name;
    card.appendChild(nm);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'char-edit-btn';
    edit.textContent = '编辑';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openEditor(i); });
    card.appendChild(edit);

    card.addEventListener('click', () => pickChar(i));
    list.appendChild(card);
  });
}

// ---------- create prompt & random room names ----------

let pendingCreateName = '';

// Adjective + place + 2-digit number, e.g. "迷雾森林42" — 6 code points,
// always within the relay's 1–16 limit.
const RAND_ADJ = ['迷雾', '晨曦', '黄昏', '星空', '翡翠', '琥珀', '风暴', '宁静', '炽热', '苍翠'];
const RAND_PLACE = ['森林', '山谷', '海岸', '平原', '洞穴', '群岛', '高原', '绿洲', '峡谷', '雪原'];

function randomRoomName() {
  const a = RAND_ADJ[(Math.random() * RAND_ADJ.length) | 0];
  const p = RAND_PLACE[(Math.random() * RAND_PLACE.length) | 0];
  return a + p + (10 + ((Math.random() * 90) | 0)); // 10..99: always 2 digits
}

// One-shot: the name doEnter auto-generated for an empty input. When the
// find-first flow reports "not found" for exactly this name, skip the create
// prompt and create directly. Cleared on use, on manual input edit, and when
// a session starts (the random name joined an existing room).
let generatedRoomName = '';

export function showCreatePrompt(roomName) {
  const name = String(roomName);
  if (generatedRoomName && normRoomKey(name) === normRoomKey(generatedRoomName)) {
    generatedRoomName = ''; // one-shot: a later manual retry prompts normally
    if (createRoomCb) {
      createRoomCb(name, takeServerFn(), $('publicToggle').checked);
      return;
    }
  }
  pendingCreateName = name;
  $('createPromptText').textContent = '没有找到「' + pendingCreateName + '」';
  $('createPrompt').classList.add('show');
}

export function hideCreatePrompt() {
  pendingCreateName = '';
  $('createPrompt').classList.remove('show');
}

// ---------- menu init ----------

export function initMenu({ onEnterRoom, onCreateRoom, onRefresh, onExit, onCharPicked }) {
  charPickedCb = onCharPicked || null;
  enterRoomCb = onEnterRoom || null;
  createRoomCb = onCreateRoom || null;
  loadChars();
  loadHistory();

  const serverInput = $('serverInput');
  // Server priority: previously used > per-build default (app builds) > blank
  // (= same origin, the normal web case).
  serverInput.value = lsGet('vc-server')
    || (typeof window.VC_DEFAULT_SERVER === 'string' ? window.VC_DEFAULT_SERVER : '');

  const roomNameInput = $('roomNameInput');
  const roomParam = new URLSearchParams(location.search).get('room'); // URL-decoded
  if (roomParam) roomNameInput.value = roomParam.trim();

  buildSwatchRow($('shirtSwatches'), 's');
  buildSwatchRow($('pantsSwatches'), 'p');

  const takeServer = () => {
    const server = serverInput.value.trim();
    lsSet('vc-server', server);
    return server;
  };
  takeServerFn = takeServer; // for the generated-name auto-create path

  // -- profile page --
  $('newCharBtn').addEventListener('click', () => openEditor(-1));
  $('saveCharBtn').addEventListener('click', saveChar);
  $('cancelCharBtn').addEventListener('click', closeEditor);
  $('deleteCharBtn').addEventListener('click', deleteChar);
  $('charNameInput').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME compose commit, not a submit
    if (e.key === 'Enter') saveChar();
  });

  // -- lobby page --
  $('switchCharBtn').addEventListener('click', () => {
    closeEditor(); // ensures the picker is visible with a fresh list
    showPage('profile');
  });

  const doEnter = () => {
    if (!getActiveChar()) { closeEditor(); showPage('profile'); return; }
    let room = roomNameInput.value.trim();
    if (!room) {
      // Empty = a random new room: generate a name, show it in the input and
      // run the normal find-first flow; showCreatePrompt for this exact name
      // skips the prompt (one-shot). If the name exists, we simply join it.
      room = randomRoomName();
      roomNameInput.value = room; // programmatic set fires no 'input' event
      generatedRoomName = room;
    }
    // Relay validates 1-16 CODE POINTS; mirror it here (the input has no
    // HTML maxlength — that counts UTF-16 units and breaks astral chars).
    if ([...room].length > 16) {
      showMenuError('房间名需为 1–16 个字符');
      roomNameInput.focus();
      return;
    }
    showMenuError('');
    hideCreatePrompt();
    onEnterRoom(room, takeServer());
  };
  $('goBtn').addEventListener('click', doEnter);
  roomNameInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME compose commit, not a submit
    if (e.key === 'Enter') doEnter();
  });
  roomNameInput.addEventListener('input', () => {
    generatedRoomName = ''; // manual edit cancels the one-shot auto-create
    hideCreatePrompt(); // prompt refers to the previously searched name
    showMenuError('');
  });

  $('confirmCreateBtn').addEventListener('click', () => {
    const room = pendingCreateName;
    if (!room) { hideCreatePrompt(); return; }
    showMenuError('');
    hideCreatePrompt();
    onCreateRoom(room, takeServer(), $('publicToggle').checked);
  });

  const doRefresh = () => {
    showMenuError('');
    if (onRefresh) onRefresh(takeServer());
  };
  $('refreshBtn').addEventListener('click', doRefresh);
  serverInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME compose commit, not a submit
    if (e.key === 'Enter') doRefresh();
  });

  // Exit button lives in the HUD. The in-game touch layer listens on document
  // and preventDefaults unclaimed touches (which suppresses their click), so
  // stop propagation at the button — the tap then produces a normal click.
  const exitBtn = $('exitBtn');
  exitBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  exitBtn.addEventListener('click', () => { if (onExit) onExit(); });

  // Initial page: lobby when a character exists, otherwise profile — and on a
  // completely fresh install go straight into the editor.
  updateActiveCharLabel();
  renderCharList();
  renderRoomSections(); // show saved history right away; live data merges later
  if (chars.length === 0) {
    showPage('profile');
    openEditor(-1);
    const legacyName = lsGet('vc-name'); // migrate v1 name as a prefill
    if (legacyName) $('charNameInput').value = legacyName.trim().slice(0, 16);
  } else {
    showPage('lobby');
    if (charPickedCb) charPickedCb(getActiveChar());
  }

  $('menu').style.display = 'flex';
}

// ---------- lobby helpers ----------

export function showMenuError(msg) {
  $('menuError').textContent = msg || '';
}

// Colored connection status line above the server input.
export function setConnStatus(text, ok) {
  const el = $('connStatus');
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
  el.classList.toggle('bad', !ok);
}

function roomListPlaceholder(text) {
  const list = $('roomList');
  list.textContent = '';
  const el = document.createElement('div');
  el.className = 'room-empty';
  el.textContent = text;
  list.appendChild(el);
}

// ---------- room history (我的足迹) + room lists ----------

// Client-side mirror of the relay's name normalization — used ONLY as a
// matching/dedupe key; rows always display the stored display name.
function normRoomKey(s) {
  return String(s == null ? '' : s).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const HISTORY_MAX = 20;

let roomHistory = [];   // [{room, host, t}] newest first, max 20
let liveRooms = [];     // renderRooms cache: history × re-renders reuse it
let livePick = null;    // onPick from the latest renderRooms call
let enterRoomCb = null; // initMenu callbacks (rows/auto-create before first render)
let createRoomCb = null;
let takeServerFn = () => '';

function loadHistory() {
  roomHistory = [];
  const raw = lsGet('vc-history');
  if (!raw) return;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const seen = new Set();
    for (const e of arr) {
      if (roomHistory.length >= HISTORY_MAX) break;
      const room = e && typeof e.room === 'string' ? e.room : '';
      const key = normRoomKey(room);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      roomHistory.push({ room, host: e.host === true, t: Number(e.t) || 0 });
    }
  } catch (err) { /* corrupted JSON -> start empty */ }
}

function persistHistory() {
  lsSet('vc-history', JSON.stringify(roomHistory));
}

// Called by main right after a session starts. host=true when the player
// created the room — and stays true on later visits as a plain member.
export function recordHistory(room, isHost) {
  const display = String(room == null ? '' : room).normalize('NFC').trim().replace(/\s+/g, ' ');
  const key = normRoomKey(display);
  if (!key) return;
  generatedRoomName = ''; // a session started: the one-shot name is spent
  const i = roomHistory.findIndex((e) => normRoomKey(e.room) === key);
  const prev = i >= 0 ? roomHistory.splice(i, 1)[0] : null;
  roomHistory.unshift({
    room: display,
    host: isHost === true || !!(prev && prev.host), // sticky once true
    t: Date.now(),
  });
  if (roomHistory.length > HISTORY_MAX) roomHistory.length = HISTORY_MAX;
  persistHistory();
  renderRoomSections();
}

// × button: removes the LOCAL entry only — never touches a live room.
function removeHistory(key) {
  const i = roomHistory.findIndex((e) => normRoomKey(e.room) === key);
  if (i < 0) return;
  roomHistory.splice(i, 1);
  persistHistory();
  renderRoomSections(); // counts come from the cached live list — no refetch
}

function pickRoomName(name) {
  if (livePick) livePick(name);
  // Before the first renderRooms (initial refresh still in flight) fall back
  // to the plain enter flow so history rows are never dead.
  else if (enterRoomCb) enterRoomCb(name, takeServerFn());
}

// Row: [name span][" · status" span][optional × delete]. Room names are user
// content — textContent only; gold comes from the .room-own class.
function buildRoomRow(name, statusText, own, onDelete) {
  const row = document.createElement('div');
  row.className = 'room-row';
  const nm = document.createElement('span');
  nm.className = own ? 'room-name room-own' : 'room-name';
  nm.textContent = name;
  row.appendChild(nm);
  const st = document.createElement('span');
  st.className = 'room-status';
  st.textContent = ' · ' + statusText;
  row.appendChild(st);
  row.title = name + ' · ' + statusText;
  row.addEventListener('click', () => pickRoomName(name));
  if (onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'room-del';
    del.textContent = '×';
    del.setAttribute('aria-label', '删除足迹 ' + name);
    // Deleting a history entry must never join the room.
    del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    del.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    row.appendChild(del);
  }
  return row;
}

function renderRoomSections() {
  const liveByKey = new Map();
  for (const r of liveRooms) {
    const name = String(r.room);
    liveByKey.set(normRoomKey(name), Number(r.players) || 0);
  }

  // History (我的足迹): merged with live data, hidden entirely when empty.
  const empty = roomHistory.length === 0;
  $('historyHeader').classList.toggle('hidden', empty);
  const hList = $('historyList');
  hList.classList.toggle('hidden', empty);
  hList.textContent = '';
  const historyKeys = new Set();
  for (const e of roomHistory) {
    const key = normRoomKey(e.room);
    historyKeys.add(key);
    const status = liveByKey.has(key) ? liveByKey.get(key) + '人' : '不在线';
    hList.appendChild(buildRoomRow(e.room, status, e.host === true, () => removeHistory(key)));
  }

  // 其他公开房间: live rooms not already shown in the history section.
  const list = $('roomList');
  list.textContent = '';
  let shown = 0;
  for (const r of liveRooms) {
    const name = String(r.room);
    if (historyKeys.has(normRoomKey(name))) continue;
    list.appendChild(buildRoomRow(name, (Number(r.players) || 0) + '人', false, null));
    shown += 1;
  }
  if (shown === 0) roomListPlaceholder('暂无公开房间，创建一个吧');
}

// rooms: [{room, players}] — the latest LIVE list. Renders BOTH sections and
// caches the list so later history changes re-render without a refetch.
export function renderRooms(rooms, onPick) {
  liveRooms = Array.isArray(rooms) ? rooms.filter((r) => r && typeof r === 'object') : [];
  if (typeof onPick === 'function') livePick = onPick;
  renderRoomSections();
}

export function setRoomsLoading() {
  roomListPlaceholder('刷新中…');
}

// Re-render both sections from the cached live list. Used by main when a
// superseded refresh left the "刷新中…" placeholder behind and the attempt
// that superseded it returned to the menu without a rooms reply.
export function restoreRoomSections() {
  renderRoomSections();
}

export function hideMenu() {
  showMenuError('');
  hideCreatePrompt();
  $('menu').style.display = 'none';
  $('hud').style.display = 'block';
}

export function setRoomLabel(name, playerCount) {
  $('roomLabel').textContent =
    playerCount != null ? `房间 ${name} · ${playerCount} 人` : `房间 ${name}`;
}

// ---------- HUD: hotbar ----------

export function buildHotbar(icons) {
  const hotbar = $('hotbar');
  hotbar.textContent = '';
  for (let i = 0; i < icons.length; i++) {
    const slot = document.createElement('div');
    slot.className = i === 0 ? 'hotbar-slot selected' : 'hotbar-slot';
    slot.dataset.index = String(i);

    const num = document.createElement('span');
    num.className = 'slot-num';
    num.textContent = String(i + 1);
    slot.appendChild(num);

    const img = document.createElement('img');
    img.src = icons[i];
    img.alt = '';
    img.draggable = false;
    slot.appendChild(img);

    hotbar.appendChild(slot);
  }

  if (!hotbarBound) {
    hotbarBound = true;
    // pointerdown fires before touch handlers can suppress click on mobile.
    hotbar.addEventListener('pointerdown', (e) => {
      const slot = e.target.closest('.hotbar-slot');
      if (!slot) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(slot.dataset.index);
      setHotbarSelection(i);
      if (hotbarTapCb) hotbarTapCb(i);
    });
  }
}

export function setHotbarSelection(i) {
  const slots = $('hotbar').children;
  for (let k = 0; k < slots.length; k++) {
    slots[k].classList.toggle('selected', k === i);
  }
}

export function onHotbarTap(cb) {
  hotbarTapCb = cb;
}

// ---------- toasts & return-to-menu ----------

export function toast(msg) {
  const box = $('toast');
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 350);
  }, 3000);
}

export function backToMenu(msg) {
  $('hud').style.display = 'none';
  $('menu').style.display = 'flex';
  showPage('lobby');
  hideCreatePrompt();
  showMenuError(msg || '');
  // Release pointer lock so the menu is usable after a disconnect.
  if (document.pointerLockElement) document.exitPointerLock();
}
