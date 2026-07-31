// RED-TEST for the cart-body read: prove the SKU ledger survives the FULL multi-navigation flow.
//
// WHY THIS EXISTS. #120 installed one page-level listener for the whole run, kicked off `resp.json()`
// fire-and-forget, and awaited the promises later in verify-cart-4. This flow navigates on every add
// (search → PDP) and again into /cart, and a Playwright response body stops being readable once the page
// moves on — so every parse rejected, serverCartSkus stayed null, and GATE 2 fired on the live fleet
// (runs 11:50 and 12:25, 2026-07-30). The fix reads the body INSIDE the add step, awaiting it before the
// loop can navigate again.
//
// WHAT THIS PROVES, in a real browser across 4 adds each with search→PDP navigation, then /cart:
//   1. the ledger is POPULATED — serverCartSkus is non-null and equals exactly the 4 added SKUs;
//   2. the expectation is derived from the PDP urls, not hardcoded;
//   3. 3-of-4 present still FAILS, naming the missing SKU — so the fix did not merely stop GATE 2 firing
//      by making the value always-present-but-wrong;
//   4. the body is read while the page is still on the PDP (the invariant), checked by asserting the
//      capture completes BEFORE the next navigation.
//
// ★ ON THE RACE ITSELF: whether a deferred read rejects is timing-dependent (it hinges on a CDP body
//   fetch losing to a navigation), so this test does NOT stage a synthetic race — a flaky red-test is
//   worse than none. The structural invariant is instead pinned STATICALLY by
//   scripts/check-cart-identity-gate.mjs, and the real-world proof is the fleet confirmation recorded in
//   the PR (check 355 green with a CART-IDENTITY line).
//
// ★ MIRRORS the spec's logic VERBATIM (idiom: the other redtest-*.mjs). The runner compiles specs with
//   exactly ONE import form, so this cannot import from the spec; the mirror guard below pins the copies.
//
// Run: node scripts/redtest-cart-body-read.mjs   (or: npm run redtest:cart-body)
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

// ---- mirrored verbatim from the spec ----------------------------------------------------------------
function isCartWrite(method, url, status) {
  if (method === 'GET' || method === 'HEAD') return false;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
  return onWegmansApi && /\/(cart|basket|cart-items|line-?items|order|add)/i.test(url) && status < 500;
}
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
/** The spec's GATE-4 set math. */
function identityVerdict(expectedAdds, serverSkus) {
  const expected = [...new Set(expectedAdds.map((a) => a.sku))];
  const actual = [...new Set(serverSkus)];
  const missing = expected.filter((s) => !actual.includes(s));
  const extra = actual.filter((s) => !expected.includes(s));
  return { expected, actual, missing, extra, pass: !missing.length && !extra.length && actual.length === expected.length };
}
// ---- end mirror ------------------------------------------------------------------------------------

const ITEMS = [
  { item: 'milk', sku: '55066', name: 'Wegmans-1-Low-Fat-Milk' },
  { item: 'eggs', sku: '46155', name: 'Eggs-Large' },
  { item: 'bread', sku: '60715', name: 'Italian-Bread' },
  { item: 'bananas', sku: '92685', name: 'Bananas-Sold-by' },
];
const LINEITEMS_URL = 'https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/lineitems?api-version=2024-02-19-preview';

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// ── 0. MIRROR-DRIFT GUARD ───────────────────────────────────────────────────────────────────────────
const RAW = readFileSync(new URL('../monitors/wegmans/full-shop-flow.spec.ts', import.meta.url), 'utf8');
const CODE = RAW.split('\n')
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .map((l) => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');
check(/const withCartBodyCapture = async/.test(CODE), 'the spec defines withCartBodyCapture');
check(/withCartBodyCapture\(\(\) => addToCartLadder/.test(CODE), 'the add step runs the ladder INSIDE the capture wrapper');
check(!/pendingCartBodies/.test(CODE), 'the flow-scoped deferred promise array is GONE');
check(!/Promise\.allSettled\(pendingCartBodies\)/.test(CODE), 'nothing awaits cart bodies at verify time');

// The listener must live inside the wrapper, not at flow scope.
const wrapper = CODE.slice(CODE.indexOf('const withCartBodyCapture'));
const wrapperBody = wrapper.slice(0, wrapper.indexOf('\n    };') + 1);
check(/page\.on\('response', onCartBody\)/.test(wrapperBody), "page.on('response') is inside the wrapper");
check(/page\.off\('response', onCartBody\)/.test(wrapperBody), 'and detached in the wrapper (finally)');
check(/await Promise\.allSettled\(parses\)/.test(wrapperBody), 'the parses are awaited INSIDE the wrapper');

// ── the fixture: a search page, 4 PDPs, a cart page, and a cumulative lineitems API ─────────────────
const cartState = []; // server-side truth, grows per add
const cartBody = () => JSON.stringify({
  StoreKey: '84-MCKINLEY',
  cartData: [{ cartID: 'c-1', cartVersion: cartState.length, lineItems: cartState.map((s) => ({ sku: s, quantity: 1 })) }],
});

const searchPage = (item) => {
  const hit = ITEMS.find((i) => i.item === item);
  return `<!doctype html><html><body><h1>results for ${item}</h1>
    <a href="/shop/product/${hit.sku}-${hit.name}">${hit.name}</a></body></html>`;
};
const pdpPage = (sku) => `<!doctype html><html><body>
  <h1>product ${sku}</h1>
  <button id="atc">Add to Cart</button>
  <script>
    document.getElementById('atc').addEventListener('click', async () => {
      // A real add: a POST whose response body IS the whole cart.
      await fetch(${JSON.stringify(LINEITEMS_URL)}, { method: 'POST', body: JSON.stringify({ sku: '${sku}' }) });
      document.getElementById('atc').textContent = 'In Cart';
    });
  </script></body></html>`;
const cartPage = `<!doctype html><html><body>
  <ul class="MuiList-root component--cart-item-list">
    ${ITEMS.map((i) => `<li class="component--cart-item">${i.name}</li>`).join('')}
  </ul></body></html>`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Desktop Chrome'] })).newPage();

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.href.startsWith(LINEITEMS_URL.split('?')[0])) {
    const sku = JSON.parse(route.request().postData() || '{}').sku;
    if (sku && !cartState.includes(sku)) cartState.push(sku);
    return route.fulfill({ status: 200, contentType: 'application/json', body: cartBody() });
  }
  if (u.pathname === '/shop/search') return route.fulfill({ status: 200, contentType: 'text/html', body: searchPage(u.searchParams.get('query')) });
  if (u.pathname.startsWith('/shop/product/')) return route.fulfill({ status: 200, contentType: 'text/html', body: pdpPage(skuFromProductUrl(u.pathname)) });
  if (u.pathname === '/cart') return route.fulfill({ status: 200, contentType: 'text/html', body: cartPage });
  return route.fulfill({ status: 404, body: 'nf' });
});

