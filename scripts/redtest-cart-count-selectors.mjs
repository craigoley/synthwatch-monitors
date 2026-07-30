// RED-TEST for the loose cart selectors: prove they can no longer produce a confidently-wrong count.
//
// WHY THIS EXISTS (2026-07-30 recon on check 355, 34 consecutive failures):
//   * `li[class*="item" i]` matched every nav <li> carrying the Tailwind class `tw:items-center`
//     ("items-center" contains "item"). `<li class="list-element tw:py-1 tw:md:py-0 tw:flex
//     tw:items-center">` appeared 288× in the failing trace, so nav chrome counted as cart rows.
//   * readCartCount tried four class-substring selectors FIRST and the aria-label LAST, so
//     `[class*="cart" i] [class*="count" i]` matched `cart-item-count` — a per-row QUANTITY STEPPER
//     inside `component--cart-item-list` — and returned it as the cart's count. The aria-label was
//     correct throughout the incident (0→1→2→3→4); the number the monitor asserted on was not.
//   * a 400ms innerText read of an unhydrated badge yielded a confident `0`, indistinguishable from a
//     real zero.
//
// WHAT THIS PROVES, in BOTH directions (each ★ check is re-run against the OLD logic below and must
// flip): nav-only page → 0 rows, never positive; pre-hydration → null, never 0; a correctly hydrated
// 4-item cart → 4 via the aria-label, with no regression.
//
// ★ MIRRORS the spec's predicates VERBATIM (idiom: redtest-baseline-clear-cart.mjs / redtest-catering.mjs).
//   The runner compiles specs with exactly ONE import form (`../../lib/flow` → shim), so this script
//   cannot import from the spec; the MIRROR-DRIFT GUARD below asserts the copies are still in step.
//   Source: monitors/wegmans/full-shop-flow.spec.ts — CART_ROW_SEL / CART_ARIA_COUNT_RX /
//   CART_BADGE_FALLBACK_SELECTORS / CART_CTL_TIMEOUT_MS / readCartCount.
//
// Run: node scripts/redtest-cart-count-selectors.mjs   (or: npm run redtest:cart-count)
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

// ---- mirrored verbatim from the spec ----------------------------------------------------------------
const CART_ROW_SEL = '.component--cart-item, [data-testid="cart-item"]';
const CART_ARIA_COUNT_RX = /(\d+)\s+(?:\w+\s+)?(?:items?|products?)/i;
const CART_CTL_TIMEOUT_MS = 2_000;
const CART_BADGE_FALLBACK_SELECTORS = [
  '[data-testid*="cart-count" i]:not([data-testid*="cart-item" i])',
  '[data-testid*="cart" i]:not([data-testid*="cart-item" i]) [class*="count" i]:not([class*="cart-item" i])',
  'a[href*="/cart" i] [class*="badge" i]:not([class*="cart-item" i]), a[href*="/cart" i] [class*="count" i]:not([class*="cart-item" i])',
  '[class*="cart" i]:not([class*="cart-item" i]) [class*="badge" i]:not([class*="cart-item" i]), [class*="cart" i]:not([class*="cart-item" i]) [class*="count" i]:not([class*="cart-item" i])',
];

async function readCartCount(page) {
  const cartCtl = page.getByRole('link', { name: /cart/i }).or(page.getByRole('button', { name: /cart/i })).first();
  await cartCtl.waitFor({ state: 'attached', timeout: CART_CTL_TIMEOUT_MS }).catch(() => {});
  const al = await cartCtl.getAttribute('aria-label').catch(() => null);
  const primary = al ? CART_ARIA_COUNT_RX.exec(al) : null;
  if (primary) return parseInt(primary[1], 10);
  for (const sel of CART_BADGE_FALLBACK_SELECTORS) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count().catch(() => 0)) {
      const t = (await loc.innerText({ timeout: 400 }).catch(() => '')).trim();
      const m = /\d+/.exec(t);
      if (m) {
        const v = parseInt(m[0], 10);
        return v > 0 ? v : null;
      }
    }
  }
  return null;
}
// ---- end mirror ------------------------------------------------------------------------------------

