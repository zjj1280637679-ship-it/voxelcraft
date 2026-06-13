// Player physics: feet-anchored AABB (WIDTH x HEIGHT x WIDTH), per-axis
// move-and-resolve collision against world.getBlock.

import { BLOCK, PLAYER } from './constants.js';

const HALF = PLAYER.WIDTH / 2;
const EPS = 0.001;        // gap kept between AABB and block faces after a snap
const MAX_STEP = 0.5;     // per-axis sub-step (< 1 block) prevents tunneling
const MAX_FALL = 50;      // terminal velocity, m/s

export class Player {
  constructor(world, spawn) {
    this.world = world;
    this.spawn = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.pos = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.fly = false;        // 变身成会飞的形态(龙)时开启:无重力 + Space升/Shift降
    this.input = { f: 0, b: 0, l: 0, r: 0, jump: false, down: 0, fire: false, useApple: false };
  }

  update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;

    let mf = this.input.f - this.input.b;
    let ms = this.input.r - this.input.l;
    const len = Math.hypot(mf, ms);
    if (len > 1) { mf /= len; ms /= len; }

    // yaw 0 looks toward -z: forward = (-sin, -cos), right = (cos, -sin)
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this.vel.x = (-sy * mf + cy * ms) * PLAYER.SPEED;
    this.vel.z = (-cy * mf - sy * ms) * PLAYER.SPEED;

    if (this.fly) {
      // flight (dragon form): no gravity; hold/ascend/descend from Space / Shift.
      const up = (this.input.jump ? 1 : 0) - (this.input.down ? 1 : 0);
      this.vel.y = up * PLAYER.FLY;
    } else {
      this.vel.y -= PLAYER.GRAVITY * dt;
      if (this.vel.y < -MAX_FALL) this.vel.y = -MAX_FALL;
      if (this.input.jump && this.onGround) {
        this.vel.y = PLAYER.JUMP;
        this.onGround = false;
      }
    }

    this._moveAxis('x', this.vel.x * dt);
    this.onGround = false;
    this._moveAxis('y', this.vel.y * dt);
    this._moveAxis('z', this.vel.z * dt);

    if (this.pos.y < -10) {
      this.pos.x = this.spawn.x;
      this.pos.y = this.spawn.y;
      this.pos.z = this.spawn.z;
      this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
    }
  }

  eye() {
    return { x: this.pos.x, y: this.pos.y + PLAYER.EYE, z: this.pos.z };
  }

  lookDir() {
    const cp = Math.cos(this.pitch);
    return {
      x: -Math.sin(this.yaw) * cp,
      y: Math.sin(this.pitch),
      z: -Math.cos(this.yaw) * cp,
    };
  }

  _moveAxis(axis, amount) {
    if (amount === 0) return;
    const sign = amount > 0 ? 1 : -1;
    let remaining = Math.abs(amount);
    while (remaining > 0) {
      const step = remaining > MAX_STEP ? MAX_STEP : remaining;
      this.pos[axis] += step * sign;
      remaining -= step;
      if (!this._collides()) continue;
      // Penetration < MAX_STEP, so snapping to the violated block face is exact.
      const p = this.pos;
      if (axis === 'y') {
        if (sign > 0) {
          p.y = Math.floor(p.y + PLAYER.HEIGHT) - PLAYER.HEIGHT - EPS;
        } else {
          p.y = Math.floor(p.y) + 1 + EPS;
          this.onGround = true;
        }
        this.vel.y = 0;
      } else if (sign > 0) {
        p[axis] = Math.floor(p[axis] + HALF) - HALF - EPS;
        this.vel[axis] = 0;
      } else {
        p[axis] = Math.floor(p[axis] - HALF) + 1 + HALF + EPS;
        this.vel[axis] = 0;
      }
      return;
    }
  }

  _collides() {
    const p = this.pos;
    // Shrink upper bounds by a hair so exact face contact does not count.
    const x0 = Math.floor(p.x - HALF), x1 = Math.floor(p.x + HALF - 1e-7);
    const y0 = Math.floor(p.y), y1 = Math.floor(p.y + PLAYER.HEIGHT - 1e-7);
    const z0 = Math.floor(p.z - HALF), z1 = Math.floor(p.z + HALF - 1e-7);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (this.world.getBlock(x, y, z) !== BLOCK.AIR) return true;
        }
      }
    }
    return false;
  }
}
