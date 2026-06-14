// UI shell: six-page menu (entry / char show-select-design / room show-select),
// HUD, hotbar, toasts. DOM only — no three.js (menubg.js renders the entry
// background separately), no network or game knowledge. Owns ALL menu
// localStorage: vc-chars, vc-active, vc-history, vc-server, vc-lastroom,
// vc-worlds, vc-hidden. Names and room names are user/attacker content:
// rendered exclusively via textContent, never innerHTML.

import { PALETTE, SKIN_TONES, BODIES } from './constants.js';
import { avatarModel } from './avatar.js';

const $ = (id) => document.getElementById(id);

const HISTORY_MAX = 20;
const WORLDS_MAX = 8;
const EDITS_MAX = 60000;
const HIDDEN_MAX = 50;

// initUi handlers (main.js owns the flows; ui.js only fires them).
let H = {};

let hotbarTapCb = null;
let hotbarBound = false;

// ---------- guarded storage (private mode / blocked site data can throw) ----

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };

const warned = new Set();
function warnOnce(tag, msg) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(msg);
}

// ---------- room-name normalization (exact client mirror of the relay) ----

function normDisplay(raw) {
  return String(raw == null ? '' : raw).normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function normRoomKey(raw) {
  return normDisplay(raw).toLowerCase();
}

// ---------- shared skin rule (v2 validation + legacy migration) ----------
// Identical in host.js, main.js member side and the tools bots:
// 1. v2 {b,t,p,k} all integers in range -> copy as-is (drop extra keys);
// 2. legacy {s,p} integers 0..7 -> {b:1, t:s, p:p, k:1};
// 3. anything else -> {b:1, t:0, p:0, k:1}.
function cleanSkin(s) {
  if (s && typeof s === 'object') {
    const int = Number.isInteger;
    if (int(s.b) && s.b >= 0 && s.b <= 7 &&
        int(s.t) && s.t >= 0 && s.t <= 7 &&
        int(s.p) && s.p >= 0 && s.p <= 7 &&
        int(s.k) && s.k >= 0 && s.k <= 5) {
      return { b: s.b, t: s.t, p: s.p, k: s.k };
    }
    if (int(s.s) && s.s >= 0 && s.s <= 7 && int(s.p) && s.p >= 0 && s.p <= 7) {
      return { b: 1, t: s.s, p: s.p, k: 1 };
    }
  }
  return { b: 1, t: 0, p: 0, k: 1 };
}

// ---------- random generators ----------

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// Room names: adjective + place + 2-digit number, e.g. "迷雾森林42" —
// 6 code points, always within the relay's 1–16 limit.
const RAND_ADJ = ['迷雾', '晨曦', '黄昏', '星空', '翡翠', '琥珀', '风暴', '宁静', '炽热', '苍翠'];
const RAND_PLACE = ['森林', '山谷', '海岸', '平原', '洞穴', '群岛', '高原', '绿洲', '峡谷', '雪原'];

function randomRoomName() {
  return pick(RAND_ADJ) + pick(RAND_PLACE) + (10 + ((Math.random() * 90) | 0)); // 10..99
}

// Character names: 称号 + 名, e.g. "勇敢的旅人" — always <= 16 chars.
const CHAR_TITLE = ['勇敢的', '好奇的', '沉默的', '快乐的', '迷路的', '倔强的', '温柔的', '爱笑的', '远方的', '守山的'];
const CHAR_ROLE = ['旅人', '矿工', '牧羊人', '拾穗人', '看林人', '渔夫', '铁匠', '采药人', '守夜人', '种树人'];

function randomCharName() {
  return pick(CHAR_TITLE) + pick(CHAR_ROLE);
}

// Uniform over the valid v2 ranges.
function randomSkin() {
  return {
    b: (Math.random() * BODIES.length) | 0,
    t: (Math.random() * PALETTE.length) | 0,
    p: (Math.random() * PALETTE.length) | 0,
    k: (Math.random() * SKIN_TONES.length) | 0,
  };
}

// ---------- character store (vc-chars / vc-active) ----------

let chars = [];        // [{name, skin:{b,t,p,k}}] — always migrated v2 in memory
let activeIndex = -1;
let charsLoaded = false;

function loadChars() {
  if (charsLoaded) return;
  charsLoaded = true;
  chars = [];
  const raw = lsGet('vc-chars');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const name = c && typeof c.name === 'string' ? c.name.trim().slice(0, 16) : '';
          if (!name) continue;
          // Legacy {s,p} skins are lazily migrated here; the new shape is
          // written back on the next persist.
          chars.push({ name, skin: cleanSkin(c && c.skin) });
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
  loadChars();
  if (activeIndex < 0 || activeIndex >= chars.length) return null;
  const c = chars[activeIndex];
  return { name: c.name, skin: { b: c.skin.b, t: c.skin.t, p: c.skin.p, k: c.skin.k } };
}

// No character -> silently create a random one, persist + activate. Never
// prompts, never navigates (the zero-confirmation enter-world chain).
export function ensureCharacter() {
  loadChars();
  const existing = getActiveChar();
  if (existing) return existing;
  chars.push({ name: randomCharName(), skin: randomSkin() });
  activeIndex = chars.length - 1;
  persistChars();
  refreshCharDisplays();
  return getActiveChar();
}

// ---------- avatar preview (skin v2, renderer.addPlayer proportions) ----------

// Front view of the avatar — a 2D projection of the SAME unified avatarModel voxel boxes the in-game
// 3D renderer rasterizes. Front face is −z, so we draw back-to-front (larger z0 first) and the face
// (eyes at z=−3, nose at −4) lands on top. Change the model in avatar.js → both views update.
function drawAvatar(canvas, skin) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const boxes = avatarModel(cleanSkin(skin)).boxes;
  let maxX = 1, topY = 1;
  for (const b of boxes) { maxX = Math.max(maxX, Math.abs(b.x0), Math.abs(b.x1 + 1)); topY = Math.max(topY, b.y1 + 1); }
  const u = Math.min((h * 0.92) / topY, (w * 0.86) / (maxX * 2));
  const cx = w / 2, floorY = (h + topY * u) / 2;
  for (const b of boxes.slice().sort((a, c) => c.z0 - a.z0)) {   // far (back, +z) first → face on top
    const x = cx + b.x0 * u;
    const y = floorY - (b.y1 + 1) * u;
    const bw = Math.max(1, Math.round((b.x1 + 1 - b.x0) * u));
    const bh = Math.max(1, Math.round((b.y1 + 1 - b.y0) * u));
    ctx.fillStyle = b.color;
    ctx.fillRect(Math.round(x), Math.round(y), bw, bh);
  }
}

