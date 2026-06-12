# 《永远的山根乡》 — Architecture Contract (v3 — six-page menu · skin v2 · local world saves)

A Minecraft-style voxel sandbox that runs in the **browser** on PC, Android and iOS,
with **room-based multiplayer** over WebSocket. No build step: plain ES modules served
statically. three.js is vendored at `public/lib/three.module.js` (r184).

**Naming**: the game's player-facing name is **《永远的山根乡》** — used for `<title>`,
the menu title and every piece of UI text (entry-page subtitle: 「回到你的方块世界」).
**VoxelCraft** is retained strictly as the English codename: repo/package/file names,
the `[vc]` log prefix, build artifacts. The string "VoxelCraft" must not appear in
player-facing UI text.

**v2 architecture**: the server is a game-agnostic **dumb relay** (room directory +
byte forwarding, zero game logic). The player who creates a room is the **host**: their
browser tab runs the authoritative room logic (`public/js/host.js`). Because every
client holds the full world state (seed + edit set), the relay performs **host
migration** when the host disconnects: the oldest member is promoted and the room
survives. Host-side room logic must stay **event-driven (no timers)** — background
tabs throttle timers/rAF, but ws message handlers keep firing.

**This document is a binding contract.** Every module must export exactly the API
specified here and consume others only through these APIs. If you must deviate,
report the deviation in your final output.

## Stack & hard rules

- Server: Node.js 24, ESM (`"type": "module"` in package.json), deps: `ws` only.
- Client: plain ES modules, **no framework, no bundler, no TypeScript**.
- three.js import (from files in `public/js/`): `import * as THREE from '../lib/three.module.js';`
- **No external network resources** (no CDN, no Google fonts) — phones join over LAN
  and may have no internet.
- Target three.js r184 APIs: `renderer.outputColorSpace = THREE.SRGBColorSpace`,
  `texture.colorSpace = THREE.SRGBColorSpace`, lights use physically-based intensity.
- All client lifecycle logging uses prefix `[vc]`, e.g. `console.log('[vc] joined room', code)`.
  Log: ws connected, joined room, player join/leave, chunk-gen complete, errors.
- Code comments: English, sparse, only for non-obvious constraints.

## File map & ownership (one agent per group, do not touch other groups' files)

| Group | Files |
|---|---|
| A server | `server/index.js` — **zero changes this round** |
| B shell/UI | `public/index.html`, `public/style.css`, `public/js/ui.js`, `public/js/menubg.js` (NEW) |
| C data | `public/js/noise.js`, `public/js/terrain.js`, `public/js/world.js` |
| D graphics | `public/js/textures.js`, `public/js/mesher.js`, `public/js/renderer.js` |
| E input/physics | `public/js/player.js`, `public/js/controls-desktop.js`, `public/js/controls-touch.js` |
| F glue | `public/js/network.js`, `public/js/host.js`, `public/js/main.js` |

Do not modify: `package.json`. `public/js/constants.js` exports
`PALETTE` — exactly 8 hex color strings for character tops/pants (unchanged):
`['#e74c3c','#e67e22','#f1c40f','#5dbb46','#1abc9c','#3498db','#9b59b6','#e8ecf2']`.

This round constants.js ADDITIONALLY exports (exact contents are normative —
whoever touches constants.js writes precisely these):

```js
// 6 skin tones, light -> dark. Index 1 === the legacy fixed head color #e0ac69,
// so migrated characters keep their old look.
export const SKIN_TONES = ['#f7d7b6', '#e0ac69', '#c98e54', '#a9743f', '#8d5524', '#5d3a1a'];

// 8 body types for skin v2. w scales avatar box x/z, h scales y; fem additionally
// scales the TORSO x/z by 0.92 (applied at render time, not stored here).
// (瘦 w=0.82, 壮 w=1.18, reference standard = 1; 矮 h=0.86, 高 h=1.08.)
export const BODIES = [
  { label: '男·矮瘦', w: 0.82, h: 0.86, fem: false }, // 0
  { label: '男·高瘦', w: 0.82, h: 1.08, fem: false }, // 1  <- legacy-migration default
  { label: '男·矮壮', w: 1.18, h: 0.86, fem: false }, // 2
  { label: '男·高壮', w: 1.18, h: 1.08, fem: false }, // 3
  { label: '女·矮瘦', w: 0.82, h: 0.86, fem: true  }, // 4
  { label: '女·高瘦', w: 0.82, h: 1.08, fem: true  }, // 5
  { label: '女·矮壮', w: 1.18, h: 0.86, fem: true  }, // 6
  { label: '女·高壮', w: 1.18, h: 1.08, fem: true  }, // 7
];
```

Read constants.js before implementing — use its exports
(`CHUNK`, `HEIGHT`, `BLOCK`, `HOTBAR`, `PLAYER`, `PALETTE`, `SKIN_TONES`,
`BODIES`, `chunkIndex`, `chunkKey`, `blockKey`).

## Coordinates & chunks

- World block coords: integer `x, y, z`; `y` up, `0 <= y < HEIGHT(64)`.
- Chunk coords: `cx = Math.floor(x / 16)`, `cz = Math.floor(z / 16)`.
  Local: `lx = x - cx*16`, `lz = z - cz*16`.
- Chunk data: `Uint8Array(16*16*64)` of block ids, index via `chunkIndex(lx, y, lz)`
  = `(y*16 + lz)*16 + lx`.
- Outside vertical range: `y < 0` treated as **solid stone** (for physics & face culling),
  `y >= HEIGHT` treated as air.
- Horizontally the world is unbounded; chunks generate on demand around players.

## Network protocol (JSON text frames over WebSocket, path `/ws`)

Two layers. The **relay layer** is all the server understands. Game payloads travel
opaquely inside `d` — the relay must never parse `d`.

### Relay layer (client ↔ relay server)

Every connection gets an integer id (incrementing from 1 per server run). A connection
is unbound until it sends `host` or `join`.
**Room identity = a user-chosen room NAME** (full Unicode, Chinese included — JSON/ws
carry it natively, no encoding needed). Normalization (server-side, applied to both
host and join): `String(x).normalize('NFC').trim()` + collapse internal whitespace
runs to a single space; lookup key = normalized name `.toLowerCase()`; the room's
display name = the normalized form as the creator typed it. Valid names are 1–16
code points after normalization — otherwise `{t:'error', code:'bad-name'}`.
Capacity: **8 connections per room** (host + 7 members).

Client → Relay:
- `{t:'host', room, public?, meta?}` — create the named room, become its host.
  If the key already exists: `{t:'error', code:'taken'}`. `public` defaults
  true; `meta` is an OPAQUE JSON value the relay stores and echoes in room lists
  but never parses (reject/ignore if its JSON serialization exceeds 256 chars —
  store null instead). Reply: `{t:'hosted', room:<display name>, id}`.
