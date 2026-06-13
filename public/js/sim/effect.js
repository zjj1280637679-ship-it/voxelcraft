// EffectResolver — the WHOLE interaction system in one function + data.
//   effect = base × clamp(1 + Σ matching id-tag modifiers)
//     > 0  damage (combat / mining: deplete target HP)
//     = 0  immune (specialised weapon vs wrong target)
//     < 0  heal   (negative damage = +HP; on a block = repair)
// tier-affinity, tool-fit, 克制, 抗性, healing, repair, player-bane — ALL are data
// {tag→val} packs on the attacker/affix/armour. No tier/combat/heal-specific code.

// prefix match: modTag ⊑ targetTag  (exact, or a dotted-path ancestor).
// e.g. mod '生物' matches target '生物.龙'; mod '生物.龙' matches only the dragon.
export function tagMatch(modTag, targetTag) {
  return targetTag === modTag || targetTag.startsWith(modTag + '.');
}

// Sum the value of every modifier whose tag is a prefix of ANY target tag
// (each modifier counts at most once). Additive → order-independent (序-safe).
export function affinity(modPack, targetTags) {
  let sum = 0;
  for (let i = 0; i < modPack.length; i++) {
    const m = modPack[i];
    for (let j = 0; j < targetTags.length; j++) {
      if (tagMatch(m.tag, targetTags[j])) { sum += m.val; break; }
    }
  }
  return 1 + sum;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// base   = raw power (= slot × tier; no tool → body strength)
// modPack = the actor's {tag,val}[] data pack (weapon + affix + armour merged by caller)
// FLOOR/CAP are DATA: "无免疫" = a designer keeping the matched pack ≥ -100% (FLOOR can also
// be set ≥ a positive floor to force never-zero). Default FLOOR = -Infinity allows heal/massage.
export function effect(base, modPack, targetTags, FLOOR = -Infinity, CAP = Infinity) {
  return base * clamp(affinity(modPack, targetTags), FLOOR, CAP);
}
