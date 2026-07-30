// RED-TEST for baseline-clear-cart's fail-open: prove that a PRE-HYDRATION header badge of `0` on a
// NON-EMPTY cart can no longer make the step report OK.
//
// WHY THIS EXISTS. Over the 7 days to 2026-07-30, baseline-clear-cart was 359 pass / 0 fail — it had
// NEVER failed. It short-circuited on `readCartCount(page) === 0` and returned `SUMMARY OK badge-empty`
// having navigated nothing, clicked nothing and verified nothing (966ms, vs the teardown's 52s). The
// badge is CLIENT-rendered from cart state fetched after paint, so an immediate read can return the
// initial `0` of a cart that is not empty. A step that cannot fail protects nothing.
//
// WHAT THIS PROVES, on one fixture that reproduces that exact shape:
//   1. the fixture really does reproduce the bug  — the OLD predicate reports OK on a 3-item cart;
//   2. the NEW logic does not                     — the badge is a hint, /cart is verified, count = 3;
//   3. the fix did not create the OPPOSITE false alarm — a genuinely EMPTY cart still reads 0, so the
//      verified already-empty fast exit still fires and a clean cart is not red-ed;
//   4. an UNKNOWN cart page reads -1, never 0     — a shell page is not mistaken for an empty cart;
//   5. the row selector no longer counts nav <li> carrying Tailwind `tw:items-center`.
//
// ★ MIRRORS the spec's predicates VERBATIM (same idiom as redtest-catering.mjs). The runner compiles
//   specs with exactly ONE import form (`../../lib/flow` → shim), so this script cannot import from the
//   spec; keep the two copies in step. Source: monitors/wegmans/full-shop-flow.spec.ts —
//   readCartCount / cartResidual / CART_LIST_SEL / CART_EMPTY_RX / CART_PROOF_TIMEOUT_MS.
//
// Run: node scripts/redtest-baseline-clear-cart.mjs
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

// ---- mirrored verbatim from the spec ----------------------------------------------------------------
const CART_LIST_SEL = '[class*="cart-item-list" i], [data-testid*="cart-item-list" i]';
const CART_EMPTY_RX = /your cart is empty|cart is empty|no items in your cart|start shopping|cart is currently empty/i;
const CART_PROOF_TIMEOUT_MS = 8_000;