// Head close-up for the 40px list thumbnails: skin-tone head + top-color
// shoulders with a 2px dark outline — a portrait crop of the same skin data
// drawAvatar uses. Logical 40x40 grid scaled to the backing store.
function drawAvatarBust(canvas, skin) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sk = cleanSkin(skin);
  const u = canvas.width / 40;
  const px = (x, y, bw, bh, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x * u), Math.round(y * u),
      Math.max(1, Math.round(bw * u)), Math.max(1, Math.round(bh * u)));
  };
  // soft warm backdrop so the portrait reads as a tile on any row color
  px(0, 0, 40, 40, 'rgba(20, 14, 8, 0.40)');
  // shoulders (top color); broad bodies get slightly wider shoulders
  const shW = BODIES[sk.b] && BODIES[sk.b].w > 1 ? 28 : 24;
  px(20 - shW / 2 - 2, 25, shW + 4, 15, '#1a120b');        // 2px outline
  px(20 - shW / 2, 27, shW, 13, PALETTE[sk.t]);
  // head (skin tone) over the shoulders
  px(9, 3, 22, 24, '#1a120b');                              // 2px outline
  px(11, 5, 18, 20, SKIN_TONES[sk.k]);
  px(10, 4, 20, 6, '#4a3526');                              // hair cap (matches avatarParts)
  // blocky right-edge shade + simple eyes, matching drawAvatar's 3D hints
  px(24, 5, 5, 20, 'rgba(0, 0, 0, 0.18)');
  px(15, 13, 3, 3, 'rgba(20, 14, 8, 0.85)');
  px(22, 13, 3, 3, 'rgba(20, 14, 8, 0.85)');
}

