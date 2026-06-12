# VoxelCraft — Architecture Contract (v2 — player-hosted rooms)

A Minecraft-style voxel sandbox that runs in the **browser** on PC, Android and iOS,
with **room-based multiplayer** over WebSocket. No build step: plain ES modules served
statically. three.js is vendored at `public/lib/three.module.js` (r184).

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
| A server | `server/index.js` |
| B shell/UI | `public/index.html`, `public/style.css`, `public/js/ui.js` |
| C data | `public/js/noise.js`, `public/js/terrain.js`, `public/js/world.js` |
| D graphics | `public/js/textures.js`, `public/js/mesher.js`, `public/js/renderer.js` |
| E input/physics | `public/js/player.js`, `public/js/controls-desktop.js`, `public/js/controls-touch.js` |
| F glue | `public/js/network.js`, `public/js/host.js`, `public/js/main.js` |

Do not modify: `package.json`. `public/js/constants.js` additionally exports
`PALETTE` — exactly 8 hex color strings for character shirts/pants, e.g.
`['#e74c3c','#e67e22','#f1c40f','#5dbb46','#1abc9c','#3498db','#9b59b6','#e8ecf2']`.
Read constants.js before implementing — use its exports
(`CHUNK`, `HEIGHT`, `BLOCK`, `HOTBAR`, `PLAYER`, `PALETTE`, `chunkIndex`,
`chunkKey`, `blockKey`).

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
— the host player's name. The lobby renders a room row as
"<房间名> · <N>人"(meta unused for now but kept for future fields). Treat meta
as attacker-controlled: render with textContent only, tolerate any shape.

### Game layer (inside `d`; host's browser is the authority)

**Characters & skins.** A player presents as a character `{name, skin}` where
`skin = {s: <0..7>, p: <0..7>}` — indices into `PALETTE` (new export in
constants.js: array of 8 hex colors) for shirt (`s`) and pants (`p`). The host
validates inbound skins (integers in range, else `{s:0, p:0}`); clients render
remote players' bodies with these colors. Characters are a pure client concept
stored in localStorage; the protocol only ever carries `{name, skin}`.

member → host:
- `{t:'hello', name, skin}` — sent right after `accepted`; re-sent to the new host
  if `newhost` arrives before `joined` (the original hello may have died with the
  old host). On a duplicate hello the host re-unicasts `joined`, nothing else.
- `{t:'move', p:[x,y,z], ry, rx}` — feet pos, yaw, pitch. ≤ ~12 Hz.
- `{t:'block', x, y, z, id}` — block edit (id 0 = broken).

host → member(s):
- `{t:'joined', room, seed, id, players:[{id,name,p,ry,skin}], edits:[[x,y,z,id],...]}`
  — unicast reply to `hello`. `id` = recipient's relay id. `players` includes the
  host itself, excludes the recipient. `edits` serialized from host's `world.edits`.
