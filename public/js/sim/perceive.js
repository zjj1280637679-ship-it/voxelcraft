// Lightweight IN-GAME PERCEPTION organ. Instead of a screenshot (heavy, occluded by
// terrain), read the world blocks + entities BY CODE and render a top-down ASCII
// "文字画" the agent can read directly. Also a tiny test-arena builder.

import { BLOCK } from '../constants.js';

// block id → 1 char (top-down surface view)
const BLOCK_CH = {
  [BLOCK.AIR]: ' ', [BLOCK.GRASS]: '.', [BLOCK.DIRT]: ',', [BLOCK.STONE]: '#',
  [BLOCK.SAND]: '~', [BLOCK.LOG]: 'T', [BLOCK.LEAVES]: 't', [BLOCK.PLANK]: '=',
  [BLOCK.BRICK]: 'B', [BLOCK.DIAMOND]: 'D',
};

function surfaceChar(world, x, z) {
  const y = world.surfaceHeight(x, z);
  if (y < 0) return ' ';
  const ch = BLOCK_CH[world.getBlock(x, y, z)];
  return ch !== undefined ? ch : '?';
}

// Top-down ASCII map centred on the player. Creatures overlay as their code's first
// letter (uppercase); the player as '@'. north ↑ (smaller z), east → (larger x).
export function perceive({ world, simDriver, player, radius = 10 }) {
  const cx = Math.floor(player.pos.x), cz = Math.floor(player.pos.z);
  const overlay = new Map();        // "x,z" → char (creatures + player; drawn over blocks)
  overlay.set(cx + ',' + cz, '@');
  if (simDriver) {
    for (const e of simDriver.state.ents.values()) {
      overlay.set(Math.floor(e.x) + ',' + Math.floor(e.z), (e.m.p[0] || '?').toUpperCase());
    }
  }
  const rows = [];
  for (let z = cz - radius; z <= cz + radius; z++) {
    let row = '';
    for (let x = cx - radius; x <= cx + radius; x++) {
      row += overlay.get(x + ',' + z) ?? surfaceChar(world, x, z);
    }
    rows.push(row);
  }
  const roster = simDriver
    ? [...simDriver.state.ents.values()].map(
        (e) => `  ${(e.m.p[0] || '?').toUpperCase()} ${e.m.p}(${e.m.a}) @(${e.x.toFixed(1)},${e.z.toFixed(1)}) hp${e.hp} bob=${(e.bob || 0).toFixed(2)}`)
    : [];
  const bar = '─'.repeat(radius * 2 + 1);
  return [
    `透视 @玩家(${cx},${cz}) 半径${radius} 北↑东→`,
    '图例: @玩家 D钻石 #石 .草 ,土 ~沙 T木 t叶 =板 B砖  生物=代号首字母',
    '┌' + bar + '┐',
    ...rows.map((r) => '│' + r + '│'),
    '└' + bar + '┘',
    `生物 ${roster.length}:`,
    ...roster,
  ].join('\n');
}

// Build a flat diamond plain "outside the world" (a floating slab above the terrain)
// and spawn a grid of in-place hoppers on it as a clean, observable test stage.
export function buildTestArena({ world, simDriver, renderer, player, spawn }) {
  const cx = 8, cz = 8, R = 8, Y = 50;
  for (let x = cx - R; x <= cx + R; x++) {
    for (let z = cz - R; z <= cz + R; z++) {
      world.setBlock(x, Y, z, BLOCK.DIAMOND);
      for (let y = Y + 1; y <= Y + 5; y++) world.setBlock(x, y, z, BLOCK.AIR);
    }
  }
  if (simDriver && spawn) {
    simDriver.clear();
    const codes = ['fowl_small', 'rabbit', 'golem'];
    let n = 0;
    for (let gx = -4; gx <= 4; gx += 4) {
      for (let gz = -4; gz <= 4; gz += 4) {
        spawn(codes[n % codes.length], 'hop_in_place', cx + gx + 0.5, cz + gz + 0.5, 0x1000 + n * 17);
        n++;
      }
    }
  }
  player.pos.x = cx + 0.5; player.pos.z = cz - 7.5; player.pos.y = Y + 2;
  player.vel.x = 0; player.vel.y = 0; player.vel.z = 0;
  player.yaw = Math.PI; player.pitch = -0.45;
  return `钻石平原 ${R * 2 + 1}×${R * 2 + 1} @ y${Y} 已搭, ${simDriver ? simDriver.state.ents.size : 0} 只蹦跳生物`;
}