- `{t:'join', room}` — join by name (normalized lookup). Reply: `{t:'accepted',
  id, hostId}`, and the host receives `{t:'peer-in', id}`. Errors:
  `{t:'error', code:'no-room'}` / `{t:'error', code:'full'}` / `bad-name`.
- `{t:'list'}` — allowed from ANY connection, including unbound ones. Reply:
  `{t:'rooms', rooms:[{room, players, meta}]}` — **public rooms only**, players =
  members.size + 1, newest room first, capped at 50 entries.
- member: `{t:'msg', d}` — relay forwards to the host as `{t:'msg', from:<id>, d}`.
- host: `{t:'msg', to:<id>, d}` — relay forwards to that member as `{t:'msg', d}`.
- host: `{t:'cast', d, except?:<id>}` — relay forwards `{t:'msg', d}` to every member
  except `except`.

Relay → Client (besides the above forwards):
- to host on member disconnect: `{t:'peer-out', id}`.
- on host disconnect with members remaining — **host migration**: promote the member
  with the lowest join order. To the promoted member: `{t:'promote', room, oldHostId,
  peers:[<other member ids>]}` (its role becomes host). To the others:
  `{t:'newhost', hostId:<newId>, oldHostId}`. Room keeps its name. If no members
  remain, delete the room.
- Ignore malformed JSON, unknown `t`, game messages from unbound connections,
  and `msg` with a `to` id not in the room. A `cast` whose `except` id is no
  longer in the room is broadcast to **all** members — `except` exists only for
  echo suppression, and a departed originator must never drop the cast.
  Never crash on bad input.

Relay state: `rooms: Map<key, {name: <display>, host: ws, members: Map<id, ws>,
public: bool, meta: any, created: number}>` (plus per-ws `{id, room:<key>, role}`).
List entries are `{room: <display name>, players, meta}`. No seed, no edits,
no positions — zero game knowledge; `meta` is opaque bytes to the relay.

Meta convention (parsed by CLIENTS only, never by the relay): `{n: <string ≤24>}`
— the host player's name. The room-select page renders a public-room row as
"<房间名> · <N>人"(meta unused for now but kept for future fields). Treat meta
as attacker-controlled: render with textContent only, tolerate any shape.

### Game layer (inside `d`; host's browser is the authority)

**Characters & skins — protocol v2.** A player presents as a character
`{name, skin}` where `skin = {b, t, p, k}`, ALL integers:
- `b` body type, index into `BODIES` (constants.js), 0..7 — fixed order:
  男矮瘦 0, 男高瘦 1, 男矮壮 2, 男高壮 3, 女矮瘦 4, 女高瘦 5, 女矮壮 6, 女高壮 7;
- `t` top (上衣) color, index into `PALETTE`, 0..7;
- `p` pants (裤子) color, index into `PALETTE`, 0..7;
- `k` skin tone (肤色), index into `SKIN_TONES`, 0..5.

**Validation & legacy migration — ONE shared rule**, implemented identically in
all THREE places that accept a skin from outside: host.js (inbound `hello`,
`adoptMembers`), main.js member side (`joined.players`, `pjoin`), and the tools
bots (`tools/host-bot.js`, `tools/member-bot.js`). Checked in this order:
1. **v2 shape**: `b,t,p,k` all integers and in range (`0<=b<=7`, `0<=t<=7`,
   `0<=p<=7`, `0<=k<=5`) → take `{b,t,p,k}` as-is (copy; drop extra keys).
2. **legacy shape**: `s` and `p` both integers in `0..7` → migrate to
   `{b:1, t:s, p:p, k:1}`.
3. **anything else** → default `{b:1, t:0, p:0, k:1}`.

The wire may still carry legacy `{s,p}` skins (old clients/bots); every receiver
migrates on input, and a host only ever re-broadcasts validated v2 skins.
Characters are a pure client concept stored in localStorage (`vc-chars`, owned by
ui.js); legacy stored characters are **lazily migrated on read with the SAME
rule**. The protocol only ever carries `{name, skin}`.

member → host:
- `{t:'hello', name, skin}` — e.g. `{t:'hello', name:'阿明', skin:{b:5, t:2, p:6, k:3}}`.
  Sent right after `accepted`; re-sent to the new host
  if `newhost` arrives before `joined` (the original hello may have died with the
  old host). On a duplicate hello the host re-unicasts `joined`, nothing else.
- `{t:'move', p:[x,y,z], ry, rx}` — feet pos, yaw, pitch. ≤ ~12 Hz.
- `{t:'block', x, y, z, id}` — block edit (id 0 = broken).

host → member(s):
- `{t:'joined', room, seed, id, players:[{id,name,p,ry,skin:{b,t,p,k}}], edits:[[x,y,z,id],...]}`
  — unicast reply to `hello`. `id` = recipient's relay id. `players` includes the
  host itself, excludes the recipient; every `skin` is a host-validated v2 object,
  e.g. `players:[{id:1, name:'山根乡长', p:[8,40,8], ry:0, skin:{b:1, t:0, p:0, k:1}}]`.
  `edits` serialized from host's `world.edits`.
- `{t:'pjoin', id, name, p, ry, skin:{b,t,p,k}}` — broadcast to others when a
  member's hello is accepted (skin already host-validated v2).
- `{t:'pmove', id, p, ry, rx}` — relayed member moves AND the host's own moves
  (host stamps its own id).
- `{t:'pleave', id}` — on `peer-out`.
- `{t:'block', x, y, z, id}` — broadcast to **everyone, including the originating
  member** (no `except`). The host is the authority: it applies every edit to its
  own world via `world.applyEdit`, then echoes the authoritative result to all
  members. Re-applying one's own edit is idempotent; this is what makes two
  members editing the same cell **converge** to the host's arrival order instead
  of diverging. (`pmove` keeps its `except`-sender — positions self-heal; only
  `block` needs the echo.)
- `{t:'resync', edits:[[x,y,z,id],...]}` — full edit-log snapshot, serialized
  from the host's `world.edits` exactly like `joined.edits`. Members merge it via
  `world.applyEdit` (idempotent), marking affected chunks dirty. Used after host
  migration so the room converges on the new host's authoritative world (edits
  made during the dead-host window that the new host never saw are dropped — host
  state wins, which is what future joiners get too). Members validate it with the
  same per-entry filter as `joined.edits` (integers, in-range y and id).

Host migration (game layer consequences):
- Promoted member: builds a `HostRoom` from its **local** state — world (seed + edits
  it already has) + its tracked `remoteInfo` (id → {name, p, ry, skin}) filtered to `peers`.
  Removes `oldHostId` from tracking/renderer. Tracked players absent from `peers`
  left during the dead-host window (their `pleave` was lost): prune them and cast
  `pleave` for each so other members heal too. Toast "你已接任房主". **Then cast
  `resync`** (its full edit log) so every surviving member converges on the new
  host's world, healing any dead-host-window divergence.