// ── the spec's ledger + wrapper, mirrored ───────────────────────────────────────────────────────────
const expectedAdds = [];
let serverCartSkus = null;
let cartWriteSeen = false;
let cartSeq = 0;
let bestSeq = -1;
let urlAtCapture = null; // proves the read finished before the next navigation

const withCartBodyCapture = async (run) => {
  const parses = [];
  const onCartBody = (resp) => {
    try {
      if (!isCartWrite(resp.request().method(), resp.url(), resp.status())) return;
      cartWriteSeen = true;
      const seq = cartSeq++;
      parses.push(
        resp.json().then((b) => {
          const skus = cartSkusFromBody(b);
          if (skus && seq > bestSeq) { bestSeq = seq; serverCartSkus = skus; }
        }).catch(() => {}),
      );
    } catch { /* never break the flow */ }
  };
  page.on('response', onCartBody);
  try {
    await run();
    await Promise.allSettled(parses);
    urlAtCapture = page.url(); // still the PDP — no navigation has happened yet
  } finally {
    page.off('response', onCartBody);
  }
};

// ── 1. drive the FULL multi-navigation flow: 4 × (search → PDP → add), then /cart ───────────────────
for (const { item } of ITEMS) {
  await page.goto(`https://www.wegmans.com/shop/search?query=${item}`, { waitUntil: 'domcontentloaded' });
  await page.locator('a[href*="/shop/product/"]').first().click();
  await page.waitForURL(/\/shop\/product\//);
  expectedAdds.push({ item, sku: skuFromProductUrl(page.url()) });
  await withCartBodyCapture(async () => {
    await page.locator('#atc').click();
    await page.locator('#atc').filter({ hasText: 'In Cart' }).waitFor({ state: 'visible', timeout: 5000 });
  });
  check(/\/shop\/product\//.test(urlAtCapture), `[${item}] body read completed while still on the PDP`, urlAtCapture.replace('https://www.wegmans.com', ''));
}
await page.goto('https://www.wegmans.com/cart', { waitUntil: 'domcontentloaded' });

// ── 2. the assertions the live red was about ────────────────────────────────────────────────────────
check(cartWriteSeen === true, 'a cart write was observed');
check(serverCartSkus !== null, '★★ THE FIX: serverCartSkus is NON-NULL after 4 navigating adds + /cart', `=${JSON.stringify(serverCartSkus)}`);
check(
  serverCartSkus !== null && serverCartSkus.join(',') === ITEMS.map((i) => i.sku).join(','),
  '★★ THE FIX: it equals exactly the 4 added SKUs',
  `${JSON.stringify(serverCartSkus)}`,
);
check(
  expectedAdds.every((a) => a.sku) && expectedAdds.map((a) => a.sku).join(',') === ITEMS.map((i) => i.sku).join(','),
  'the EXPECTATION came from the PDP urls (nothing hardcoded)',
  expectedAdds.map((a) => `${a.item}=${a.sku}`).join(' '),
);

const verdict = identityVerdict(expectedAdds, serverCartSkus ?? []);
check(verdict.pass === true, '★ the identity assertion PASSES on a correct cart', `missing=[${verdict.missing}] extra=[${verdict.extra}]`);

// ── 3. MUST-GO-RED: the fix must not have made the value always-present-but-wrong ───────────────────
const threeOf4 = identityVerdict(expectedAdds, ITEMS.slice(0, 3).map((i) => i.sku));
check(
  threeOf4.pass === false && threeOf4.missing.join(',') === '92685',
  '★★ MUST-GO-RED: 3 of 4 present still FAILS, naming the missing SKU',
  `missing=[${threeOf4.missing}]`,
);
const wrongProduct = identityVerdict(expectedAdds, ['55066', '46155', '60715', '92928']);
check(
  wrongProduct.pass === false && wrongProduct.missing.join(',') === '92685' && wrongProduct.extra.join(',') === '92928',
  '★ right COUNT, wrong PRODUCT still FAILS (a count could not catch this)',
);

await browser.close();
console.log('');
if (failures.length) {
  console.error(`RED-TEST FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('RED-TEST PASSED — the cart body is read where it arrives, and the ledger survives every navigation.');
