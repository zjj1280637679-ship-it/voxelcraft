// Desktop input: pointer lock mouse-look, WASD/arrows, digits/wheel hotbar,
// left click break / right click place.

const SENS = 0.0024;
const PITCH_MAX = (89 * Math.PI) / 180;

export function initDesktopControls(canvas, player, hooks) {
  let sel = 0;

  const locked = () => document.pointerLockElement === canvas;

  const select = (i) => {
    sel = ((i % 8) + 8) % 8;
    hooks.onSelect(sel);
  };

  const resetMoveInput = () => {
    player.input.f = 0;
    player.input.b = 0;
    player.input.l = 0;
    player.input.r = 0;
    player.input.jump = false;
  };

  canvas.addEventListener('click', () => {
    if (!hooks.isPlaying() || locked()) return;
    const p = canvas.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  });

  document.addEventListener('pointerlockchange', () => {
    if (!locked()) resetMoveInput();
  });

  document.addEventListener('pointerlockerror', () => {
    console.warn('[vc] pointer lock failed');
  });

  document.addEventListener('mousemove', (e) => {
    if (!locked()) return;
    player.yaw -= e.movementX * SENS;
    player.pitch -= e.movementY * SENS;
    if (player.pitch > PITCH_MAX) player.pitch = PITCH_MAX;
    if (player.pitch < -PITCH_MAX) player.pitch = -PITCH_MAX;
  });

  document.addEventListener('mousedown', (e) => {
    if (!locked()) return;
    if (e.button === 0) hooks.onBreak();
    else if (e.button === 2) hooks.onPlace();
  });

  document.addEventListener('contextmenu', (e) => {
    if (locked() || e.target === canvas) e.preventDefault();
  });

  document.addEventListener('keydown', (e) => {
    if (!hooks.isPlaying()) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': player.input.f = 1; break;
      case 'KeyS': case 'ArrowDown': player.input.b = 1; break;
      case 'KeyA': case 'ArrowLeft': player.input.l = 1; break;
      case 'KeyD': case 'ArrowRight': player.input.r = 1; break;
      case 'Space': player.input.jump = true; break;
      default: {
        const m = /^Digit([1-8])$/.exec(e.code);
        if (!m) return;
        select(Number(m[1]) - 1);
        break;
      }
    }
    e.preventDefault();
  });

  // Not gated on isPlaying so keys never stick when the menu reopens mid-press.
  document.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': player.input.f = 0; break;
      case 'KeyS': case 'ArrowDown': player.input.b = 0; break;
      case 'KeyA': case 'ArrowLeft': player.input.l = 0; break;
      case 'KeyD': case 'ArrowRight': player.input.r = 0; break;
      case 'Space': player.input.jump = false; break;
    }
  });

  window.addEventListener('wheel', (e) => {
    if (!locked()) return;
    // Hotbar taps change the selection outside this module; re-sync so wheel
    // steps are relative to the actual current slot.
    if (hooks.getSelected) sel = hooks.getSelected();
    if (e.deltaY > 0) select(sel + 1);
    else if (e.deltaY < 0) select(sel - 1);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('blur', resetMoveInput);
}