- On `newhost`, a member that is **already playing** re-sends `hello` to the new
  host as well (idempotent: the host re-unicasts `joined`, which a playing member
  ignores; but a member the new host doesn't yet know gets announced via `pjoin`,
  closing the ghost-member gap). The `!playing` mid-join re-hello stays as before.
- Other members: remove `oldHostId` avatar, toast "<旧房主名> 离开，<新房主名> 接任房主"
  (fall back to id if a name is unknown). Game continues seamlessly — ids are stable
  across migration, the world state is already local.
- Known accepted edge: a member promoted before it ever received `joined` has no world
  and cannot host; it should disconnect, letting the relay promote the next member.

## Enter-world algorithm (进入世界 — zero-confirmation chain)

Owned by main.js; ui.js only fires the handlers. The entry page's `#enterWorldBtn`
(`onEnterWorld()`) must reach the game with ZERO further confirmations:

1. `ensureCharacter()` (ui.js): no character exists → silently generate a random
   one (random Chinese name + random valid v2 skin), persist as active. Never
   prompts, never navigates.
2. `last = getLastRoom()` (`vc-lastroom`):
   - **no last room** → generate a random Chinese room name (the existing
     generator: adjective + place + 2-digit number) and HOST it as a new
     **public** room.
   - **has last room** → `join(last)`:
     - `accepted` → normal member flow.
     - `no-room` → `getWorldSave(last)`:
       - save exists → HOST the room using the **saved `{seed, edits}`** (apply
         the saved edits to the new World before `startGame`). The world is
         reborn — this is the 「世界不消失」 design point.
       - no save → HOST a brand-new world under the same name.
     - `taken` (create race while hosting) → existing automatic fallback to
       `join` (unchanged).
3. On session start (both modes): `setLastRoom(room)` +
   `recordHistory(room, mode === 'host')`.

Room-select page actions map onto the same machinery:
- row **「使用」** and **`#findRoomBtn`** with a typed name = the SAME chain as
  step 2's "has last" branch (with that name), with ONE difference at the end:
  `no-room` + no world save → `showCreatePrompt(name)` 「没有找到「X」」 (confirm
  → `onCreateRoom`) instead of silent creation. Empty input + `#findRoomBtn` =
  the existing random-name one-shot (ui.js generates a name, fills the input,
  runs the chain; the matching `showCreatePrompt` auto-creates once, skipping
  the prompt).
- **`#createRoomBtn` 建立新房间** = explicitly a NEW world:
  `onCreateRoom(name, publicToggle.checked)` with **NO world-save lookup** — a
  stale save must never hijack a deliberately fresh room. Empty input → random
  name first.
- history row **「移除」** = `confirm()` then delete the history entry AND its
  `removeWorldSave(name)` (both inside ui.js).
- public row **「隐藏」** = add the normalized name to `vc-hidden`, re-render.

## Local world saves (世界本地存档)

Host AND members all save — every player who ever entered a room can later
rebuild it (deliberate design, not an accident). Storage is owned by ui.js:

- localStorage `vc-worlds` =
  `{ [normRoomKey(room)]: {room: <display name>, seed: <int>, edits: [[x,y,z,id],...], t: <ms timestamp of last save>} }`.
- Capacity: max **8** worlds; inserting beyond that evicts the entry with the
  oldest `t`.
- A single world whose edits exceed **60000** entries is REFUSED — `putWorldSave`
  becomes a no-op and emits `console.warn` once per session. Never throw, never
  write partially (quota/JSON failures likewise: try/catch, warn once, no-op).
- `normRoomKey(raw)` (exported by ui.js) mirrors the server normalization
  exactly: `NFC + trim + collapse internal whitespace runs + toLowerCase`.

Save timing (main.js drives, ui.js stores):
- on `startGame` (both modes): one immediate
  `putWorldSave(room, seed, editsFromWorld())`;
- afterwards EVERY world mutation — own `setBlock`, member-applied `block`,
  host-applied member edits, `resync` merge — schedules a save **debounced 2 s**
  (the debounce timer lives in main.js; the no-timer rule binds host.js only);
- exit / disconnect / `stopGame`: flush any pending save synchronously before
  teardown;
- `edits` are serialized from `world.edits` exactly like `buildJoined` does.

## Module contracts

### A. `server/index.js` (dumb relay)
- Node `http` server: serves `public/` statically (index.html for `/`), correct
  Content-Type for `.html .js .css .png .json` (`.js` → `text/javascript`).
  Reject path traversal. 404 otherwise.
