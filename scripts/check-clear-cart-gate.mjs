// CI gate: the baseline-clear-cart fail-open must stay closed.
//
// Over the 7 days to 2026-07-30, baseline-clear-cart was 359 pass / 0 fail — it had NEVER failed. It
// short-circuited on an UNWAITED header-badge read of `0` and returned `SUMMARY OK badge-empty` having
// navigated nothing, clicked nothing and verified nothing. The badge is client-rendered from cart state
// fetched after paint, so an immediate read can return the initial `0` of a cart that is not empty.
//
// These are STATIC, browser-free invariants so CI can hold the line cheaply. The behavioural proof —
// a real Chromium run against a fixture whose badge reads 0 pre-hydration on a 3-item cart — lives in
// `scripts/redtest-baseline-clear-cart.mjs` (run it by hand; it needs a browser).
//
// Each assertion below names the regression it prevents. A gate that cannot fail is worth nothing, so
// every check here is written against a property that the pre-fix file genuinely violated.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'monitors/wegmans/full-shop-flow.spec.ts';
const raw = readFileSync(join(root, REL), 'utf8');

/** Comments are stripped before every check below. The spec deliberately QUOTES the removed defect in its
 *  own docs ("it used to be `if (badge !== null) return badge;`"), and a gate that reads those quotes as
 *  the defect returning would fire on a correct file — a false red that trains people to ignore it. Drops
 *  whole-line comments and ` // …` tails; leaves string literals (and thus `https://…`) alone. */
const spec = raw
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .map((l) => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const errors = [];
const must = (ok, msg) => { if (!ok) errors.push(msg); };

// 1. The badge-only short-circuit must not come back in any form.
must(
  !/if\s*\(\s*headerBadge\s*===\s*0\s*\)/.test(spec),
  'the badge-only short-circuit is back (`if (headerBadge === 0)`) — an unwaited 0 must never end the step',
);
must(
  !/crumb\(\s*'SUMMARY',\s*'OK',\s*`badge-empty/.test(spec),
  "a `SUMMARY OK badge-empty` crumb is back — the step must not report OK on a badge read alone",
);

// 2. The badge must be recorded as a HINT (a distinct non-OK result), never as a verdict. The repo's own
//    lesson: print a distinct SKIP, never PASS, for something that asserted nothing.
must(/crumb\(\s*'BADGE-HINT',\s*'SKIP'/.test(spec), "the BADGE-HINT crumb must be logged with result 'SKIP', not 'OK'");

// 3. cartResidual must not trust a bare badge value as a count. The pre-fix line was
//    `if (badge !== null) return badge;` — a `0` from that is the whole defect.
must(
  !/if\s*\(\s*badge\s*!==\s*null\s*\)\s*return\s+badge\s*;/.test(spec),
  'cartResidual trusts any non-null badge again — a 0 badge must not be returned as a count',
);
must(
  /if\s*\(\s*badge\s*!==\s*null\s*&&\s*badge\s*>\s*0\s*\)\s*return\s+badge\s*;/.test(spec),
  'cartResidual must only trust a badge that is > 0 (over-reporting is safe; under-reporting is not)',
);

// 4. Emptiness must be proven by DOM children, not by "the row selector matched nothing" — otherwise a
//    row-class rename turns a full cart into an empty one (a fail-open swapped for a worse fail-open).
must(
  /children\.length/.test(spec),
  'cartResidual must prove emptiness via the list container\'s children.length, not a row-selector miss',
);

// 5. The row selector must exclude the `cart-item-list` container ("cart-item-list" contains "cart-item")
//    and must not use `li[class*="item"]` (Tailwind `tw:items-center` contains "item").
const residual = spec.slice(spec.indexOf('async function cartResidual'));
const residualBody = residual.slice(0, residual.indexOf('\n}') + 2);
must(
  !/li\[class\*="item"/.test(residualBody),
  'cartResidual uses li[class*="item"] again — that matches any nav <li> with Tailwind tw:items-center',
);
must(
  /:not\(\[class\*="cart-item-list"/.test(residualBody),
  'cartResidual\'s row selector must exclude [class*="cart-item-list"] — the container is not a row',
);

// 6. The UNKNOWN contract: -1 must still be reachable and documented as never-empty.
must(/return\s+-1\s*;/.test(residualBody), 'cartResidual must still return -1 for UNKNOWN');

if (errors.length) {
  console.error(`clear-cart gate FAILED (${errors.length}) in ${REL}:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nSee scripts/redtest-baseline-clear-cart.mjs for the behavioural proof.');
  process.exit(1);
}
console.log(`clear-cart gate OK: baseline-clear-cart cannot report empty without proof (${REL}).`);
