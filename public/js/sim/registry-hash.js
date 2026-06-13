// REGISTRY_HASH — derived from the code-layer registries (ordered arrays). Members
// compare it at handshake; mismatch ⇒ refuse the room (version lock). FNV-1a 32-bit:
// same input → same hex on every device (32-bit int ops only, no floats).

import { PROTOTYPES } from './prototypes.js';
import { ACTION_PACKS } from './actionpacks.js';

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Canonical serialise: registries are stable ordered arrays, so JSON order is fixed.
export function hashRegistry(...regs) { return fnv1a(JSON.stringify(regs)); }

export const REGISTRY_HASH = hashRegistry(PROTOTYPES, ACTION_PACKS);
