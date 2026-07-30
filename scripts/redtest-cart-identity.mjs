// RED-TEST for verify-cart-4's identity assertion: prove it fails on the RIGHT things, and that its
// messages state what was measured without naming an untested cause.
//
// WHY THIS EXISTS (2026-07-30 recon on check 355). verify-cart-4 was a NODE COUNT — `≥4` on a DOM row
// count, then `≤4` on `cartBadge ?? n`. It was identity-BLIND: it counted to 4 and never read an item, so
// a leftover could SATISFY the threshold and a boosted-merchandise hijack could pass with the wrong
// product in the cart. And the number was wrong anyway — the cart genuinely held the 4 correct SKUs while
// the assertion read 5. Its failure text then blamed "baseline clear-cart did not empty leftover items",
// a cause it never tested, which misdirected the whole diagnosis toward cart accumulation.
//
// WHAT THIS PROVES:
//   1. the observed cart API shape parses to the observed SKUs (cartSkusFromBody);
//   2. a PDP slug yields the SKU, so the expectation is never hardcoded (skuFromProductUrl);
//   3. 3-of-4 SKUs present → FAIL naming the missing SKU;
//   4. a leftover SKU → FAIL naming it (what a threshold could satisfy by coincidence);
//   5. all 4 present → PASS;
//   6. the WRONG product at the right count → FAIL (the false green the old count allowed);
//   7. an UNMOUNTED /cart app → fails the RENDER gate, never a contents claim (real Chromium);
//   8. the failure messages name no untested cause.
//
// ★ MIRRORS the spec's pure logic VERBATIM (idiom: redtest-baseline-clear-cart / redtest-cart-count-selectors).
//   The runner compiles specs with exactly ONE import form (`../../lib/flow` → shim), so this script cannot
//   import from the spec; the MIRROR-DRIFT GUARD asserts the copies are still in step.
//   Source: monitors/wegmans/full-shop-flow.spec.ts — cartSkusFromBody / skuFromProductUrl /
//   CART_LIST_SEL / CART_ROW_SEL / CART_EMPTY_RX.
//
// Run: node scripts/redtest-cart-identity.mjs   (or: npm run redtest:cart-identity)
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

// ---- mirrored verbatim from the spec ----------------------------------------------------------------
const CART_LIST_SEL = '[class*="cart-item-list" i], [data-testid*="cart-item-list" i]';
const CART_ROW_SEL = '.component--cart-item, [data-testid="cart-item"]';
const CART_EMPTY_RX = /your cart is empty|cart is empty|no items in your cart|start shopping|cart is currently empty/i;

function cartSkusFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  const cartData = body.cartData;
  if (!Array.isArray(cartData) || cartData.length === 0) return null;
  const lineItems = cartData[0]?.lineItems;
  if (!Array.isArray(lineItems)) return null;
  const skus = [];
  for (const it of lineItems) {
    const sku = it && typeof it === 'object' ? it.sku : undefined;
    if (typeof sku === 'string' && sku.length > 0) skus.push(sku);
    else if (typeof sku === 'number' && Number.isFinite(sku)) skus.push(String(sku));
  }
  return skus;
}
function skuFromProductUrl(url) {
  const m = /\/shop\/product\/(\d+)/.exec(url);
  return m ? m[1] : null;
}
/** The spec's GATE-4 set math, mirrored. Returns what the step would report. */
function identityVerdict(expectedAdds, serverSkus) {
  const expected = [...new Set(expectedAdds.map((a) => a.sku))];
  const actual = [...new Set(serverSkus)];
  const missing = expected.filter((s) => !actual.includes(s));
  const extra = actual.filter((s) => !expected.includes(s));
  return { expected, actual, missing, extra, pass: missing.length === 0 && extra.length === 0 && actual.length === expected.length };
}
// ---- end mirror ------------------------------------------------------------------------------------

