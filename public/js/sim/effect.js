// EffectResolver v2 — the WHOLE interaction system as SET ALGEBRA over id-tags.
//
//   effect = base × GATE(masks) × clamp(1 + Σ two-sided bias, FLOOR, CAP)
//     > 0 damage · = 0 immune · < 0 heal/repair
//
// A condition PACK = { only?:[tags], except?:[tags], mods?:[{tag,val,when?:[tags]}], use?:['@kit'] }
//   · GATE   multiplicative {0,1} set-membership mask — only=whitelist("除X都不行"), except=blacklist("除X都行")
//   · BIAS   additive signed Σ, TWO-SIDED (attacker offense vs defender tags + defender defense vs attacker tags);
//            each mod may carry a `when:[premise]` checked against the ACTOR's own context tags
//   · use    flatten named condition docs (KITS) — "等级/附魔/技能" cited by code, bounded+cycle-guarded
//   · @set   a tag may be a named cross-cutting union (SETS)
// All combine rules are commutative (AND of memberships, Σ of biases) ⇒ order-independent (序-safe).
// Backward compatible: effect(base, modsArray, targetTags, FLOOR, CAP) is a thin one-sided wrapper.

import { KITS, SETS } from './kits.js';

// prefix match: modTag ⊑ targetTag (exact, or a dotted-path ancestor).
export function tagMatch(modTag, targetTag) {
  return targetTag === modTag || targetTag.startsWith(modTag + '.');
}

// expand a (possibly '@named') tag to concrete tags; match if ANY expands-and-prefixes ANY target.
function expand(tag) { return SETS[tag] || [tag]; }
function matchAny(tag, tags) {
  const xs = expand(tag);
  for (let i = 0; i < xs.length; i++) for (let j = 0; j < tags.length; j++) if (tagMatch(xs[i], tags[j])) return true;
  return false;
}
function inSet(setTags, tags) { for (let i = 0; i < setTags.length; i++) if (matchAny(setTags[i], tags)) return true; return false; }
function holds(need, ctx) { for (let i = 0; i < need.length; i++) if (!matchAny(need[i], ctx)) return false; return true; } // premise: all present

const asPack = (p) => (Array.isArray(p) ? { mods: p } : (p && typeof p === 'object' ? p : {}));

// flatten use:['@kit'] refs into one flat mods list (bounded depth, cycle-guarded). Missing doc =
// empty contribution (§3.7 隔). Σ commutative ⇒ flatten order never changes the result.
function flatten(pack, seen) {
  let mods = pack.mods ? pack.mods.slice() : [];
  if (pack.use) {
    seen = seen || new Set();
    for (let i = 0; i < pack.use.length; i++) {
      const ref = pack.use[i];
      if (seen.has(ref)) continue;
      seen.add(ref);
      const kit = KITS[ref];
      if (kit) mods = mods.concat(flatten(kit, seen));
    }
  }
  return mods;
}

// Σ of every ACTIVE mod whose tag-set matches ANY of the other party's tags (each counts once).
// `when` gates a mod on/off by the actor's OWN context tags. Additive ⇒ order-independent.
function bias(mods, otherTags, selfCtx) {
  let sum = 0;
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    if (m.when && !holds(m.when, selfCtx)) continue;
    if (matchAny(m.tag, otherTags)) sum += m.val;
  }
  return sum;
}

// GATE: 0 suppresses the whole interaction (hard immunity / whitelist). AND of membership tests.
function gate(pack, otherTags) {
  if (pack.only && !inSet(pack.only, otherTags)) return 0;     // 除了 only 之外都不行
  if (pack.except && inSet(pack.except, otherTags)) return 0;  // 除了 except 之外都行
  return 1;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// TWO-SIDED resolve. atk/def are condition PACKS (or bare mods arrays); atkTags/defTags the id-tags.
export function resolve(base, atk, defTags, def, atkTags, FLOOR = -Infinity, CAP = Infinity) {
  atk = asPack(atk); def = asPack(def);
  atkTags = atkTags || []; defTags = defTags || [];
  const g = gate(atk, defTags) * gate(def, atkTags);
  if (g === 0) return 0;
  const a = 1 + bias(flatten(atk), defTags, atkTags) + bias(flatten(def), atkTags, defTags);
  return base * g * clamp(a, FLOOR, CAP);
}

// affinity (legacy one-sided) — 1 + Σ matching, with kit-flatten + @set support. order-independent.
export function affinity(modPack, targetTags) {
  return 1 + bias(flatten(asPack(modPack)), targetTags, []);
}

// effect (legacy one-sided entry) — thin wrapper over resolve, no defender pack. Identical to v1
// for a bare {tag,val}[] pack (the existing weapons/tests pass unchanged).
export function effect(base, modPack, targetTags, FLOOR = -Infinity, CAP = Infinity) {
  return resolve(base, asPack(modPack), targetTags, {}, [], FLOOR, CAP);
}
