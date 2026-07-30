// CI gate: verify-cart-4 must stay identity-aware, render-gated, and honest about what it measured.
//
// It was a NODE COUNT (`≥4` on a DOM row count, then `≤4` on `cartBadge ?? n`), which was identity-BLIND
// — it counted to 4 and never read an item, so a leftover could satisfy the threshold and a
// boosted-merchandise hijack could pass with the wrong product in the cart. Its failure text then blamed
// "baseline clear-cart did not empty leftover items", a cause it never tested, and that misdirected the
// whole 2026-07-30 diagnosis toward cart accumulation.
//
// STATIC, browser-free invariants so CI holds the line cheaply. The behavioural proof — 3-of-4 SKUs, a
// leftover, the right count with the WRONG product, and an unmounted cart app in real Chromium — lives in
// `scripts/redtest-cart-identity.mjs`.
//
// ★ Comments are stripped before matching (#118/#119 precedent). The spec deliberately QUOTES both the
//   removed count assertions and the old misleading message in its own documentation; a gate that read
//   those quotes as the defect returning would fire on a correct file.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'monitors/wegmans/full-shop-flow.spec.ts';
const raw = readFileSync(join(root, REL), 'utf8');
const code = raw
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .map((l) => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const errors = [];
const must = (ok, msg) => { if (!ok) errors.push(msg); };

// Isolate the verify-cart-4 step body so the assertions below cannot be satisfied by unrelated code.
const at = code.indexOf("runStep(page, 'verify-cart-4'");
must(at !== -1, "verify-cart-4 step not found — this gate is scanning the wrong thing");
const after = code.slice(at === -1 ? 0 : at);
const v4 = after.slice(0, after.indexOf('\n    });') + 1);

// 1. The node-count pair must not come back.
must(!/toBeLessThanOrEqual\(4\)/.test(code), 'the ≤4 node-count assertion is back — verify-cart-4 must assert identity, not a threshold');
must(!/toBeGreaterThanOrEqual\(4\)/.test(v4), 'the ≥4 node-count assertion is back in verify-cart-4');
must(!/cartBadge \?\? n/.test(code), 'the `cartBadge ?? n` count fallback is back');

// 2. Identity: the step must assert on SKUs derived from the cart API, not on a count.
must(/function cartSkusFromBody/.test(code), 'cartSkusFromBody is gone — the cart API body is the identity source');
must(/function skuFromProductUrl/.test(code), 'skuFromProductUrl is gone — it is how the run learns what it added');
must(/serverCartSkus/.test(v4), 'verify-cart-4 must compare against the server cart SKUs');
must(/expectedAdds/.test(v4), 'verify-cart-4 must compare against what the run actually added');
must(/missing/.test(v4) && /extra/.test(v4), 'verify-cart-4 must report MISSING and EXTRA skus by name');

// 3. No hardcoded SKUs — a catalog change must move the expectation, not manufacture a failure.
must(
  !/\b(55066|46155|60715|92685)\b/.test(v4),
  'verify-cart-4 hardcodes SKU literals — the expectation must come from what the run added',
);

// 4. The RENDER gate must exist and must fail as itself.
must(/the \/cart app did not render/.test(code), 'the unmounted-cart failure must report the RENDER condition');
const iRender = v4.indexOf('did not render');
const iIdentity = v4.indexOf('serverCartSkus');
must(
  iRender !== -1 && iIdentity !== -1 && iRender < iIdentity,
  'the render gate must be asserted BEFORE any cart-contents claim (a count off a shell page means nothing)',
);

// 5. The message contract: state what was measured, name no untested cause. These exact phrases are what
//    sent the 2026-07-30 diagnosis to the wrong subsystem.
for (const phrase of ['did not empty leftover items', 'clearing failed', 'they accumulated']) {
  must(!code.includes(phrase), `the failure text claims "${phrase}" again — a cause verify-cart-4 does not test`);
}
must(/MEASURED/.test(v4), 'verify-cart-4 messages must state what was MEASURED');

if (errors.length) {
  console.error(`cart-identity gate FAILED (${errors.length}) in ${REL}:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nSee scripts/redtest-cart-identity.mjs for the behavioural proof.');
  process.exit(1);
}
console.log(`cart-identity gate OK: verify-cart-4 asserts SKU identity, gates on render, names no cause (${REL}).`);