- `ws` WebSocketServer attached to the same HTTP server on path `/ws`, constructed
  with `maxPayload: 64 * 1024` — ws auto-closes oversize frames (code 1009) so an
  unauthenticated client cannot push ~100 MB frames (ws's default) into the shared
  relay's parse/re-serialize path. 64 KB still covers a realistic `joined`/`resync`
  edit list.
- Liveness: ping every connection ~10s, `terminate()` on a missed pong, so an
  ungracefully dead host triggers migration promptly instead of waiting for the
  OS TCP timeout. (The no-timers rule binds host.js only, not the server.)
- Implements the **relay layer** above and nothing more — no game state, never
  parses `d`. Forwarding must re-serialize only the envelope (build the outgoing
  object, `JSON.stringify` once per distinct payload).
- Keep the existing: UTF-8 console fix (chcp 65001), EADDRINUSE friendly error,
  port `process.env.PORT || 8080`, host `0.0.0.0`, startup banner with all
  LAN IPv4 URLs.
- Log one line per lifecycle event: room created/deleted, peer join/leave,
  host migration (old id → new id).

### B. shell/UI
`public/index.html`:
- `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">`
- `<title>永远的山根乡</title>`.
- Required element ids (others may use them): `gameCanvas` (the WebGL canvas);
  `menu` (overlay hosting **SIX pages**, exactly one visible at a time; design
  rule: **show pages carry only the subject + entry buttons; lists live only on
  select pages**) plus ONE shared error line `menuError` placed in the menu
  shell so it is visible from whichever page is active:

  1. **`entryPage`** 世界入口首页 — title 「永远的山根乡」 + subtitle
     「回到你的方块世界」; fullscreen low-res world-render background canvas
     `menuBgCanvas` (driven by menubg.js; if it fails, the CSS gradient behind
     it simply shows through); info block: `entryCharName` (当前人物),
     `entryRoomName` (当前房间 — if the player ever created it, prefix ★ and
     apply the gold class `.room-own`), `entryRoomStatus` (exactly one of
     「查询中…」/「在线 n 人」/「不在线·有存档」/「不在线」/「未连接服务器」);
     three buttons: `enterWorldBtn`「进入世界」, `charPageBtn`「人物设定」,
     `roomPageBtn`「房间设定」. **No list of any kind on this page.**
  2. **`charShowPage`** 人物展示页 — `charShowPreview` canvas (the existing
     drawAvatar, enlarged) + `charShowName`; buttons `charEditBtn`「编辑人物」,
     `charSwitchBtn`「更换人物」, `charShowBackBtn`「返回」. Shows the name only —
     no detail dump.
  3. **`charSelectPage`** 人物选择页 — vertical list `charSelectList` (one row
     per character: name + buttons 「使用」「编辑」); `newCharBtn`「建立新人物」,
     `randomCharBtn`「随机建立」(creates a random-named, random-skinned character,
     saves + activates it), `charSelectBackBtn`「返回」.
  4. **`charEditorPage`** 人物设计页 — `charNameInput` (16-char cap enforced in
     JS); body list `bodyList` (8 selectable entries labeled from `BODIES`,
     selected one highlighted); THREE swatch groups: `topSwatches` 上衣
     (8 PALETTE colors), `pantsSwatches` 裤子 (8 PALETTE colors), `skinSwatches`
     肤色 (6 SKIN_TONES); live preview canvas `charPreview`; buttons
     `saveUseCharBtn`「保存并使用」, `randomizeCharBtn`「随机设计」(randomizes
     body + three colors in the editor, keeps the typed name),
     `deleteCharBtn`「删除人物」(hidden when creating), `charEditorBackBtn`「返回」.
     This round has exactly one species (human), so there is **NO category
     selection page** — one option means zero selection steps; the accessory
     system is parked, do not build any of it.
  5. **`roomShowPage`** 房间展示页 — `roomShowName` (★ + `.room-own` gold rule as
     above) + `roomShowStatus` (same status strings as `entryRoomStatus`);
     buttons `roomEnterBtn`「进入房间」, `roomSwitchBtn`「更换房间」,
     `roomShowBackBtn`「返回」. **NO 「管理房间」 button** — there is nothing to
     manage yet, and we do not surface systems that don't exist.
  6. **`roomSelectPage`** 房间选择页 — top: server mini-section (`serverInput`,
     existing rules unchanged — persisted as `vc-server`, prefilled from saved >
     `VC_DEFAULT_SERVER` > ''; `connStatus` lives here too; the section is
     collapsed to a single summary line by default, tap to expand);
     `roomNameInput` (placeholder 「房间名（留空 = 随机新房间）」, 1–16 **code
     points** validated in JS — HTML maxlength counts UTF-16 units and must NOT
     be used) + `findRoomBtn`「查找/进入」; then three list segments in fixed
     order **当前 > 历史 > 公开**:
     `currentRoomRow` (the `vc-lastroom` room with its status; hidden when no
     last room) → `historyList` (one row per history entry:
     ★?名字 · 状态 + buttons 「使用」「移除」) → `publicList` (one row per found
     public room: 名字 · n人 + buttons 「使用」「隐藏」; excludes rooms already
     present in history AND rooms in `vc-hidden`); `createRoomBtn`「建立新房间」
     with `publicToggle` checkbox (「公开房间」, default checked); the existing
     create-prompt ids (`createPrompt`, `createPromptText`, `confirmCreateBtn`)
     are reused for the 「没有找到「X」」 confirm flow; `refreshBtn`;
     `roomSelectBackBtn`「返回」.

  Page navigation is wired INSIDE ui.js: entryPage → charShowPage / roomShowPage
  via the two 设定 buttons; show pages → their select pages via the 更换 buttons;
  `charSelectList` row 「编辑」 / `newCharBtn` → charEditorPage; every back
  button walks exactly one level up (editor → charSelectPage, select pages →
  their show page, show pages → entryPage). Character row 「使用」 activates the
  character and returns to charShowPage; room row 「使用」 fires
  `onUseRoom(name)` (enters the game — see the enter-world algorithm).
  All user-controlled strings render via textContent ONLY; every Enter handler
  keeps the IME guard (`isComposing || keyCode === 229`).

  `hud` unchanged (crosshair `crosshair`, hotbar `hotbar`, room label
  `roomLabel`, exit button `exitBtn` — top-right, label "退出", pointer-events
  auto, touch target ≥40px; exiting now lands on **entryPage**),
  `touchUI` unchanged (joystick base `joystick`, knob `joyKnob`, jump button
  `jumpBtn`), toast container `toast` unchanged.
- Single module script: `<script type="module" src="js/main.js"></script>`.
- UI text in Chinese; menu title 「永远的山根乡」. The retired v2 ids must not
  survive anywhere (HTML, CSS or JS): `profilePage`, `lobbyPage`, `charList`,
  `charPicker`, `charEditor`, `charEditorTitle`, `shirtSwatches`, `saveCharBtn`,
  `cancelCharBtn`, `activeCharLabel`, `switchCharBtn`, `goBtn`, `historyHeader`,
  `roomList`.

`public/style.css`:
- Dark, clean menu centered; game fills viewport; `#gameCanvas { touch-action: none; }`
- `body { margin:0; overflow:hidden; position:fixed; inset:0; }` (prevents iOS rubber-banding).
- Six `.menu-page` sections, exactly one carrying the visible/active state.
- `#menuBgCanvas`: fixed, full viewport, behind all menu content; the layer
  behind it carries a CSS gradient so a failed/stopped menubg degrades silently.
- `.room-own { color:#f1c40f }` (gold) kept; the ★ prefix is text content
  (textContent), never CSS-generated.
- Swatch rows (`.swatch` + selected state) now come in three groups
  (top/pants/skin); `#bodyList` entries are buttons with a selected state.
- ALL list-row action buttons (使用/编辑/移除/隐藏) and `bodyList` entries:
  ≥40px touch targets; an action button's click/touch must not trigger any
  row-level handler.
- Safe-area: HUD/touch controls padded with `env(safe-area-inset-*)`.
- Hotbar: bottom-center row of 8 slots (40–48px, larger touch targets on coarse
  pointers via `@media (pointer: coarse)`), selected slot highlighted.
- `#touchUI` hidden by default; shown only when touch controls init.
- Joystick: fixed bottom-left zone ~120px circle, knob 50px. Jump button bottom-right.

`public/js/ui.js` — ui.js OWNS all menu localStorage (every read/write wrapped in
try/catch; imports `PALETTE`, `SKIN_TONES`, `BODIES` from constants.js for
swatches/previews; **still no three.js in ui.js** — menubg.js is a separate
module):
- `vc-chars` = JSON array of `{name, skin:{b,t,p,k}}`. Legacy `{s,p}` entries
  are **lazily migrated on read** with the shared skin rule (and written back in
  the new shape on the next persist).
- `vc-active` = active character index.
- `vc-history` = `[{room, host: bool, t}]`, newest first, max 20, deduped by
  `normRoomKey`. The stored field stays named `host` for compatibility, but its
  MEANING is 「我创建过这个房间」 (own) — see gold semantics below.
- `vc-server` = server spec (unchanged rules).
- NEW `vc-lastroom` = display name of the last room entered.
- NEW `vc-worlds` = local world saves (format in the 世界本地存档 section).
- NEW `vc-hidden` = array of normalized public-room names the player hid via
  「隐藏」; capped at 50, newest kept.
- Random generators (internal): room names — adjective + place + 2-digit number
  (e.g. 「迷雾森林42」, pools of ≥8 each, always ≤16 code points; existing
  generator, unchanged); character names — NEW, two pools of ≥8 (e.g.
  称号+名), result ≤16 chars; random skins — uniform over the valid v2 ranges.

```js
// ---- NEW API consumed by main.js (signatures binding, verbatim) ----
export function showPage(name);
// name ∈ 'entry'|'charShow'|'charSelect'|'charEditor'|'roomShow'|'roomSelect'.
export function initUi(handlers);
// handlers = {
//   onEnterWorld(),               // entryPage 进入世界 — zero-confirm chain (main.js)
//   onUseRoom(name),              // room row 「使用」 / roomEnterBtn / findRoomBtn
//   onCreateRoom(name, isPublic), // createRoomBtn + createPrompt confirm (explicit new world)
//   onRefreshRooms(),             // refreshBtn (and roomSelectPage shown); main re-lists
//   onServerChange(spec),         // serverInput committed (Enter); persisted as vc-server first
// }
// Loads all stores, builds the six pages' static content (swatches, bodyList),
// wires ALL internal page navigation, prefills roomNameInput from ?room=,
// shows entryPage. Empty-input random-name one-shot behavior is preserved:
// generated name -> fill input -> onUseRoom; the matching showCreatePrompt
// auto-creates once without prompting.
export function setEntryInfo({charName, roomName, own, status});
// entryPage info block. roomName null/'' renders '—'; own === true prefixes ★
// and applies .room-own; status is rendered verbatim (main composes the
// strings). textContent only.
export function setRoomShowInfo({roomName, own, status});  // same rules, roomShowPage
export function renderRoomSelect({current, history, found});
// current: {name, own, status} | null  -> #currentRoomRow (hidden when null)
// history: [{name, own, status}]       -> #historyList rows (使用/移除; ★+gold when own)
// found:   [{name, players}]           -> #publicList rows '名字 · n人' (使用/隐藏).
// ui.js itself filters `found` against history keys and vc-hidden; empty public
// list -> placeholder '暂无公开房间，创建一个吧'. All strings via textContent.
export function getActiveChar();        // {name, skin:{b,t,p,k}} | null — always migrated v2
export function ensureCharacter();      // returns the active char; if none exists,
                                        // silently creates a random one (random name +
                                        // random valid v2 skin), persists + activates it
export function getHistory();           // copy of vc-history: [{room, host: bool, t}]
                                        // (main composes statuses / own flags from it)
export function getLastRoom();          // display name | '' — from vc-lastroom
export function setLastRoom(name);
export function getWorldSave(room);     // {room, seed, edits, t} | null (normRoomKey lookup)
export function putWorldSave(room, seed, edits); // enforces the 8-world LRU-by-t cap and
                                        // the 60000-edit refusal (warn once, no-op)
export function removeWorldSave(room);
export function normRoomKey(raw);       // NFC + trim + collapse spaces + toLowerCase —
                                        // the exact client mirror of the server rule
export function bindExit(onExit);       // wires #exitBtn (click + touchstart
                                        // stopPropagation, as today) -> onExit();
                                        // successor of the old initMenu onExit wiring

// ---- retained exports (signatures unchanged) ----
export function recordHistory(room, isHost); // 'host' flag = 创建过, sticky once true;
                                             // store update ONLY — no longer re-renders
                                             // (rendering is main-driven via renderRoomSelect)
export function showCreatePrompt(roomName);  // reveal createPrompt 「没有找到「xx」」;
                                             // one-shot generated-name skip preserved
export function hideCreatePrompt();          // hide it (also auto-hidden on input edit)
export function showMenuError(msg);          // shared #menuError line
export function setConnStatus(text, ok);     // colored status line in the server section
export function hideMenu();                  // hide menu, show #hud (main also stops menubg)
export function setRoomLabel(name, playerCount);
export function buildHotbar(icons);          // icons: array of 8 dataURL strings
export function setHotbarSelection(i);       // highlight slot i (0..7)
export function onHotbarTap(cb);             // cb(i) when a slot is clicked/tapped
export function toast(msg);                  // transient message (3s)
export function backToMenu(msg?);            // on disconnect/exit: show menu, now on
                                             // **entryPage**; msg -> showMenuError
// REMOVED (superseded — delete, do not keep dead exports): initMenu -> initUi;
// renderRooms / setRoomsLoading / restoreRoomSections -> renderRoomSelect.
```

Avatar preview `drawAvatar` (ui.js-internal, reused enlarged on charShowPage):
updated for skin v2 — head fill `SKIN_TONES[k]`, torso `PALETTE[t]`, legs
`PALETTE[p]`; widths scaled by `BODIES[b].w` (torso width further ×0.92 when
`fem`), heights by `BODIES[b].h` — the same proportions renderer.addPlayer uses,
so the preview matches the in-game avatar.

**Gold semantics (binding, sitewide)**: ★/gold (`.room-own`) means
「我创建过这个房间」 — sourced from the vc-history `host` flag (sticky once
true). It must NOT be presented as 「我现在是房主」: hosting migrates while a
room lives, and the UI never claims live host status.

`public/js/menubg.js` (NEW, group B) — entry-page background renderer. Unlike
ui.js it MAY import three.js and the terrain/world modules:
```js
export function startMenuBg(canvas, seed);   // -> { stop() }
```
- Renders the seeded terrain (its own World/terrain instance, small radius —
  3–4 chunks is plenty) with a **slow orbiting camera**: a low-fi postcard of
  the world, not a playable view.
- **Low-res is binding**: `setPixelRatio(min(devicePixelRatio, 0.75))` or lower.
  rAF is allowed here (menu only — the host.js no-timer rule does not apply);
  `stop()` must cancel it.
- `stop()` cancels the loop and disposes ALL GL resources (geometries,
  materials, textures, renderer context).
- **Total failure containment**: every exception (WebGL unavailable, context
  loss, terrain error) is caught inside the module; on failure `startMenuBg`
  logs one `[vc] menubg failed` line and returns `{stop(){}}`. It must never
  throw into main.js — the CSS gradient fallback then shows through.
- Lifecycle (main.js drives): start when the menu is shown (boot and
  backToMenu; seed = the last room's world-save seed when available, else a
  fixed default), stop on hideMenu/startGame.

### C. data
`public/js/noise.js`:
```js
export function mulberry32(seed);            // -> () => float [0,1)
export function makeNoise2D(seed);           // -> (x,y) => float [-1,1], seeded simplex (self-contained impl)
export function hash2(x, z, seed);           // deterministic -> float [0,1), fast integer mix
```

`public/js/terrain.js`:
```js
export function makeGenerator(seed);         // -> { generateChunk(cx,cz): Uint8Array, heightAt(x,z): int }
```
- `heightAt(x,z)`: `h = round(26 + n1(x*0.012, z*0.012)*10 + n2(x*0.05, z*0.05)*4)`,
  clamp to [4, 50]. `n1`,`n2` are two `makeNoise2D` instances seeded `seed` and `seed+1337`.
- Column fill: `y=0` STONE always; `y < h-3` STONE; `h-3 <= y < h` DIRT; `y = h` GRASS.
  If `h <= 21`: top 4 layers SAND instead of dirt+grass (beach).
- Trees: a column hosts a tree iff its top is GRASS and `hash2(x,z,seed) < 0.01`.
  Trunk height `4 + floor(hash2(x,z,seed+7)*2)` of LOG above the surface; canopy of
  LEAVES: radius-2 square layers at trunk-top-1 and trunk-top, radius-1 layer +
  single block above. Leaves never overwrite LOG. Clamp `y < HEIGHT`.
  **Cross-chunk correctness:** when generating a chunk, scan columns from
  `cx*16-2 .. cx*16+17` × same for z; for each tree found, write only the blocks
  that fall inside this chunk. Same tree must produce identical blocks from any chunk.

`public/js/world.js`:
```js
export class World {
  constructor(seed)
  getBlock(x, y, z)        // id; y<0 -> STONE, y>=HEIGHT -> AIR, ungenerated chunk -> AIR
  setBlock(x, y, z, id)    // applies if chunk generated; records into this.edits;
                           // marks chunk dirty + neighbor chunks dirty when on a border
  applyEdit(x, y, z, id)   // same as setBlock but for network/initial edits
  ensureChunk(cx, cz)      // generate if missing, apply stored edits overlapping it, mark dirty
  ensureAround(x, z, radius, maxPerCall=2)  // ensure chunks in square radius around
                           // world pos, nearest-first, generating at most maxPerCall
                           // new chunks per call; returns count generated
  surfaceHeight(x, z)      // top-most non-air y at column (generates chunk if needed)
  raycast(origin, dir, maxDist)  // DDA voxel walk; origin/dir = THREE.Vector3-like {x,y,z};
                           // -> { x,y,z, face:[nx,ny,nz] } | null  (face = normal of hit face)
  chunks   // Map<chunkKey, Uint8Array>
  edits    // Map<blockKey, id>
  dirty    // Set<chunkKey> — renderer consumes & clears
}
```

### D. graphics
`public/js/textures.js`:
```js
export function buildAtlas();
// -> { texture: THREE.CanvasTexture, tileUV(tile): [u0,v0,u1,v1], blockIcon(id): dataURL }
```
- 64×64 canvas, 4×4 grid of 16×16 procedural pixel tiles (seeded speckle/noise look,
  NOT copied Minecraft art). Tile indices: 0 grass-top(green), 1 grass-side(dirt with
  green top strip), 2 dirt, 3 stone, 4 sand, 5 log-side(bark), 6 log-end(rings),
  7 leaves(dark green speckle), 8 plank(horizontal boards), 9 brick(red bricks + mortar).
- `texture`: `NearestFilter` mag & min, `generateMipmaps=false`, `colorSpace = SRGBColorSpace`.
- `tileUV` returns UVs **inset by 0.5px** (0.5/64) to avoid atlas bleeding.
- Also export:
```js
export const FACE_TILES = {
  [BLOCK.GRASS]:[1,1,0,2,1,1], [BLOCK.DIRT]:[2,2,2,2,2,2], [BLOCK.STONE]:[3,3,3,3,3,3],
  [BLOCK.SAND]:[4,4,4,4,4,4], [BLOCK.LOG]:[5,5,6,6,5,5], [BLOCK.LEAVES]:[7,7,7,7,7,7],
  [BLOCK.PLANK]:[8,8,8,8,8,8], [BLOCK.BRICK]:[9,9,9,9,9,9],
};  // face order: +x, -x, +y, -y, +z, -z
```
- `blockIcon(id)`: 32×32 dataURL drawn from the block's `+x` tile (upscaled, no smoothing).

`public/js/mesher.js`:
```js
export function buildChunkGeometry(world, cx, cz, tileUV);  // -> THREE.BufferGeometry | null (null if empty)
```
- Naive face culling: for each non-air block, emit a quad for each of 6 faces whose
  neighbor (via `world.getBlock` — **must work across chunk borders**) is AIR.
- Vertex attributes: `position` (chunk-local coords; mesh will be positioned at
  `(cx*16, 0, cz*16)`), `normal`, `uv` (from `tileUV(FACE_TILES[id][face])`), and
  `color` for face shading: +y → 1.0, ±z → 0.85, ±x → 0.72, −y → 0.5 (rgb all equal).
- Indexed geometry, correct outward winding. Keep grass-side upright on side faces.

`public/js/renderer.js`:
```js
export class Renderer {
  constructor(canvas)      // WebGLRenderer({canvas, antialias:false}), sky color 0x87ceeb,
                           // fog, hemisphere + directional light, outputColorSpace sRGB,
                           // pixelRatio = min(devicePixelRatio, 2), PerspectiveCamera fov 75
  setFogForRadius(radiusChunks)   // near = r*16*0.55, far = r*16*0.95
  atlas                    // result of buildAtlas(), created in constructor
  material                 // MeshLambertMaterial({ map: atlas.texture, vertexColors: true })
  updateChunk(world, cx, cz)   // (re)build mesh via buildChunkGeometry; dispose old geometry
  removeChunk(cx, cz)          // remove + dispose
  hasChunk(cx, cz)
  setHighlight(posOrNull)      // wireframe box (slightly inflated unit cube) at block pos
  addPlayer(id, name, skin)    // boxy avatar, three stacked boxes, skin v2.
                           // First run the skin through the SHARED validation/
                           // migration rule (v2 in-range -> as-is; legacy {s,p}
                           // -> {b:1,t:s,p:p,k:1}; else {b:1,t:0,p:0,k:1}) —
                           // the old id-derived color fallback is REMOVED.
                           // Base boxes (w=h=1): legs 0.6x0.6x0.3 (y 0..0.6),
                           // torso 0.6x0.6x0.3 (y 0.6..1.2), head 0.5^3
                           // (y 1.2..1.7). Scale x/z by BODIES[b].w (torso x/z
                           // further *0.92 when BODIES[b].fem), y sizes AND
                           // stack positions by BODIES[b].h. Colors: head
                           // SKIN_TONES[k], torso PALETTE[t], legs PALETTE[p].
                           // Name sprite above head (y = 1.7*h + 0.35)
  updatePlayer(id, p, ry, rx)  // sets interpolation target (lerp ~10/s in render())
  removePlayer(id)
  render(eyePos, yaw, pitch)   // position camera, advance avatar interpolation, draw
  resize()                     // call on window resize / orientationchange
}
```
Yaw/pitch convention (everyone must match): yaw rotates around Y (0 = looking toward −z),
pitch positive = looking up, clamped ±89°. Forward vector:
`(-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))`.

### E. input/physics
`public/js/player.js`:
```js
export class Player {
  constructor(world, spawn)    // spawn: {x,y,z} feet position
  pos; vel; yaw; pitch; onGround;
  input = { f:0, b:0, l:0, r:0, jump:false };   // set by controls each frame
  update(dt)     // gravity PLAYER.GRAVITY, walk PLAYER.SPEED along yaw, jump if onGround,
                 // AABB (WIDTH x HEIGHT x WIDTH) collision vs world, resolved per-axis
                 // (move x, resolve; move y, resolve; move z, resolve); dt clamped <= 0.05;
                 // if pos.y < -10 respawn at spawn
  eye()          // -> {x, y: pos.y + PLAYER.EYE, z}
  lookDir()      // -> normalized {x,y,z} from yaw/pitch (convention above)
}
```

`public/js/controls-desktop.js`:
```js
export function initDesktopControls(canvas, player, hooks);
// hooks: { onBreak(), onPlace(), onSelect(slotIndex), isPlaying() }
```
- Click canvas → `requestPointerLock()` (only when `isPlaying()`).
- mousemove (locked): yaw -= dx*0.0024, pitch -= dy*0.0024, clamp pitch.
- WASD/arrows → input.f/b/l/r; Space → jump. keyup resets. Digits 1–8 + wheel → onSelect.
- mousedown (locked): button 0 → onBreak, button 2 → onPlace. Prevent contextmenu.

`public/js/controls-touch.js`:
```js
export function isTouchDevice();   // matchMedia('(pointer: coarse)') || 'ontouchstart' in window
export function initTouchControls(player, hooks);
// hooks: { onBreak(), onPlace(), onSelect(i), isPlaying() }
```
- Shows `#touchUI`. All listeners `{ passive: false }` + `preventDefault()` (critical on iOS).
- Track touches by `identifier`. Joystick: touches starting on left 40% of screen;
  knob offset → input.f/b/l/r proportional (deadzone 0.15). `#jumpBtn` → jump while held.
- Look: touches starting elsewhere drag yaw/pitch (sensitivity ~0.005 rad/px).
- Tap (move < 12px): **< 250ms → onPlace; ≥ 400ms hold without move → onBreak** (fire once
  at 400ms, vibrate via `navigator.vibrate?.(40)`).
- Must not break when hotbar/jump are touched simultaneously with look/joystick.

### F. glue
`public/js/network.js` — relay-layer client, game-agnostic. Exports `relayUrl(spec)`
(normalizes a user-entered server address — bare host:port → ws, bare domain → wss,
explicit scheme wins, empty → same-origin) and `RelayNet.connect(serverSpec?)`.
The menu has an optional `serverInput` (ui.js persists it as 'vc-server'; per-build
default via `window.VC_DEFAULT_SERVER` set in `app-config.js` — empty for web,
overwritten in app builds). This lets native app builds (Capacitor) pick a relay
since they are not served by one:
```js
export class RelayNet {
  connect()                // ws(s)://location.host/ws — wss when location.protocol is
                           // https. -> Promise resolved on open, rejected on error.
  hostRoom(opts?)          // send {t:'host', public, meta} (opts: {public=true, meta=null})
  joinRoom(code)           // send {t:'join'}; reply via onAccepted / onError
  listRooms()              // send {t:'list'}; reply via onRooms
  sendToHost(d)            // member: {t:'msg', d}
  sendTo(id, d)            // host: {t:'msg', to:id, d}
  cast(d, exceptId)        // host: {t:'cast', d, except} (except omitted if null)
  close()
  connectedTo              // the serverSpec this socket was opened with ('' = same origin)
  // callback properties (set by main): onHosted({room,id}), onAccepted({id,hostId}),
  // onError(code), onRooms(rooms), onMsg(d, fromId|null), onPeerIn(id), onPeerOut(id),
  // onPromote({room,oldHostId,peers}), onNewHost({hostId,oldHostId}), onClose()
}
```

`public/js/host.js` — authoritative room logic, runs in the host's tab. **Strictly
event-driven: no setInterval/setTimeout/rAF here** (background tabs throttle timers;
ws message handlers keep firing). No three.js imports.
```js
export class HostRoom {
  constructor({ net, world, room, hostId, hostName, hostSkin, playerRef })
                           // playerRef: object with .pos {x,y,z} and .yaw — used to
                           // include the host in `joined` payloads. May be the
                           // delegating handle, never a snapshot.
  members                  // Map<id, {name, skin, p, ry, helloed:boolean}>
  handlePeerIn(id)         // register pending member (helloed=false)
  handleMsg(from, d)       // dispatch by d.t:
                           //  hello → store name + skin run through the SHARED
                           //    v2 validation/migration rule (v2 in-range ->
                           //    as-is; legacy {s,p} -> {b:1,t:s,p:p,k:1}; else
                           //    {b:1,t:0,p:0,k:1}), mark helloed, unicast
                           //    `joined` (buildJoined(from)), cast `pjoin` to others
                           //  move  → update member p/ry, cast `pmove` (id=from)
                           //    to others except sender
                           //  block → world.applyEdit(x,y,z,id), cast `block`
                           //    to ALL members including the sender (idempotent
                           //    echo; same-cell conflicts converge on the
                           //    host-accepted value — see protocol section)
                           //  (ignore messages from ids without peer-in, and
                           //   move/block before hello)
  handlePeerOut(id)        // remove member, cast `pleave`
  castOwnMove(p, ry, rx)   // {t:'pmove', id:hostId, ...} — caller throttles
  castOwnBlock(x, y, z, id)
  buildJoined(forId)       // {t:'joined', room, seed: world.seed, id: forId,
                           //  players: [host self from playerRef] + other helloed
                           //  members, edits: [[x,y,z,id],...] from world.edits}
  adoptMembers(map)        // migration seeding: Map<id,{name,p,ry,skin}> (all
                           // helloed); names AND skins re-run through the shared
                           // clean rules (a poisoned skin inherited from a
                           // malicious old host must not be re-broadcast)
}
```
`World` must expose `seed` (constructor stores it) so `buildJoined` can read it.

`public/js/main.js` — orchestration. Two modes sharing one game session.

**Menu (six pages; ui.js owns navigation and storage, main.js owns the
connection and the flows):**
- Identity = the active character (`getActiveChar()` / `ensureCharacter()`);
  `name` and `skin` below always mean the active character's — `skin` always a
  validated v2 object (run the shared rule on anything read from storage).
- Boot: atlas icons → `buildHotbar`; `initUi({onEnterWorld, onUseRoom,
  onCreateRoom, onRefreshRooms, onServerChange})`; `bindExit(handleExit)`;
  start the entry background — `startMenuBg(#menuBgCanvas, seed)` with seed =
  `getWorldSave(getLastRoom())?.seed`, else a fixed default; then lobby
  auto-connect to the initial server value + `listRooms()`. Connect success →
  `setConnStatus('已连接 · ' + (server || '本站'), true)`; failure →
  `setConnStatus('未连接（检查服务器地址后点刷新）', false)` and an empty list
  (NOT a thrown error — lobby failure must never block the menu).
- **Menu info upkeep**: after boot, after every `rooms` reply, and after any
  lastRoom / character / history change while the menu is visible, main
  recomputes and pushes `setEntryInfo`, `setRoomShowInfo` and
  `renderRoomSelect`. Status strings are composed by main: 「查询中…」 while a
  list request is in flight; 「在线 n 人」 when the room appears in the live
  list; otherwise 「不在线·有存档」 when `getWorldSave(room)` exists, else
  「不在线」; 「未连接服务器」 when the lobby socket is down. `own` flags come
  from `getHistory()`'s `host` field; history rows' statuses are composed the
  same way.
- `onRefreshRooms()` / `onServerChange(spec)`: reconnect-if-changed (if the
  spec differs from `net.connectedTo` or the socket is closed, swap sockets and
  redial), then `listRooms()`. While in flight show 「查询中…」 statuses. The
  same reconnect-if-changed logic runs before every join/host.
- **Exit button** (`bindExit` → handleExit, in-game): flush the pending world
  save, then tear down synchronously (stopGame + backToMenu, no error message),
  then `net.close()`; afterwards auto-reconnect the lobby, refresh the list and
  restart menubg. A host exiting this way triggers normal host migration for
  the remaining members.

1. **onEnterWorld / onUseRoom**: implement the 「Enter-world algorithm」 section
   verbatim — they share the existing find-first machinery (`busy`,
   `pendingAction`/`pendingRoom`, `taken`→join fallback). The `no-room` branch
   now forks: (a) world save exists → host with the SAVED seed/edits (see 2);
   (b) no save + flow is onEnterWorld → create directly (same name, fresh
   world, public per `publicToggle` default true); (c) no save + flow is
   onUseRoom/findRoomBtn → `showCreatePrompt(name)` (NOT a menuError; clear
   `busy` so the user can act). Other errors → showMenuError (`full` →
   "房间已满", `bad-name` → "房间名需为 1–16 个字符").
2. **Create (host mode, `onCreateRoom(name, isPublic)` and the save-rebuild
   path)**: ensure connected → `net.hostRoom({room, public: isPublic, meta:
   {n: name}})` → on `onHosted`: seed/edits come from a pending world-save
   rebuild when one was staged (`{seed, edits}` from `getWorldSave`), else a
   fresh random seed and no edits; `world = new World(seed)` (+ apply staged
   edits via `world.applyEdit`), `hostRoom = new HostRoom(...)`,
   `startGame(...)`. On error `taken` (lost the create race): fall back to
   `net.joinRoom(room)` automatically — staged save edits are discarded (the
   live room wins). `onCreateRoom` itself NEVER stages a save (建立新房间 = 全新世界).
3. **Member flow**: on `onAccepted`: `net.sendToHost({t:'hello', name, skin})`;
   on `onMsg` `joined` → `startGame(msg)`. Track
   `remoteInfo: Map<id, {name, p, ry, skin}>` updated from `joined.players`,
   `pjoin`, `pmove` — every inbound skin run through the shared v2 rule before
   it reaches `renderer.addPlayer(id, name, skin)`.
4. **Session start bookkeeping** (both modes, right after startGame):
   `setLastRoom(roomCode)`, `recordHistory(roomCode, mode === 'host')`, initial
   `putWorldSave(roomCode, seed, edits)`, stop menubg.
5. **World-save upkeep** (both modes): every world mutation (own setBlock,
   member-applied `block`, host-applied member edits, `resync` merge) schedules
   a debounced 2 s `putWorldSave`; flushed synchronously in stopGame/exit/
   disconnect. Serialization mirrors `buildJoined`.
6. **Reply deadlines (anti-wedge)**: every lobby request that sets `busy`/awaits
   a relay reply arms a deadline that, on expiry, `net.close()`s (recovering via
   the normal `onClose` path) — not just `join`. `host` and the lobby `list`
   refresh get the same ~10s deadline `join` already has, cleared on
   `hosted`/`rooms` respectively. A half-open socket whose frame was silently
   dropped must never leave the menu dead for minutes.
7. **Touch session reset**: `initTouchControls` returns `{ tick, reset }`;
   `stopGame` calls `reset()` to clear all per-touch tracking (joystick anchor,
   look touches, jump ids, move input) so a finger held across exit cannot
   drive or mis-trigger (ghost break / joystick drift) the next session.
8. Game loop unchanged, except move sending: ≤12 Hz throttle lives in main;
   host mode → `hostRoom.castOwnMove(...)`, member mode → `sendToHost({t:'move',...})`.
9. Block interaction unchanged, except: host mode → `world.setBlock` +
   `hostRoom.castOwnBlock`; member mode → `world.setBlock` + `sendToHost({t:'block',…})`.
   (Both paths also schedule the debounced world save — point 5.)
10. **Migration**: `onPromote` → if no world, `net.close()` (accepted edge); else
    become host: `hostRoom = new HostRoom(...)`; `adoptMembers` from `remoteInfo`
    filtered to `peers`; remove `oldHostId` (renderer + remoteInfo); rewire
    callbacks; cast `resync`; toast "你已接任房主"; log `[vc] promoted to host`.
    `onNewHost` → remove `oldHostId` avatar/info, re-hello,
    toast "<旧名> 离开，<新名> 接任房主". (Unchanged from v2.)
11. Disconnect (`onClose`): flush the world save, stop the loop, then
    `backToMenu('连接已断开')` for an unexpected close while playing, or
    `backToMenu()` (no message) when the user pressed the exit button (the
    `leaving` flag). Either way: afterwards auto-reconnect the lobby, refresh
    the room list, refresh the menu info (point 「Menu info upkeep」) and
    restart menubg — backToMenu lands on **entryPage**.
12. **Wake lock**: while hosting on a touch device, request
    `navigator.wakeLock?.request('screen')`; re-acquire on `visibilitychange` →
    visible; release on stopGame. Wrap in try/catch (unsupported browsers).
13. `setHotbarSelection` sync + resize handling — as before.
14. Keep `window.__vc` debug handle; add `hostRoom`, `mode` ('host'|'member'),
    and `remoteInfo` getters.

## Performance budgets
- Mobile target: ≥ 30 fps on a mid-range phone. RADIUS 3 (touch) / 4 (desktop).
- ≤ 2 chunk generations + ≤ 2 mesh rebuilds per frame after initial load.
- Dispose geometries on chunk unload. One material for all chunks.
- No per-frame allocations in hot paths where easily avoidable.
- menubg: pixelRatio ≤ 0.75, terrain radius 3–4 chunks, generated once at start
  (no per-frame chunk work); always stopped (loop cancelled, GL disposed)
  while a game session runs.