- `{t:'pjoin', id, name, p, ry, skin}` — broadcast to others when a member's hello
  is accepted.
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
- Required element ids (others may use them): `gameCanvas` (the WebGL canvas);
  `menu` (overlay hosting TWO pages, exactly one visible at a time):
  - **`profilePage`** (人物页, shown first): character card list `charList`
    (each card: 2D canvas preview of the boxy avatar in its colors + name;
    tap = select & go to lobby; an "编辑" affordance per card), new-character
    button `newCharBtn`; character editor `charEditor` (shown when creating/
    editing): name input `charNameInput` (maxlength 16), shirt swatch row
    `shirtSwatches` + pants swatch row `pantsSwatches` (8 PALETTE swatches each,
    selected one highlighted), live preview canvas `charPreview`, save
    `saveCharBtn`, cancel `cancelCharBtn`, delete `deleteCharBtn` (edit mode only).
  - **`lobbyPage`** (房间页): connection status `connStatus` + server input
    `serverInput`; active-character row: label `activeCharLabel`("人物：xx")+
    switch button `switchCharBtn`("换人物" → back to profilePage); the single
    **room-name input `roomNameInput`** (placeholder "房间名（留空 = 随机新房间）",
    1–16 **code points** validated in JS — HTML maxlength counts UTF-16 units
    and must NOT be used on this input) + go button `goBtn`("进入房间");
    create prompt `createPrompt`
    (hidden by default: text "没有找到「xx」" + public checkbox `publicToggle`
    (default checked, "公开房间") + confirm button `confirmCreateBtn`
    ("创建这个房间")); **history section** `historyHeader`("我的足迹") +
    `historyList` (above the public list, both hidden when history is empty);
    "其他公开房间" list header with `refreshBtn` → `roomList`;
    error line `menuError`.
  - **Empty room name + 进入房间 = a random new room**: ui.js generates a random
    Chinese room name (adjective + place + 2-digit number, e.g. "迷雾森林42";
    pools of ≥8 adjectives / ≥8 places; ≤16 code points), fills it into
    `roomNameInput`, and runs the normal onEnterRoom flow — but remembers the
    generated name, and when `showCreatePrompt(thatName)` comes back it SKIPS the
    prompt and directly calls `onCreateRoom(name, server, publicToggle.checked)`
    (one-shot: the flag clears after use, so a later manual retry shows the
    prompt normally). If the random name happens to exist, the player simply
    joins it.
  - **History ("我的足迹")**: ui.js owns localStorage `vc-history` — array of
    `{room, host: bool, t}` (newest first, max 20, deduped by client-side
    normalized name: NFC + trim + collapse spaces + toLowerCase). Recorded via
    `recordHistory(room, isHost)` (called by main on entering a room; `host=true`
    when the player created it — once true it stays true on later visits).
    Rendering merges the latest live room list: a history row shows
    "房间名 · N人" when live, "房间名 · 不在线" otherwise; rows where
    `host === true` render the name in gold (`.room-own`, color #f1c40f) —
    自己创建过的房间. Each history row has a small "×" delete button
    (≥40px touch target, click must NOT trigger the row's join): it removes the
    LOCAL history entry only — a live world is never affected by it (the only
    way a live room ends is everyone leaving; a host who leaves abdicates and
    the oldest member inherits — existing migration). Rows in `roomList`
    (其他公开房间) exclude live rooms already shown in the history section.
  `hud` (crosshair `crosshair`, hotbar `hotbar`, room label `roomLabel`,
  exit button `exitBtn` — top-right, label "退出", pointer-events auto, touch
  target ≥40px),
  `touchUI` (joystick base `joystick`, knob `joyKnob`, jump button `jumpBtn`),
  toast container `toast`.
- Single module script: `<script type="module" src="js/main.js"></script>`.
- UI text in Chinese (menu title "VoxelCraft", go button "进入房间", create
  button "创建这个房间", name placeholder "你的名字", room placeholder
  "房间名（查找或创建）").

`public/style.css`:
- Dark, clean menu centered; game fills viewport; `#gameCanvas { touch-action: none; }`
- `body { margin:0; overflow:hidden; position:fixed; inset:0; }` (prevents iOS rubber-banding).
- Safe-area: HUD/touch controls padded with `env(safe-area-inset-*)`.
- Hotbar: bottom-center row of 8 slots (40–48px, larger touch targets on coarse
  pointers via `@media (pointer: coarse)`), selected slot highlighted.
- `#touchUI` hidden by default; shown only when touch controls init.
- Joystick: fixed bottom-left zone ~120px circle, knob 50px. Jump button bottom-right.

`public/js/ui.js` exports (ui.js OWNS character storage —
localStorage `vc-chars` = JSON array of `{name, skin:{s,p}}`, `vc-active` =
active index; all localStorage reads/writes wrapped in try/catch; imports
`PALETTE` from constants.js for swatches/previews; still no three.js):
```js
export function initMenu({ onEnterRoom, onCreateRoom, onRefresh, onExit, onCharPicked });
// Shows #menu. Page logic owned by ui.js:
//  - profilePage first when no character exists (and editor opens straight away
//    on a completely fresh install); otherwise lobbyPage with the saved active char.
//  - Character cards: tap -> set active, call onCharPicked(char), show lobbyPage.
//    switchCharBtn -> profilePage. Editor save -> persist + select + lobby.
//    Deleting the last character returns to the empty profile state.
//  - onEnterRoom(roomName, server)            — goBtn / Enter key / room-row pick
//  - onCreateRoom(roomName, server, isPublic) — confirmCreateBtn inside createPrompt
//  - onRefresh(server)                        — refresh button; also wires #exitBtn -> onExit()
//  - Server input persists as 'vc-server' (initial: saved > VC_DEFAULT_SERVER > '').
//  - Prefills roomNameInput from ?room=<URL-encoded name>.
export function getActiveChar();             // {name, skin} | null
export function recordHistory(room, isHost); // push/update 'vc-history' (see above);
                                             // re-renders the history section
export function showCreatePrompt(roomName);  // reveal createPrompt ("没有找到「xx」…");
                                             // if roomName matches the one-shot generated
                                             // random name, skip the prompt and call
                                             // onCreateRoom directly (see above)
export function hideCreatePrompt();          // hide it (also auto-hidden on input edit)
export function showMenuError(msg);
export function setConnStatus(text, ok);     // colored status line on lobbyPage
export function renderRooms(rooms, onPick);  // rooms: [{room, players}] (live list) ->
                                             // renders BOTH sections: history (merged with
                                             // live data, gold for host===true, × delete)
                                             // and 其他公开房间 (live rooms not in history).
                                             // textContent only; empty public list ->
                                             // "暂无公开房间，创建一个吧"; onPick(roomName)
                                             // fires for rows in either section.
export function setRoomsLoading();           // list placeholder "刷新中…"
export function hideMenu();                  // hide menu, show #hud
export function setRoomLabel(name, playerCount);
export function buildHotbar(icons);          // icons: array of 8 dataURL strings
export function setHotbarSelection(i);       // highlight slot i (0..7)
export function onHotbarTap(cb);             // cb(i) when a slot is clicked/tapped
export function toast(msg);                  // transient message (3s)
export function backToMenu(msg?);            // on disconnect/exit: show menu (lobbyPage)
```

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
  addPlayer(id, name, skin)    // boxy avatar with three parts: head 0.5^3 (fixed
                           // skin tone #e0ac69), torso 0.6x0.6x0.3 = PALETTE[skin.s],
                           // legs 0.6x0.6x0.3 = PALETTE[skin.p]; invalid/missing skin
                           // -> {s: id % 8, p: (id + 3) % 8}; name sprite above head
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
                           //  hello → store name + validated skin ({s,p} ints 0..7,
                           //    else {s:0,p:0}), mark helloed, unicast `joined`
                           //    (buildJoined(from)), cast `pjoin` to others
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
  adoptMembers(map)        // migration seeding: Map<id,{name,p,ry,skin}> (all helloed)
}
```
`World` must expose `seed` (constructor stores it) so `buildJoined` can read it.

`public/js/main.js` — orchestration. Two modes sharing one game session.

**Lobby (menu = the connection layer, decoupled from the game):**
- The player identity comes from `getActiveChar()` (set via `onCharPicked`);
  `name` and `skin` below always mean the active character's.
- On boot, after `initMenu`, auto-connect to the initial server value and call
  `listRooms()`; `onRooms` → `renderRooms` (rows "房间名 · N人"; pick = enter that
  room name). Connect success → `setConnStatus('已连接 · ' + (server || '本站'), true)`;
  failure → `setConnStatus('未连接（检查服务器地址后点刷新）', false)` and an empty
  list (NOT a thrown error — lobby failure must not block the menu).
- `onRefresh(server)`: if `server` differs from `net.connectedTo` (or socket closed),
  close the old socket and reconnect to the new address, then `listRooms()`.
  Show `setRoomsLoading()` while in flight. Same reconnect-if-changed logic runs
  before enter/create.
- **Exit button** (`onExit`, in-game): tear down synchronously (stopGame +
  backToMenu, no error message), then `net.close()`; afterwards auto-reconnect
  the lobby and refresh the list. A host exiting this way triggers normal host
  migration for the remaining members.

1. Boot: atlas icons → `buildHotbar`,
   `initMenu({onEnterRoom,onCreateRoom,onRefresh,onExit,onCharPicked})`,
   lobby auto-connect (above).
2. **Enter room — find-first (`onEnterRoom(roomName, server)`)**: ensure connected →
   `net.joinRoom(roomName)`. On `accepted` → member flow (3). On error `no-room` →
   `showCreatePrompt(roomName)` (NOT a menuError — this is the expected "not found,
   create it?" path; clear `busy` so the user can act). Other errors → showMenuError
   (`full` → "房间已满", `bad-name` → "房间名需为 1–16 个字符").
3. **Create (host mode, `onCreateRoom(roomName, server, isPublic)`)**: ensure
   connected → `net.hostRoom({room: roomName, public: isPublic, meta: {n: name}})`
   → on `onHosted`: pick `seed`, `world = new World(seed)`, `hostRoom = new
   HostRoom(...)`, `startGame(...)` as before. On error `taken` (someone created
   it in between): fall back to `net.joinRoom(roomName)` automatically.
4. **Member flow**: on `onAccepted`: `net.sendToHost({t:'hello', name, skin})`;
   on `onMsg` `joined` → `startGame(msg)`. Track
   `remoteInfo: Map<id, {name, p, ry, skin}>` updated from `joined.players`,
   `pjoin`, `pmove`; pass skin through to `renderer.addPlayer(id, name, skin)`.
5. **History recording**: right after a session starts (both modes), call
   `recordHistory(roomCode, mode === 'host')`.
6. **Reply deadlines (anti-wedge)**: every lobby request that sets `busy`/awaits a
   relay reply arms a deadline that, on expiry, `net.close()`s (recovering via the
   normal `onClose` path) — not just `join`. Specifically: `host` (createRoom) and
   the lobby `list` refresh get the same ~10s deadline `join` already has, cleared
   on `hosted`/`rooms` respectively. A half-open socket whose frame was silently
   dropped must never leave the menu dead for minutes.
7. **Touch session reset**: `initTouchControls` returns `{ tick, reset }`; `stopGame`
   calls `reset()` to clear all per-touch tracking (joystick anchor, look touches,
   jump ids, move input) so a finger held across exit cannot drive or mis-trigger
   (ghost break / joystick drift) the next session.
5. Game loop unchanged, except move sending: ≤12 Hz throttle lives in main;
   host mode → `hostRoom.castOwnMove(...)`, member mode → `sendToHost({t:'move',...})`.
6. Block interaction unchanged, except: host mode → `world.setBlock` +
   `hostRoom.castOwnBlock`; member mode → `world.setBlock` + `sendToHost({t:'block',…})`.
7. **Migration**: `onPromote` → if no world, `net.close()` (accepted edge); else
   become host: `hostRoom = new HostRoom(...)`; `adoptMembers` from `remoteInfo`
   filtered to `peers`; remove `oldHostId` (renderer + remoteInfo); rewire callbacks;
   toast "你已接任房主"; log `[vc] promoted to host`.
   `onNewHost` → remove `oldHostId` avatar/info, toast "<旧名> 离开，<新名> 接任房主".
8. Disconnect (`onClose`): stop loop, then `backToMenu('连接已断开')` for an
   unexpected close while playing, or `backToMenu()` (no message) when the user
   pressed the exit button (track a `leaving` flag set by `onExit`). Either way,
   afterwards auto-reconnect the lobby and refresh the room list.
9. **Wake lock**: while hosting on a touch device, request
   `navigator.wakeLock?.request('screen')`; re-acquire on `visibilitychange` →
   visible; release on stopGame. Wrap in try/catch (unsupported browsers).
10. `setHotbarSelection` sync + resize handling — as v1.
11. Keep `window.__vc` debug handle; add `hostRoom`, `mode` ('host'|'member'),
    and `remoteInfo` getters.

## Performance budgets
- Mobile target: ≥ 30 fps on a mid-range phone. RADIUS 3 (touch) / 4 (desktop).
- ≤ 2 chunk generations + ≤ 2 mesh rebuilds per frame after initial load.
- Dispose geometries on chunk unload. One material for all chunks.
- No per-frame allocations in hot paths where easily avoidable.