// Integer-multiple backing store for a preview canvas: CSS size x ceil(dpr),
// so the blocky avatar stays sharp on hi-DPI screens (no half-pixel blur).
// Falls back to the original attribute size while the page is hidden.
function crispCanvas(canvas) {
  if (!canvas.dataset.baseW) {
    canvas.dataset.baseW = String(canvas.width);
    canvas.dataset.baseH = String(canvas.height);
  }
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.round(rect.width) || Number(canvas.dataset.baseW);
  const cssH = Math.round(rect.height) || Number(canvas.dataset.baseH);
  const scale = Math.max(1, Math.min(4, Math.ceil(window.devicePixelRatio || 1)));
  const w = cssW * scale;
  const h = cssH * scale;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

// ---------- six pages: navigation ----------

const PAGE_IDS = {
  entry: 'entryPage',
  charShow: 'charShowPage',
  charSelect: 'charSelectPage',
  charEditor: 'charEditorPage',
  roomShow: 'roomShowPage',
  roomSelect: 'roomSelectPage',
};

export function showPage(name) {
  const id = PAGE_IDS[name];
  if (!id) return;
  for (const pid of Object.values(PAGE_IDS)) {
    $(pid).classList.toggle('active', pid === id);
  }
  if (name === 'charShow') refreshCharShow();
  else if (name === 'charSelect') renderCharSelectList();
  else if (name === 'roomSelect' && H.onRefreshRooms) H.onRefreshRooms();
}

// ui.js-internal upkeep of character-derived display bits; room/status info
// is main-driven via setEntryInfo/setRoomShowInfo/renderRoomSelect.
function refreshCharDisplays() {
  const el = $('entryCharName');
  if (!el) return; // storage APIs may run before the DOM exists in tests
  const c = getActiveChar();
  el.textContent = c ? c.name : '—';
  refreshCharShow();
  if ($('charSelectPage').classList.contains('active')) renderCharSelectList();
}

function refreshCharShow() {
  const c = getActiveChar();
  $('charShowName').textContent = c ? c.name : '—';
  const preview = $('charShowPreview');
  crispCanvas(preview); // large, integer-scaled backing store -> sharp blocks
  drawAvatar(preview, c ? c.skin : null);
}

// ---------- character select page ----------

function listPlaceholder(listEl, text) {
  const el = document.createElement('div');
  el.className = 'list-empty';
  el.textContent = text;
  listEl.appendChild(el);
}

// Action buttons never trigger the row-level handler.
function rowBtn(label, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = danger ? 'row-btn danger' : 'row-btn';
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  b.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  return b;
}

function renderCharSelectList() {
  loadChars();
  const list = $('charSelectList');
  list.textContent = '';
  if (chars.length === 0) {
    listPlaceholder(list, '还没有人物，建立一个吧');
    return;
  }
  chars.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = i === activeIndex ? 'select-row current' : 'select-row';
    // 40px portrait thumbnail at the row start (pure decoration — clicks on
    // it simply fall through to the row handler like the name does).
    const av = document.createElement('canvas');
    av.className = 'avatar-thumb';
    const thumbScale = Math.max(2, Math.min(4, Math.ceil(window.devicePixelRatio || 1)));
    av.width = 40 * thumbScale;
    av.height = 40 * thumbScale;
    av.style.width = '40px';
    av.style.height = '40px';
    av.style.flex = '0 0 40px';
    av.style.marginRight = '8px';
    av.style.borderRadius = '6px';
    av.style.imageRendering = 'pixelated';
    drawAvatarBust(av, c.skin);
    row.appendChild(av);
    const nm = document.createElement('span');
    nm.className = 'select-name';
    nm.textContent = c.name;
    nm.title = c.name;
    row.appendChild(nm);
    const spacer = document.createElement('span');
    spacer.className = 'row-status';
    spacer.textContent = i === activeIndex ? '当前' : '';
    row.appendChild(spacer);
    row.appendChild(rowBtn('使用', () => pickChar(i)));
    row.appendChild(rowBtn('编辑', () => openEditor(i)));
    row.addEventListener('click', () => pickChar(i));
    list.appendChild(row);
  });
}

