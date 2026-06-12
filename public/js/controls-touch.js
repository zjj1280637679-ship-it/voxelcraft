// Touch input: floating joystick on the left 40% of the screen, look-drag
// elsewhere, quick tap = place, 400ms still hold = break, jump button.
// Every listener is { passive: false } and calls preventDefault for game
// touches — required so iOS Safari never scrolls, zooms or rubber-bands.

const LOOK_SENS = 0.005;
const PITCH_MAX = (89 * Math.PI) / 180;
const TAP_MAX_MS = 250;
const HOLD_MS = 400;
const TAP_MAX_PX = 12;
const DEADZONE = 0.15;
const JOY_RANGE = 40;    // px offset for full speed
const KNOB_TRAVEL = 35;  // px max visual knob excursion

export function isTouchDevice() {
  return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    || ('ontouchstart' in window);
}

export function initTouchControls(player, hooks) {
  const ui = document.getElementById('touchUI');
  const knob = document.getElementById('joyKnob');
  if (ui) ui.style.display = 'block';
  console.log('[vc] touch controls enabled');

  let joy = null;            // { id, sx, sy } — anchor at touch start
  const looks = new Map();   // identifier -> drag/tap/hold state
  const jumpIds = new Set();

  function setMoveInput(nx, ny) {
    // Screen coords: nx right-positive, ny down-positive.
    player.input.r = nx > 0 ? nx : 0;
    player.input.l = nx < 0 ? -nx : 0;
    player.input.b = ny > 0 ? ny : 0;
    player.input.f = ny < 0 ? -ny : 0;
  }

  function updateJoy(t) {
    const dx = t.clientX - joy.sx;
    const dy = t.clientY - joy.sy;
    let nx = dx / JOY_RANGE;
    let ny = dy / JOY_RANGE;
    const m = Math.hypot(nx, ny);
    if (m < DEADZONE) {
      nx = 0; ny = 0;
    } else {
      // Rescale so input ramps 0..1 between deadzone edge and full range.
      const c = m > 1 ? 1 : m;
      const s = ((c - DEADZONE) / (1 - DEADZONE)) / m;
      nx *= s; ny *= s;
    }
    setMoveInput(nx, ny);
    if (knob) {
      const d = Math.hypot(dx, dy);
      const k = d > KNOB_TRAVEL ? KNOB_TRAVEL / d : 1;
      knob.style.transform = 'translate(' + dx * k + 'px,' + dy * k + 'px)';
    }
  }

  function endJoy() {
    joy = null;
    setMoveInput(0, 0);
    if (knob) knob.style.transform = '';
  }

  function endLook(st, id, allowTap, ts) {
    looks.delete(id);
    if (allowTap && !st.broke && !st.moved && ts - st.t0 < TAP_MAX_MS) {
      hooks.onPlace();
    }
  }

  function closestEl(target, sel) {
    return target instanceof Element ? target.closest(sel) : null;
  }

  function onStart(e) {
    if (!hooks.isPlaying()) return;
    let handled = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (closestEl(t.target, '#jumpBtn')) {
        jumpIds.add(t.identifier);
        player.input.jump = true;
        handled = true;
      } else if (closestEl(t.target, '#hotbar, #menu, #toast')) {
        // Leave UI touches untouched so taps still produce clicks.
        continue;
      } else if (joy === null && t.clientX < window.innerWidth * 0.4) {
        joy = { id: t.identifier, sx: t.clientX, sy: t.clientY };
        updateJoy(t);
        handled = true;
      } else {
        // Hold-to-break is evaluated from tick() in the rAF loop, never from a
        // timer: pending touchend tasks flush before rAF callbacks, so a lifted
        // finger always removes its entry before the hold can fire (a setTimeout
        // could beat a queued touchend under main-thread jank and break a block
        // for what the user performed as a quick tap).
        looks.set(t.identifier, {
          sx: t.clientX, sy: t.clientY,
          lx: t.clientX, ly: t.clientY,
          t0: e.timeStamp,
          moved: false, broke: false,
        });
        handled = true;
      }
    }
    if (handled) e.preventDefault();
  }

  function onMove(e) {
    if (!hooks.isPlaying()) return;
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (joy && t.identifier === joy.id) {
        updateJoy(t);
      } else if (looks.has(t.identifier)) {
        const st = looks.get(t.identifier);
        const dx = t.clientX - st.lx;
        const dy = t.clientY - st.ly;
        st.lx = t.clientX;
        st.ly = t.clientY;
        player.yaw -= dx * LOOK_SENS;
        player.pitch -= dy * LOOK_SENS;
        if (player.pitch > PITCH_MAX) player.pitch = PITCH_MAX;
        if (player.pitch < -PITCH_MAX) player.pitch = -PITCH_MAX;
        if (!st.moved
            && Math.hypot(t.clientX - st.sx, t.clientY - st.sy) > TAP_MAX_PX) {
          st.moved = true;
        }
      }
    }
  }

  // Not gated on isPlaying: tracked touches must always release cleanly.
  function onEnd(e) {
    let handled = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const id = t.identifier;
      if (jumpIds.delete(id)) {
        if (jumpIds.size === 0) player.input.jump = false;
        handled = true;
      } else if (joy && id === joy.id) {
        endJoy();
        handled = true;
      } else if (looks.has(id)) {
        endLook(looks.get(id), id, true, e.timeStamp);
        handled = true;
      }
    }
    if (handled) e.preventDefault();
  }

  function onCancel(e) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const id = e.changedTouches[i].identifier;
      if (jumpIds.delete(id) && jumpIds.size === 0) player.input.jump = false;
      if (joy && id === joy.id) endJoy();
      if (looks.has(id)) endLook(looks.get(id), id, false, e.timeStamp);
    }
  }

  // Called once per frame from the game loop with the rAF timestamp (same
  // timeline as event.timeStamp). Fires hold-to-break exactly once per touch.
  function tick(now) {
    for (const st of looks.values()) {
      if (!st.moved && !st.broke && now - st.t0 >= HOLD_MS) {
        st.broke = true;
        hooks.onBreak();
        if (navigator.vibrate) navigator.vibrate(40);
      }
    }
  }

  // Clear all per-touch tracking so a finger held across a session boundary
  // cannot drive movement or mis-trigger (ghost break / joystick drift) the
  // next session. Idempotent: safe to call when nothing is tracked.
  function reset() {
    looks.clear();
    jumpIds.clear();
    player.input.jump = false;
    endJoy();  // joy = null, zeroes move input, recenters the knob
  }

  const opts = { passive: false };
  document.addEventListener('touchstart', onStart, opts);
  document.addEventListener('touchmove', onMove, opts);
  document.addEventListener('touchend', onEnd, opts);
  document.addEventListener('touchcancel', onCancel, opts);
  // iOS pinch-zoom uses proprietary gesture events; block them outright.
  document.addEventListener('gesturestart', (e) => e.preventDefault(), opts);

  return { tick, reset };
}