async function countSafe(loc) {
  try { return await loc.count(); } catch { return -1; }
}
async function isVisibleSafe(loc) {
  return loc.isVisible({ timeout: 1000 }).catch(() => false);
}
async function readCartCount(page) {
  const badgeSelectors = [
    '[data-testid*="cart-count" i]',
    '[data-testid*="cart" i] [class*="count" i]',
    'a[href*="/cart" i] [class*="badge" i], a[href*="/cart" i] [class*="count" i]',
    '[class*="cart" i] [class*="badge" i], [class*="cart" i] [class*="count" i]',
  ];
  for (const sel of badgeSelectors) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count().catch(() => 0)) {
      const t = (await loc.innerText({ timeout: 400 }).catch(() => '')).trim();
      const m = t.match(/\d+/);
      if (m) return parseInt(m[0], 10);
    }
  }
  const cartCtl = page.getByRole('link', { name: /cart/i }).or(page.getByRole('button', { name: /cart/i })).first();
  const al = await cartCtl.getAttribute('aria-label').catch(() => null);
  if (al) {
    const m = al.match(/(\d+)\s+(?:\w+\s+)?(?:items?|products?)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
const ROW_SEL =
  '[class*="cart-item" i]:not([class*="cart-item-list" i]), [data-testid*="cart-item" i]:not([data-testid*="cart-item-list" i])';
async function cartResidual(page) {
  const badge = await readCartCount(page);
  if (badge !== null && badge > 0) return badge;
  const rows = page.locator(ROW_SEL).filter({ visible: true });
  const emptyCopy = page.getByText(CART_EMPTY_RX).filter({ visible: true });
  const list = page.locator(CART_LIST_SEL).filter({ visible: true });
  await emptyCopy.or(list).or(rows).first()
    .waitFor({ state: 'visible', timeout: CART_PROOF_TIMEOUT_MS }).catch(() => {});
  if (await isVisibleSafe(emptyCopy.first())) return 0;
  const rowCount = await countSafe(rows);
  if (rowCount > 0) return rowCount;
  const listChildren = await list.first().evaluate((el) => el.children.length).catch(() => null);
  if (listChildren === 0) return 0;
  return -1;
}
// ---- end mirror ------------------------------------------------------------------------------------

// A header whose badge renders `0` and only HYDRATES to `n` after `delayMs` — the pre-hydration read.
const header = (n, delayMs) => `
  <a href="/cart" aria-label="View 0 selected items in my Cart">
    Cart <span class="cart-badge">0</span>
  </a>
  <nav><ul>
    <li class="list-element tw:py-1 tw:flex tw:items-center">Stores</li>
    <li class="list-element tw:py-1 tw:flex tw:items-center">Pharmacy</li>
    <li class="list-element tw:py-1 tw:flex tw:items-center">Recipes</li>
    <li class="list-element tw:py-1 tw:flex tw:items-center">Deals</li>
    <li class="list-element tw:py-1 tw:flex tw:items-center">Lists</li>
  </ul></nav>
  <script>
    setTimeout(() => {
      document.querySelector('.cart-badge').textContent = '${n}';
      document.querySelector('a[href="/cart"]').setAttribute('aria-label', 'View ${n} selected items in my Cart');
    }, ${delayMs});
  </script>`;

const CART_FULL = `<!doctype html><html><body>${header(3, 1500)}
  <div class="component--cart-item-list">
    <div class="component--cart-item">Wegmans 1% Low Fat Milk</div>
    <div class="component--cart-item">Eggs, Large</div>
    <div class="component--cart-item">Italian Bread</div>
  </div></body></html>`;

const CART_EMPTY = `<!doctype html><html><body>${header(0, 1500)}
  <div class="component--cart-item-list"></div>
  <h2>Your cart is empty</h2></body></html>`;

// A SHELL: header chrome only. The cart app never mounted — no rows, no list, no empty copy.
const CART_SHELL = `<!doctype html><html><body>${header(3, 1500)}
  <main><p>Something went wrong.</p></main></body></html>`;

const PAGE_AFTER_STORE_SELECT = `<!doctype html><html><body>${header(3, 1500)}
  <h1>Store: McKinley Parkway</h1></body></html>`;

// The list mounted with 3 children whose row class we do NOT recognise (simulates a class rename).
const CART_RENAMED = `<!doctype html><html><body>${header(3, 1500)}
  <div class="component--cart-item-list">
    <div class="component--basket-line">Wegmans 1% Low Fat Milk</div>
    <div class="component--basket-line">Eggs, Large</div>
    <div class="component--basket-line">Italian Bread</div>
  </div></body></html>`;

const bodies = {
  '/': PAGE_AFTER_STORE_SELECT,
  '/cart': CART_FULL,
  '/cart-empty': CART_EMPTY,
  '/cart-shell': CART_SHELL,
  '/cart-renamed': CART_RENAMED,
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Desktop Chrome'] })).newPage();
await page.route('**/*', async (route) => {
  const path = new URL(route.request().url()).pathname;
  const body = bodies[path];
  if (body === undefined) return route.fulfill({ status: 404, body: 'not found' });
  return route.fulfill({ status: 200, contentType: 'text/html', body });
});

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// ── 0. MIRROR-DRIFT GUARD ───────────────────────────────────────────────────────────────────────────
// Mirroring is the repo's idiom for red-tests (the runner compiles specs with one import form, so this
// script cannot import from the spec) — but an un-checked mirror rots into a test of nothing. Assert the
// load-bearing literals still match the spec, and that the defect this test targets is really gone.
const SPEC = readFileSync(new URL('../monitors/wegmans/full-shop-flow.spec.ts', import.meta.url), 'utf8');
check(SPEC.includes(`const CART_LIST_SEL = '${CART_LIST_SEL}';`), 'mirror: CART_LIST_SEL matches the spec');
check(SPEC.includes(`const CART_EMPTY_RX = ${CART_EMPTY_RX};`), 'mirror: CART_EMPTY_RX matches the spec');
check(SPEC.includes(`const CART_PROOF_TIMEOUT_MS = ${CART_PROOF_TIMEOUT_MS.toLocaleString('en-US').replace(',', '_')};`), 'mirror: CART_PROOF_TIMEOUT_MS matches the spec');
check(
  ROW_SEL.split(', ').every((part) => SPEC.includes(part)),
  'mirror: the scoped ROW selector matches the spec',
);
check(!/if\s*\(\s*headerBadge\s*===\s*0\s*\)/.test(SPEC), 'the OLD badge short-circuit is GONE from the spec');
check(SPEC.includes('children.length'), 'the spec proves emptiness by children.length, not a selector miss');
check(/crumb\(\s*'BADGE-HINT'/.test(SPEC), 'the spec records the badge as a HINT (SKIP), never as SUMMARY OK');

// ── 1. the fixture reproduces the bug: the OLD predicate reports OK on a 3-item cart ────────────────
await page.goto('http://fixture.local/', { waitUntil: 'domcontentloaded' });
const preHydrationBadge = await readCartCount(page);
const oldWouldShortCircuit = preHydrationBadge === 0; // the OLD gate, verbatim: `if (headerBadge === 0) return;`
check(
  preHydrationBadge === 0,
  'fixture: the badge reads 0 PRE-hydration',
  `badge=${preHydrationBadge}`,
);
check(
  oldWouldShortCircuit === true,
  '★ MUST-GO-RED: the OLD gate reports SUMMARY OK on a NON-EMPTY cart (the fail-open)',
  'badge===0 short-circuits, asserting nothing',
);

// …and the badge really does hydrate to the true count, so `0` was genuinely premature.
await page.locator('.cart-badge').filter({ hasText: '3' }).first().waitFor({ state: 'visible', timeout: 5000 });
check((await readCartCount(page)) === 3, 'fixture: the badge hydrates to the true count (3)', 'so the 0 was premature');

// ── 2. the NEW logic: badge is a hint only; /cart is verified and reports the cart NON-empty ────────
await page.goto('http://fixture.local/', { waitUntil: 'domcontentloaded' });
const hint = await readCartCount(page); // recorded as BADGE-HINT, never a decision
await page.goto('http://fixture.local/cart', { waitUntil: 'domcontentloaded' });
const verified = await cartResidual(page);
check(hint === 0, 'NEW: the pre-hydration badge is still 0 (hint recorded)', `hint=${hint}`);
check(
  verified === 3,
  '★ THE FIX: the verified /cart read reports 3 — the step CANNOT report OK',
  `cartResidual=${verified}`,
);
check(verified !== 0, 'NEW: a non-empty cart is never reported as empty', `cartResidual=${verified}`);

// ── 3. no OPPOSITE false alarm: a genuinely empty cart still reads 0 (fast exit intact) ─────────────
await page.goto('http://fixture.local/cart-empty', { waitUntil: 'domcontentloaded' });
const emptyRead = await cartResidual(page);
check(emptyRead === 0, 'NEW: a genuinely EMPTY cart still reads 0 (already-empty fast exit intact)', `cartResidual=${emptyRead}`);

// ── 4. a SHELL cart page is UNKNOWN (-1), never 0 ───────────────────────────────────────────────────
await page.goto('http://fixture.local/cart-shell', { waitUntil: 'domcontentloaded' });
const shellRead = await cartResidual(page);
check(shellRead === -1, 'NEW: an unmounted SHELL cart page reads -1 UNKNOWN, never 0', `cartResidual=${shellRead}`);

// ── 5. the row selector ignores nav <li>[tw:items-center] AND the cart-item-LIST container ──────────
await page.goto('http://fixture.local/cart', { waitUntil: 'domcontentloaded' });
const looseRows = await countSafe(page.locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]').filter({ visible: true }));
const containerTrap = await countSafe(page.locator('[class*="cart-item" i]').filter({ visible: true }));
const scopedRows = await countSafe(page.locator(ROW_SEL).filter({ visible: true }));
check(
  looseRows > scopedRows,
  'the OLD loose row selector over-counts (nav li[tw:items-center] matched "item")',
  `loose=${looseRows} vs scoped=${scopedRows}`,
);
check(
  containerTrap === scopedRows + 1,
  'the substring trap one level up: "cart-item-list" contains "cart-item" (container counted as a row)',
  `unscoped=${containerTrap} vs scoped=${scopedRows}`,
);
check(scopedRows === 3, 'NEW: the scoped row selector counts exactly the 3 cart rows', `scoped=${scopedRows}`);

// ── 6. the fail-open PROOF 2 could have introduced: rows unrecognised must be UNKNOWN, not empty ────
// Rename the row class so the row selector matches NOTHING while the list still holds 3 children — i.e.
// simulate Wegmans renaming `component--cart-item`. Emptiness must NOT be inferred from a selector miss.
await page.goto('http://fixture.local/cart-renamed', { waitUntil: 'domcontentloaded' });
const renamedRead = await cartResidual(page);
check(
  renamedRead === -1,
  '★ NEW fail-open guarded: unrecognised rows read -1 UNKNOWN, NOT 0 (children.length, not a selector miss)',
  `cartResidual=${renamedRead}`,
);

await browser.close();
console.log('');
if (failures.length) {
  console.error(`RED-TEST FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('RED-TEST PASSED — the pre-hydration badge can no longer make baseline-clear-cart report OK.');