function pickChar(i) {
  if (i < 0 || i >= chars.length) return;
  activeIndex = i;
  persistChars();
  refreshCharDisplays();
  showPage('charShow');
}

function randomCreateChar() {
  loadChars();
  chars.push({ name: randomCharName(), skin: randomSkin() });
  activeIndex = chars.length - 1;
  persistChars();
  refreshCharDisplays();
  renderCharSelectList();
}

// ---------- character designer ----------

let editIndex = -1;            // index being edited; -1 = creating new
let editSkin = { b: 1, t: 0, p: 0, k: 1 };

function buildSwatchRow(rowEl, colors, key, label) {
  rowEl.textContent = '';
  for (let i = 0; i < colors.length; i++) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.style.backgroundColor = colors[i];
    sw.setAttribute('aria-label', label + ' ' + (i + 1));
    sw.addEventListener('click', () => {
      editSkin[key] = i;
      refreshEditor();
    });
    rowEl.appendChild(sw);
  }
}

function buildBodyList() {
  const el = $('bodyList');
  el.textContent = '';
  BODIES.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'body-option';
    btn.textContent = b.label;
    btn.addEventListener('click', () => {
      editSkin.b = i;
      refreshEditor();
    });
    el.appendChild(btn);
  });
}

function markSelected(rowEl, sel) {
  const kids = rowEl.children;
  for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('selected', i === sel);
}

function refreshEditor() {
  markSelected($('bodyList'), editSkin.b);
  markSelected($('topSwatches'), editSkin.t);
  markSelected($('pantsSwatches'), editSkin.p);
  markSelected($('skinSwatches'), editSkin.k);
  const preview = $('charPreview');
  crispCanvas(preview); // same sharp integer scaling as the show page
  drawAvatar(preview, editSkin);
}

function openEditor(i) {
  loadChars();
  editIndex = Number.isInteger(i) && i >= 0 && i < chars.length ? i : -1;
  const c = editIndex >= 0 ? chars[editIndex] : null;
  $('charNameInput').value = c ? c.name : '';
  editSkin = c ? { ...c.skin } : randomSkin();
  $('deleteCharBtn').classList.toggle('hidden', !c);
  refreshEditor();
  showPage('charEditor');
}

function saveUseChar() {
  const name = [...$('charNameInput').value.trim()].slice(0, 16).join('');
  if (!name) {
    showMenuError('请输入名字');
    $('charNameInput').focus();
    return;
  }
  showMenuError('');
  const ch = { name, skin: { ...editSkin } };
  if (editIndex >= 0 && editIndex < chars.length) chars[editIndex] = ch;
  else {
    chars.push(ch);
    editIndex = chars.length - 1;
  }
  activeIndex = editIndex;
  persistChars();
  refreshCharDisplays();
  showPage('charShow');
}

function deleteChar() {
  if (editIndex < 0 || editIndex >= chars.length) return;
  if (!window.confirm('删除人物「' + chars[editIndex].name + '」？')) return;
  chars.splice(editIndex, 1);
  if (activeIndex === editIndex) activeIndex = chars.length ? 0 : -1;
  else if (activeIndex > editIndex) activeIndex -= 1;
  editIndex = -1;
  persistChars();
  refreshCharDisplays();
  showPage('charSelect');
}

// ---------- room history (vc-history) ----------

let roomHistory = [];   // [{room, host, t}] newest first, max 20
let historyLoaded = false;

function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
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

// Called by main right after a session starts. The stored field stays named
// `host` for compatibility, but it MEANS 「我创建过这个房间」 (own) — sticky
// once true. Store update ONLY; rendering is main-driven via renderRoomSelect.
export function recordHistory(room, isHost) {
  loadHistory();
  const display = normDisplay(room);
  const key = normRoomKey(display);
  if (!key) return;
  generatedRoomName = ''; // a session started: the one-shot name is spent
  const i = roomHistory.findIndex((e) => normRoomKey(e.room) === key);
  const prev = i >= 0 ? roomHistory.splice(i, 1)[0] : null;
  roomHistory.unshift({
    room: display,
    host: isHost === true || !!(prev && prev.host),
    t: Date.now(),
  });
  if (roomHistory.length > HISTORY_MAX) roomHistory.length = HISTORY_MAX;
  persistHistory();
}

