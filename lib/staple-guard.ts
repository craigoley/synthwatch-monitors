// PURE staple-guard decision logic — the DOM-free core of full-shop-flow.spec.ts's selectStapleResult
// + landed-verify, extracted so it can be UNIT-TESTED against fixture result-sets (no auth, no live site,
// no Playwright browser). red_tests has zero rows; this is the harness that finally proves the guard REDS.
//
// ★ THE SINGLE-FILE FETCH CONSTRAINT: the runner fetches a spec single-file and esbuilds it with exactly
//   one alias (lib/flow) — so the SPEC CANNOT import this module (it would fail to compile in the runner).
//   The spec therefore keeps an INLINE copy of MERCH_REJECT/STAPLE_GUARDS/the selection loop; this module
//   MIRRORS it verbatim and tests/staple-guard.spec.ts asserts PARITY (the inline copy == this module) so
//   the two can't silently drift. Fully de-duplicating (spec imports from lib/flow) needs the lib/flow
//   vendored-marker + specShim mirror + LIBFLOW-VENDOR-SHA bump in the runner repo — that's phase 2.

export type ResultTile = { slug: string; name: string };
export type StapleGuard = { require: RegExp; reject: RegExp; id?: string };

// ── MIRROR of the spec's inline literals (kept byte-identical; parity-tested) ──────────────────────────
export const MERCH_REJECT =
  /red.?white.?blue|patriotic|independence|memorial.?day|labor.?day|easter|cadbury|creme ?egg|peeps|dye.?kit|jelly.?bean|\bcandy\b|chocolate|\bcookie|\bcake\b|cupcake|dessert|pudding|egg.?nog|\bnog\b|pumpkin.?spice|gingerbread|peppermint|shamrock|st\.?.?patrick|valentine|christmas|hanukkah|halloween|thanksgiving|holiday|seasonal|limited.?edition|gift.?(set|basket|card)|\bbundle\b|scented|candle|\bsoap\b|shampoo|lotion|\bkit\b|flavored/i;

export const STAPLE_GUARDS: Record<string, StapleGuard> = {
  milk: { id: '55066', require: /\bmilk\b/i, reject: MERCH_REJECT },
  eggs: { id: '46155', require: /\beggs?\b/i, reject: MERCH_REJECT },
  bread: {
    require: /bread|loaf|baguette|bagel|\brolls?\b|\bbuns?\b|ciabatta|\bpita\b|naan|sourdough|brioche|challah|focaccia|\brye\b|multigrain/i,
    reject: MERCH_REJECT,
  },
};

/** The selection decision — the DOM-free core of selectStapleResult. PRIMARY: the pinned SKU (immune to
 *  boost/reorder AND blocklist rot). FALLBACK: the first result that IS the staple (require) and is NOT
 *  merchandised (reject), matched on slug + link text. Returns { index, via } or null when NO staple
 *  matches — which is exactly where the spec THROWS (a RED), never a silent .first(). `via==='fallback'`
 *  with a pinned guard is where the spec emits STAPLE-PIN-MISS. */
export function pickStaple(results: ResultTile[], g: StapleGuard): { index: number; via: 'id' | 'fallback' } | null {
  if (g.id) {
    const i = results.findIndex((r) => r.slug.startsWith(`${g.id}-`));
    if (i >= 0) return { index: i, via: 'id' };
  }
  for (let i = 0; i < results.length; i++) {
    const text = `${results[i].slug} ${results[i].name}`;
    if (g.require.test(text) && !g.reject.test(text)) return { index: i, via: 'fallback' };
  }
  return null;
}

/** The landed-PDP verify predicate — the second half of the guard. TRUE = a real staple; FALSE = the spec
 *  throws (a boosted promo slipped through). Note it uses the SAME reject list as pickStaple — a novel
 *  promo term defeats both halves, which is why the id-pin (pickStaple's primary) is the real defence. */
export function isStapleSlug(slug: string, g: StapleGuard): boolean {
  return g.require.test(slug) && !g.reject.test(slug);
}