// The OBSERVED cart API body: POST api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/lineitems
// returns the whole cart. Shape copied from run 1096363's captured response (recon 2026-07-30).
const OBSERVED_CART_BODY = {
  StoreKey: '84-MCKINLEY',
  customerID: '<redacted>',
  customerEmail: '<redacted>',
  cartData: [
    {
      cartID: '<guid>',
      cartVersion: 269,
      isAlcoholic: false,
      lineItems: [
        { sku: '55066', quantity: 1 },
        { sku: '46155', quantity: 1 },
        { sku: '60715', quantity: 1 },
        { sku: '92685', quantity: 1 },
      ],
    },
  ],
};
const ADDS = [
  { item: 'milk', sku: '55066' },
  { item: 'eggs', sku: '46155' },
  { item: 'bread', sku: '60715' },
  { item: 'bananas', sku: '92685' },
];

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// ── 0. MIRROR-DRIFT GUARD + the message contract (#118/#119 precedent) ──────────────────────────────
// Comments are stripped before scanning CODE, because the spec deliberately quotes the removed count
// assertions and the old misleading message in its own docs — a naive scan would fire on a correct file.
const RAW = readFileSync(new URL('../monitors/wegmans/full-shop-flow.spec.ts', import.meta.url), 'utf8');
const CODE = RAW.split('\n')
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .map((l) => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

check(RAW.includes(`const CART_ROW_SEL = '${CART_ROW_SEL}';`), 'mirror: CART_ROW_SEL matches the spec');
check(RAW.includes(`const CART_LIST_SEL = '${CART_LIST_SEL}';`), 'mirror: CART_LIST_SEL matches the spec');
check(RAW.includes(`const CART_EMPTY_RX = ${CART_EMPTY_RX};`), 'mirror: CART_EMPTY_RX matches the spec');
check(/function cartSkusFromBody/.test(CODE), 'the spec defines cartSkusFromBody');
check(/function skuFromProductUrl/.test(CODE), 'the spec defines skuFromProductUrl');

// The node-count pair must be GONE from code.
check(!/toBeLessThanOrEqual\(4\)/.test(CODE), 'the ≤4 node-count assertion is gone from the spec code');
check(!/cartBadge \?\? n/.test(CODE), 'the `cartBadge ?? n` count fallback is gone from the spec code');

// ★ ITEM 3: the message must not name a cause it never tested.
const BANNED = ['did not empty leftover items', 'clearing failed', 'they accumulated'];
for (const phrase of BANNED) {
  check(!CODE.includes(phrase), `the failure text no longer claims "${phrase}"`);
}
check(/MEASURED/.test(CODE), 'the failure text states what was MEASURED');
check(/the \/cart app did not render/.test(CODE), 'an unmounted cart app fails with the RENDER condition');

// ★ No hardcoded SKU list — the expectation must come from the run.
const V4 = CODE.slice(CODE.indexOf("runStep(page, 'verify-cart-4'"));
const v4Body = V4.slice(0, V4.indexOf('\n    });') + 1);
check(
  !/\b(55066|46155|60715|92685)\b/.test(v4Body),
  'verify-cart-4 hardcodes no SKUs (the expectation comes from what the run added)',
);

// ── 1-2. the pure helpers, against the OBSERVED shapes ──────────────────────────────────────────────
const parsed = cartSkusFromBody(OBSERVED_CART_BODY);
check(
  parsed !== null && parsed.join(',') === '55066,46155,60715,92685',
  'cartSkusFromBody parses the OBSERVED cart body to the observed SKUs',
  `got=[${parsed}]`,
);
check(cartSkusFromBody({ nope: 1 }) === null, 'cartSkusFromBody returns null for a non-cart body (≠ empty cart)');
check(cartSkusFromBody({ cartData: [{ lineItems: [] }] })?.length === 0, 'an EMPTY cart parses to [] (not null)');
check(
  skuFromProductUrl('https://www.wegmans.com/shop/product/92685-Bananas-Sold-by') === '92685',
  'skuFromProductUrl reads the SKU from a PDP slug',
);
check(skuFromProductUrl('https://www.wegmans.com/shop/search?query=milk') === null, 'a non-PDP url yields null');

// ── 3-6. the identity verdict, scenario by scenario ─────────────────────────────────────────────────
const all4 = identityVerdict(ADDS, ['55066', '46155', '60715', '92685']);
check(all4.pass, '★ all 4 added SKUs present → PASS', `server=[${all4.actual}]`);

const threeOf4 = identityVerdict(ADDS, ['55066', '46155', '92685']);
check(
  !threeOf4.pass && threeOf4.missing.join(',') === '60715',
  '★ 3 of 4 present → FAIL, naming the MISSING sku',
  `missing=[${threeOf4.missing}]`,
);

const leftover = identityVerdict(ADDS, ['55066', '46155', '60715', '92685', '11111']);
check(
  !leftover.pass && leftover.extra.join(',') === '11111',
  '★ a leftover SKU → FAIL, naming it (a threshold could satisfy this by coincidence)',
  `extra=[${leftover.extra}]`,
);

// ★ THE FALSE GREEN THE OLD COUNT ALLOWED: right COUNT, wrong PRODUCT (the boosted-merchandise hijack).
const wrongProduct = identityVerdict(ADDS, ['55066', '46155', '60715', '92928']); // 92928 = Sweet Cherries
check(
  !wrongProduct.pass && wrongProduct.missing.join(',') === '92685' && wrongProduct.extra.join(',') === '92928',
  '★ MUST-GO-RED vs the old count: 4 items but the WRONG product → FAIL (old ≥4/≤4 would have PASSED)',
  `missing=[${wrongProduct.missing}] extra=[${wrongProduct.extra}]`,
);
check(
  wrongProduct.actual.length === 4 && wrongProduct.expected.length === 4,
  '   …and the counts are EQUAL in that case, which is exactly why a count could not catch it',
);

// ── 7. the RENDER gate, in real Chromium ────────────────────────────────────────────────────────────
const MOUNTED = `<!doctype html><html><body>
  <nav><ul><li class="list-element tw:flex tw:items-center">Stores</li></ul></nav>
  <a href="/cart" aria-label="View 4 selected items in my Cart">Cart</a>
  <ul class="MuiList-root component--cart-item-list">
    <li class="MuiListItem-root component--cart-item">Milk</li>
    <li class="MuiListItem-root component--cart-item">Eggs</li>
  </ul></body></html>`;
// The 2026-07-30 shell: chrome only, cartPresent:false, one input, no list / rows / empty copy.
const SHELL = `<!doctype html><html><body>
  <nav><ul><li class="list-element tw:flex tw:items-center">Stores</li></ul></nav>
  <a href="/cart" aria-label="View my Cart">Cart</a>
  <input type="search" />
  <main><p>Something went wrong.</p></main></body></html>`;
const EMPTY = `<!doctype html><html><body>
  <a href="/cart" aria-label="View 0 selected items in my Cart">Cart</a>
  <h2>Your cart is empty</h2></body></html>`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Desktop Chrome'] })).newPage();
const isMounted = async (html) => {
  await page.setContent(html);
  const cartApp = page.locator(CART_LIST_SEL).or(page.locator(CART_ROW_SEL)).or(page.getByText(CART_EMPTY_RX)).filter({ visible: true });
  return cartApp.first().waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
};
check(await isMounted(MOUNTED), '★ a MOUNTED cart page passes the render gate');
check((await isMounted(SHELL)) === false, '★ an UNMOUNTED shell FAILS the render gate (→ the render message, not a count)');
check(await isMounted(EMPTY), 'a genuinely EMPTY cart is still MOUNTED (the render gate is not an emptiness check)');

await browser.close();
console.log('');
if (failures.length) {
  console.error(`RED-TEST FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('RED-TEST PASSED — verify-cart-4 asserts identity, gates on render, and names no untested cause.');