// Copy for main (it composes own flags and status strings from it).
export function getHistory() {
  loadHistory();
  return roomHistory.map((e) => ({ room: e.room, host: e.host === true, t: e.t }));
}

// ---------- last room (vc-lastroom) ----------

export function getLastRoom() {
  const v = lsGet('vc-lastroom');
  return typeof v === 'string' ? v : '';
}

export function setLastRoom(name) {
  const display = normDisplay(name);
  if (display) lsSet('vc-lastroom', display);
}

// ---------- local world saves (vc-worlds) ----------

let worlds = null; // { [normKey]: {room, seed, edits, t} }

function loadWorlds() {
  if (worlds) return worlds;
  worlds = {};
  const raw = lsGet('vc-worlds');
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key of Object.keys(obj)) {
          const e = obj[key];
          if (!e || typeof e !== 'object') continue;
          if (typeof e.room !== 'string' || !Number.isFinite(e.seed)) continue;
          const edits = Array.isArray(e.edits)
            ? e.edits.filter((d) => Array.isArray(d) && d.length === 4 && d.every(Number.isFinite))
            : [];
          worlds[key] = { room: e.room, seed: e.seed, edits, t: Number(e.t) || 0 };
        }
      }
    } catch (err) { /* corrupted JSON -> start empty */ }
  }
  return worlds;
}

function persistWorlds() {
  try {
    localStorage.setItem('vc-worlds', JSON.stringify(worlds));
  } catch (err) {
    warnOnce('worlds-persist', '[vc] world save failed (quota or serialization) — skipped');
  }
}

export function getWorldSave(room) {
  const e = loadWorlds()[normRoomKey(room)];
  return e ? { room: e.room, seed: e.seed, edits: e.edits, t: e.t } : null;
}

// Enforces the 8-world cap (evict oldest t) and the 60000-edit refusal
// (warn once per session, no-op). Never throws, never writes partially.
export function putWorldSave(room, seed, edits) {
  try {
    const key = normRoomKey(room);
    if (!key || !Number.isFinite(seed)) return;
    const list = Array.isArray(edits) ? edits : [];
    if (list.length > EDITS_MAX) {
      warnOnce('worlds-size', '[vc] world save refused: more than ' + EDITS_MAX + ' edits');
      return;
    }
    const w = loadWorlds();
    w[key] = { room: normDisplay(room), seed, edits: list, t: Date.now() };
    const keys = Object.keys(w);
    if (keys.length > WORLDS_MAX) {
      keys.sort((a, b) => w[a].t - w[b].t);
      for (let i = 0; i < keys.length - WORLDS_MAX; i++) delete w[keys[i]];
    }
    persistWorlds();
  } catch (err) {
    warnOnce('worlds-persist', '[vc] world save failed — skipped');
  }
}

export function removeWorldSave(room) {
  const w = loadWorlds();
  const key = normRoomKey(room);
  if (key in w) {
    delete w[key];
    persistWorlds();
  }
}

// ---------- hidden public rooms (vc-hidden) ----------

let hiddenRooms = null; // [normKey] newest first, max 50

function loadHidden() {
  if (hiddenRooms) return hiddenRooms;
  hiddenRooms = [];
  const raw = lsGet('vc-hidden');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        hiddenRooms = arr.filter((k) => typeof k === 'string' && k).slice(0, HIDDEN_MAX);
      }
    } catch (err) { /* corrupted JSON -> start empty */ }
  }
  return hiddenRooms;
}

function addHidden(key) {
  if (!key) return;
  const arr = loadHidden();
  hiddenRooms = [key, ...arr.filter((k) => k !== key)].slice(0, HIDDEN_MAX);
  lsSet('vc-hidden', JSON.stringify(hiddenRooms));
}

// ---------- room select page: render ----------

// Cached last render payload so 移除/隐藏 can re-render without main.
let lastSelect = { current: null, history: [], found: [] };
let roomShowRoom = ''; // room currently displayed on roomShowPage

function useRoom(name) {
  showMenuError('');
  hideCreatePrompt();
  commitServer();
  if (H.onUseRoom) H.onUseRoom(name);
}

