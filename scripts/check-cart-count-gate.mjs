// CI gate: the cart-count selectors must not go loose again.
//
// The 2026-07-30 recon on check 355 (34 consecutive failures) traced a confidently-wrong count to three
// substring defects. These are STATIC, browser-free invariants so CI holds the line cheaply. The
// behavioural proof — real Chromium, fixtures reproducing each defect, every check re-run against the
// OLD logic so it is shown to flip — lives in `scripts/redtest-cart-count-selectors.mjs`.
//
// ★ Comments are stripped before matching (the #118 precedent). The spec deliberately QUOTES the removed
//   selectors in its own documentation, and a gate that read those quotes as the defect returning would
//   fire on a correct file — a false red that trains people to ignore the gate.
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

// 1. The Tailwind trap: `li[class*="item"]` matches any nav <li> with `tw:items-center`.
must(
  !/li\[class\*="item"/.test(code),
  'li[class*="item"] is back — it matches every nav <li> carrying Tailwind tw:items-center (288× in the failing trace)',
);

// 2. The row selector must be an EXACT class-token match, not a substring, so the -list / -count /
//    -content-wrapper / -quantity-selector siblings cannot be counted as rows.
must(
  /const CART_ROW_SEL = '\.component--cart-item(,|')/.test(code),
  'CART_ROW_SEL must lead with the exact class token `.component--cart-item` (not [class*="cart-item"])',
);
must(
  !/const CART_ROW_SEL = '\[class\*=/.test(code),
  'CART_ROW_SEL must not be a class-substring selector',
);

// 3. PRECEDENCE: readCartCount must consult the semantic aria-label BEFORE the class-substring shapes.
//    Positional, because that is exactly what regressed: the right answer existed and was reached last.
const fn = code.slice(code.indexOf('async function readCartCount'));
const body = fn.slice(0, fn.indexOf('\n}') + 2);
const iAria = body.indexOf('CART_ARIA_COUNT_RX');
const iFallback = body.indexOf('CART_BADGE_FALLBACK_SELECTORS');
must(iAria !== -1, 'readCartCount must read the aria-label via CART_ARIA_COUNT_RX');
must(iFallback !== -1, 'readCartCount must use CART_BADGE_FALLBACK_SELECTORS for the last resort');
must(
  iAria !== -1 && iFallback !== -1 && iAria < iFallback,
  'PRECEDENCE INVERTED BACK: the class-substring selectors are consulted before the aria-label',
);

// 4. NULL IS NOT ZERO: a zero from a last-resort selector must be reported as null (UNKNOWN).
must(
  /v > 0 \? v : null/.test(body),
  'a last-resort zero must return null, not 0 — an unhydrated element reading 0 is not an empty cart',
);
must(
  /Promise<number \| null>/.test(code),
  'readCartCount must keep its `number | null` return type so callers can tell UNKNOWN from a real 0',
);

// 5. The last-resort selectors must exclude per-row controls, or `[class*="cart"] [class*="count"]`
//    matches `cart-item-count` (the quantity stepper) inside `component--cart-item-list` again.
const fallbackBlock = code.slice(code.indexOf('CART_BADGE_FALLBACK_SELECTORS = ['));
const fallbackArr = fallbackBlock.slice(0, fallbackBlock.indexOf('];') + 2);
const arms = fallbackArr.split('\n').filter((l) => l.trim().startsWith("'"));
must(arms.length === 4, `expected 4 last-resort badge arms, found ${arms.length}`);
must(
  arms.every((a) => a.includes('cart-item')),
  'every last-resort badge arm must exclude cart-item* (the per-row quantity stepper hijacked the badge)',
);
must(
  arms.every((a) => /:not\(/.test(a)),
  'every last-resort badge arm must carry a :not(…) exclusion',
);

if (errors.length) {
  console.error(`cart-count gate FAILED (${errors.length}) in ${REL}:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nSee scripts/redtest-cart-count-selectors.mjs for the behavioural proof.');
  process.exit(1);
}
console.log(`cart-count gate OK: selectors are token-scoped, aria-label is primary, null !== 0 (${REL}).`);