// ---- the OLD (pre-fix) logic, kept ONLY so every ★ check can be shown to flip -----------------------
const OLD_ROW_SEL = '[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]';
const OLD_BADGE_SELECTORS = [
  '[data-testid*="cart-count" i]',
  '[data-testid*="cart" i] [class*="count" i]',
  'a[href*="/cart" i] [class*="badge" i], a[href*="/cart" i] [class*="count" i]',
  '[class*="cart" i] [class*="badge" i], [class*="cart" i] [class*="count" i]',
];
async function readCartCountOLD(page) {
  for (const sel of OLD_BADGE_SELECTORS) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count().catch(() => 0)) {
      const t = (await loc.innerText({ timeout: 400 }).catch(() => '')).trim();
      const m = /\d+/.exec(t);
      if (m) return parseInt(m[0], 10); // no 0→null rule, no scoping
    }
  }
  const cartCtl = page.getByRole('link', { name: /cart/i }).or(page.getByRole('button', { name: /cart/i })).first();
  const al = await cartCtl.getAttribute('aria-label').catch(() => null);
  if (al) {
    const m = CART_ARIA_COUNT_RX.exec(al);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ---- fixtures --------------------------------------------------------------------------------------
const NAV = `<nav><ul>
  <li class="list-element tw:py-1 tw:md:py-0 tw:flex tw:items-center">Stores</li>
  <li class="list-element tw:py-1 tw:md:py-0 tw:flex tw:items-center">Pharmacy</li>
  <li class="list-element tw:py-1 tw:md:py-0 tw:flex tw:items-center">Recipes</li>
  <li class="list-element tw:py-1 tw:md:py-0 tw:flex tw:items-center">Deals</li>
  <li class="list-element tw:py-1 tw:md:py-0 tw:flex tw:items-center">Lists</li>
</ul></nav>`;

// A cart row as the real DOM renders it: the row token plus the sibling controls whose class names all
// contain the substring "cart-item" — the per-row quantity stepper is the one that hijacked the badge.
const ROW = (name, qty) => `
  <li class="MuiListItem-root MuiListItem-gutters component--cart-item tw:flex tw:flex-col">
    <div class="cart-item-content-wrapper">${name}</div>
    <div class="component--cart-item-quantity-selector">
      <span class="cart-item-count">${qty}</span>
    </div>
  </li>`;

// NAV ONLY — zero cart rows anywhere on the page.
const F_NAV_ONLY = `<!doctype html><html><body>${NAV}
  <a href="/cart" aria-label="View my Cart">Cart</a>
  <h1>Store: McKinley Parkway</h1></body></html>`;

// PRE-HYDRATION — the semantic control carries NO number yet, while a header badge element already
// renders the literal text "0". This is the shape that produced a confident zero.
const F_PRE_HYDRATION = `<!doctype html><html><body>${NAV}
  <a href="/cart" aria-label="View my Cart">Cart <span class="cart-badge">0</span></a>
  <h1>Store: McKinley Parkway</h1></body></html>`;

// HYDRATED 4-ITEM CART — the count lives ONLY in the aria-label, with NO separate header badge digit.
// That is the shape the 2026-07-30 recon actually observed on /cart: the trace contained no rendered
// "N items" text and no header badge number, so the only correct signal was the aria-label, and the
// number the old code returned came from `cart-item-count`. The per-row steppers read 9 here so that any
// read picking up a stepper instead of the cart's own count is unmistakable in the output.
const F_CART_4 = `<!doctype html><html><body>${NAV}
  <a href="/cart" aria-label="View 4 selected items in my Cart">Cart</a>
  <ul class="MuiList-root component--cart-item-list">
    ${ROW('Wegmans 1% Low Fat Milk', 9)}
    ${ROW('Eggs, Large', 9)}
    ${ROW('Italian Bread', 9)}
    ${ROW('Bananas', 9)}
  </ul></body></html>`;

const bodies = {
  '/nav-only': F_NAV_ONLY,
  '/pre-hydration': F_PRE_HYDRATION,
  '/cart-4': F_CART_4,
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Desktop Chrome'] })).newPage();
await page.route('**/*', async (route) => {
  const p = new URL(route.request().url()).pathname;
  const body = bodies[p];
  if (body === undefined) return route.fulfill({ status: 404, body: 'not found' });
  return route.fulfill({ status: 200, contentType: 'text/html', body });
});

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const rows = (sel) => page.locator(sel).filter({ visible: true }).count();

// ── 0. MIRROR-DRIFT GUARD (#118 precedent) ──────────────────────────────────────────────────────────
// An un-checked mirror rots into a test of nothing. Assert the load-bearing literals still match, and
// that the defects this test targets are really gone from the spec's CODE (comments stripped, because
// the spec deliberately QUOTES the removed selectors in its docs — a naive scan would fire on a correct
// file, the false red #118 hit and fixed the same way).
const RAW = readFileSync(new URL('../monitors/wegmans/full-shop-flow.spec.ts', import.meta.url), 'utf8');
const CODE = RAW.split('\n')
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .map((l) => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');
check(RAW.includes(`const CART_ROW_SEL = '${CART_ROW_SEL}';`), 'mirror: CART_ROW_SEL matches the spec');
check(RAW.includes(`const CART_ARIA_COUNT_RX = ${CART_ARIA_COUNT_RX};`), 'mirror: CART_ARIA_COUNT_RX matches the spec');
check(
  CART_BADGE_FALLBACK_SELECTORS.every((s) => RAW.includes(s)),
  'mirror: all 4 last-resort badge selectors match the spec',
);
check(!/li\[class\*="item"/.test(CODE), 'the spec CODE no longer uses li[class*="item"] anywhere');
check(/v > 0 \? v : null/.test(CODE), 'the spec returns null (not 0) for a last-resort zero');

// ── 1. NAV-ONLY: zero cart rows must never read as a positive count ─────────────────────────────────
await page.goto('http://fixture.local/nav-only', { waitUntil: 'domcontentloaded' });
const navOld = await rows(OLD_ROW_SEL);
const navNew = await rows(CART_ROW_SEL);
check(navOld > 0, '★ MUST-GO-RED: the OLD row selector counts nav <li>[tw:items-center] as cart rows', `old=${navOld}`);
check(navNew === 0, '★ THE FIX: the scoped row selector reads 0 rows on a nav-only page', `new=${navNew}`);

// ── 2. PRE-HYDRATION: must yield null, not 0 ────────────────────────────────────────────────────────
await page.goto('http://fixture.local/pre-hydration', { waitUntil: 'domcontentloaded' });
const preOld = await readCartCountOLD(page);
const preNew = await readCartCount(page);
check(preOld === 0, '★ MUST-GO-RED: the OLD read returns a confident 0 pre-hydration', `old=${preOld}`);
check(preNew === null, '★ THE FIX: a pre-hydration read returns null, not 0', `new=${String(preNew)}`);
check(preNew !== 0, 'NEW: null is distinguishable from a real zero', `new=${String(preNew)}`);

// ── 3. HYDRATED 4-ITEM CART: still reads 4 via the aria-label (no regression) ───────────────────────
await page.goto('http://fixture.local/cart-4', { waitUntil: 'domcontentloaded' });
const cartOld = await readCartCountOLD(page);
const cartNew = await readCartCount(page);
const rowsOld = await rows(OLD_ROW_SEL);
const rowsNew = await rows(CART_ROW_SEL);
check(
  cartOld === 9,
  '★ MUST-GO-RED: the OLD read returns the per-row QUANTITY STEPPER (9), not the cart count',
  `old=${cartOld}`,
);
check(cartNew === 4, '★ THE FIX: the aria-label is primary — reads 4', `new=${cartNew}`);
check(rowsOld > 4, '★ MUST-GO-RED: the OLD row selector over-counts a 4-item cart', `old=${rowsOld} (rows+list+wrappers+steppers+nav)`);
check(rowsNew === 4, '★ THE FIX: the scoped row selector counts exactly 4 rows', `new=${rowsNew}`);

// ── 4. a real zero still reports 0 (the primary signal is allowed to say empty) ──────────────────────
await page.setContent(`<!doctype html><html><body>${NAV}
  <a href="/cart" aria-label="View 0 selected items in my Cart">Cart</a></body></html>`);
const realZero = await readCartCount(page);
check(realZero === 0, 'NEW: a real 0 from the PRIMARY signal is still reported as 0, not null', `=${realZero}`);

await browser.close();
console.log('');
if (failures.length) {
  console.error(`RED-TEST FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('RED-TEST PASSED — loose selectors can no longer produce a confidently-wrong cart count.');