// Row: [★?name][" · status"][action buttons]. Names/statuses are user or
// attacker content — textContent only; gold comes from the .room-own class.
function buildRoomRow(name, own, status, actions) {
  const row = document.createElement('div');
  row.className = 'select-row';
  const nm = document.createElement('span');
  nm.className = own ? 'select-name room-own' : 'select-name';
  nm.textContent = own ? '★' + name : name;
  row.appendChild(nm);
  const st = document.createElement('span');
  st.className = 'row-status';
  st.textContent = status ? ' · ' + status : '';
  row.appendChild(st);
  row.title = name + (status ? ' · ' + status : '');
  for (const a of actions) row.appendChild(rowBtn(a.label, a.onClick, a.danger === true));
  row.addEventListener('click', () => useRoom(name));
  return row;
}

// 「移除」: confirm, then delete the history entry AND its world save.
function removeHistoryEntry(name) {
  if (!window.confirm('移除「' + name + '」的历史记录与本地存档？')) return;
  loadHistory();
  const key = normRoomKey(name);
  const i = roomHistory.findIndex((e) => normRoomKey(e.room) === key);
  if (i >= 0) {
    roomHistory.splice(i, 1);
    persistHistory();
  }
  removeWorldSave(name);
  lastSelect.history = lastSelect.history.filter((e) => normRoomKey(e.name) !== key);
  paintRoomSelect();
}

// 「隐藏」: remember the normalized name; the row disappears immediately.
function hidePublicRoom(name) {
  addHidden(normRoomKey(name));
  paintRoomSelect();
}

// current: {name, own, status} | null; history: [{name, own, status}];
// found: [{name, players}]. ui.js itself filters `found` against history
// keys and vc-hidden.
export function renderRoomSelect({ current, history, found } = {}) {
  const cleanRow = (o) => ({
    name: normDisplay(o.name),
    own: o.own === true,
    status: o.status == null ? '' : String(o.status),
  });
  lastSelect = {
    current: current && typeof current === 'object' && normDisplay(current.name)
      ? cleanRow(current)
      : null,
    history: Array.isArray(history)
      ? history.filter((o) => o && typeof o === 'object' && normDisplay(o.name)).map(cleanRow)
      : [],
    found: Array.isArray(found)
      ? found
        .filter((o) => o && typeof o === 'object' && normDisplay(o.name))
        .map((o) => ({ name: normDisplay(o.name), players: Number(o.players) || 0 }))
      : [],
  };
  paintRoomSelect();
}

function paintRoomSelect() {
  const cur = lastSelect.current;
  $('currentRoomSection').classList.toggle('hidden', !cur);
  const curRow = $('currentRoomRow');
  curRow.textContent = '';
  if (cur) {
    curRow.appendChild(buildRoomRow(cur.name, cur.own, cur.status, [
      { label: '使用', onClick: () => useRoom(cur.name) },
    ]));
  }

  const hist = lastSelect.history;
  $('historySection').classList.toggle('hidden', hist.length === 0);
  const hList = $('historyList');
  hList.textContent = '';
  const historyKeys = new Set();
  for (const e of hist) {
    historyKeys.add(normRoomKey(e.name));
    hList.appendChild(buildRoomRow(e.name, e.own, e.status, [
      { label: '使用', onClick: () => useRoom(e.name) },
      { label: '移除', danger: true, onClick: () => removeHistoryEntry(e.name) },
    ]));
  }

  const hidden = new Set(loadHidden());
  const pList = $('publicList');
  pList.textContent = '';
  let shown = 0;
  for (const r of lastSelect.found) {
    const key = normRoomKey(r.name);
    if (historyKeys.has(key) || hidden.has(key)) continue;
    pList.appendChild(buildRoomRow(r.name, false, r.players + '人', [
      { label: '使用', onClick: () => useRoom(r.name) },
      { label: '隐藏', onClick: () => hidePublicRoom(r.name) },
    ]));
    shown += 1;
  }
  if (shown === 0) listPlaceholder(pList, '暂无公开房间，创建一个吧');
}

// ---------- entry / room-show info (main composes the strings) ----------

