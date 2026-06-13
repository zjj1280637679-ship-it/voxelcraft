// Pure simulation constants. NO DOM / three.js / timers / Math.random / Date.now.
// The sim kernel is rate-independent: drivers feed it dt; it never reads a clock.

export const DT_FIXED = 1 / 10;          // fixed sim step (s)
export const MAX_CATCHUP_TICKS = 5;      // cap ticks per reduce() — anti spiral-of-death

// Block id partition (DESIGN): 0..8 builtin / 9..63 dev static-craft / 64..255 player custom.
export const BUILTIN_MAX = 8;
export const STATIC_CRAFT_MIN = 9;
export const CUSTOM_MAX = 255;

// Behaviour primitives the kernel can execute. DATA (action packs) only picks among
// these by name + params; adding a NEW prim is the rare reviewed kernel change.
export const PRIMS = ['idle', 'wander', 'flee', 'chase', 'hop'];