function setRoomNameEl(el, roomName, own) {
  const name = roomName == null ? '' : String(roomName);
  el.classList.toggle('room-own', own === true && !!name);
  el.textContent = name ? (own === true ? '★' + name : name) : '—';
}

export function setEntryInfo({ charName, roomName, own, status } = {}) {
  $('entryCharName').textContent = charName ? String(charName) : '—';
  setRoomNameEl($('entryRoomName'), roomName, own);
  $('entryRoomStatus').textContent = status == null ? '' : String(status);
}

export function setRoomShowInfo({ roomName, own, status } = {}) {
  roomShowRoom = roomName == null ? '' : String(roomName);
  setRoomNameEl($('roomShowName'), roomName, own);
  $('roomShowStatus').textContent = status == null ? '' : String(status);
}

// ---------- create prompt ----------

let pendingCreateName = '';

// One-shot: the name the empty-input find flow auto-generated. When the
// find-first flow reports "not found" for exactly this name, skip the create
// prompt and create directly. Cleared on use, on manual input edit, and when
// a session starts (the random name joined an existing room).
let generatedRoomName = '';

export function showCreatePrompt(roomName) {
  const name = String(roomName);
  if (generatedRoomName && normRoomKey(name) === normRoomKey(generatedRoomName)) {
    generatedRoomName = ''; // one-shot: a later manual retry prompts normally
    if (H.onCreateRoom) {
      H.onCreateRoom(name, $('publicToggle').checked);
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

function commitServer() {
  const el = $('serverInput');
  const spec = el ? el.value.trim() : '';
  lsSet('vc-server', spec);
  return spec;
}

function doFindRoom() {
  const input = $('roomNameInput');
  let room = input.value.trim();
  if (!room) {
    // Empty = a random new room: generate a name, show it in the input and
    // run the normal find-first chain; showCreatePrompt for this exact name
    // skips the prompt (one-shot). If the name exists, we simply join it.
    room = randomRoomName();
    input.value = room; // programmatic set fires no 'input' event
    generatedRoomName = room;
  }
  // Relay validates 1-16 CODE POINTS; mirror it here (the input has no HTML
  // maxlength — that counts UTF-16 units and breaks astral chars).
  if ([...room].length > 16) {
    showMenuError('房间名需为 1–16 个字符');
    input.focus();
    return;
  }
  useRoom(room);
}

// 建立新房间 = explicitly a NEW world; main performs NO world-save lookup.
function doCreateRoom() {
  const input = $('roomNameInput');
  let room = input.value.trim();
  if (!room) {
    room = randomRoomName();
    input.value = room;
  }
  if ([...room].length > 16) {
    showMenuError('房间名需为 1–16 个字符');
    input.focus();
    return;
  }
  showMenuError('');
  hideCreatePrompt();
  commitServer();
  if (H.onCreateRoom) H.onCreateRoom(room, $('publicToggle').checked);
}

// handlers = { onEnterWorld(), onUseRoom(name), onCreateRoom(name, isPublic),
//              onRefreshRooms(), onServerChange(spec) }
export function initUi(handlers) {
  H = handlers && typeof handlers === 'object' ? handlers : {};
  loadChars();
  loadHistory();

  // Server priority: previously used > per-build default (app builds) > blank
  // (= same origin, the normal web case).
  const serverInput = $('serverInput');
  serverInput.value = lsGet('vc-server')
    || (typeof window.VC_DEFAULT_SERVER === 'string' ? window.VC_DEFAULT_SERVER : '');

  const roomNameInput = $('roomNameInput');
  const roomParam = new URLSearchParams(location.search).get('room'); // URL-decoded
  if (roomParam) roomNameInput.value = roomParam.trim();

  // Static page content.
  buildBodyList();
  buildSwatchRow($('topSwatches'), PALETTE, 't', '上衣颜色');
  buildSwatchRow($('pantsSwatches'), PALETTE, 'p', '裤子颜色');
  buildSwatchRow($('skinSwatches'), SKIN_TONES, 'k', '肤色');

  // -- entry page --
  $('enterWorldBtn').addEventListener('click', () => {
    showMenuError('');
    hideCreatePrompt();
    commitServer();
    if (H.onEnterWorld) H.onEnterWorld();
  });
  $('charPageBtn').addEventListener('click', () => showPage('charShow'));
  $('roomPageBtn').addEventListener('click', () => showPage('roomShow'));

  // -- character show page --
  $('charEditBtn').addEventListener('click', () => openEditor(activeIndex));
  $('charSwitchBtn').addEventListener('click', () => showPage('charSelect'));
  $('charShowBackBtn').addEventListener('click', () => showPage('entry'));

  // -- character select page --
  $('newCharBtn').addEventListener('click', () => openEditor(-1));
  $('randomCharBtn').addEventListener('click', randomCreateChar);
  $('charSelectBackBtn').addEventListener('click', () => showPage('charShow'));

  // -- character designer page --
  $('saveUseCharBtn').addEventListener('click', saveUseChar);
  $('randomizeCharBtn').addEventListener('click', () => {
    editSkin = randomSkin(); // keeps the typed name
    refreshEditor();
  });
  $('deleteCharBtn').addEventListener('click', deleteChar);
  $('charEditorBackBtn').addEventListener('click', () => showPage('charSelect'));
  $('charNameInput').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME compose commit, not a submit
    if (e.key === 'Enter') saveUseChar();
  });

  // -- room show page --
  $('roomEnterBtn').addEventListener('click', () => {
    if (roomShowRoom) useRoom(roomShowRoom);
    else if (H.onEnterWorld) {
      // No room yet: same zero-confirmation chain as 进入世界.
      showMenuError('');
      commitServer();
      H.onEnterWorld();
    }
  });
  $('roomSwitchBtn').addEventListener('click', () => showPage('roomSelect'));
  $('roomShowBackBtn').addEventListener('click', () => showPage('entry'));

  // -- room select page --
  $('findRoomBtn').addEventListener('click', doFindRoom);
  roomNameInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME compose commit, not a submit
    if (e.key === 'Enter') doFindRoom();
  });
  roomNameInput.addEventListener('input', () => {
    generatedRoomName = ''; // manual edit cancels the one-shot auto-create
    hideCreatePrompt(); // prompt refers to the previously searched name
    showMenuError('');
  });

  $('createRoomBtn').addEventListener('click', doCreateRoom);
  $('confirmCreateBtn').addEventListener('click', () => {
    const room = pendingCreateName;
    if (!room) { hideCreatePrompt(); return; }
    showMenuError('');
    hideCreatePrompt();
    commitServer();
    if (H.onCreateRoom) H.onCreateRoom(room, $('publicToggle').checked);
  });

  $('refreshBtn').addEventListener('click', () => {
    showMenuError('');
    commitServer();
    if (H.onRefreshRooms) H.onRefreshRooms();
  });
  serverInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME compose commit, not a submit
    if (e.key === 'Enter') {
      const spec = commitServer();
      if (H.onServerChange) H.onServerChange(spec);
    }
  });

  $('roomSelectBackBtn').addEventListener('click', () => showPage('roomShow'));

  refreshCharDisplays();
  showPage('entry');
  $('menu').style.display = 'flex';
}

// Exit button lives in the HUD. The in-game touch layer listens on document
// and preventDefaults unclaimed touches (which suppresses their click), so
// stop propagation at the button — the tap then produces a normal click.
export function bindExit(onExit) {
  const exitBtn = $('exitBtn');
  exitBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  exitBtn.addEventListener('click', () => { if (onExit) onExit(); });
}

// ---------- shared menu helpers ----------

export function showMenuError(msg) {
  $('menuError').textContent = msg || '';
}

// Colored connection status in the server section summary line.
export function setConnStatus(text, ok) {
  const el = $('connStatus');
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
  el.classList.toggle('bad', !ok);
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

// On disconnect/exit: show the menu on entryPage. msg -> showMenuError.
export function backToMenu(msg) {
  $('hud').style.display = 'none';
  $('menu').style.display = 'flex';
  hideCreatePrompt();
  showPage('entry');
  showMenuError(msg || '');
  // Release pointer lock so the menu is usable after a disconnect.
  if (document.pointerLockElement) document.exitPointerLock();
}
