// RED-TEST for the ABORTED-WRITE mechanism: the add's cart POST usually never completes, so its
// RESPONSE never arrives — yet the write must still be OBSERVED and the cart must still be READ.
//
// ★ WHY THIS EXISTS (mechanism established from the trace of run 1105330, 2026-07-31).
//   #121 fixed the body-read race it targeted, but GATE 2 then fired on the other branch: "no cart write
//   was observed". The natural hypothesis — the ladder returns on the UI transform before the write
//   lands, so the listener detaches early — is FALSIFIED by the timings:
//
//       lineitems POST at 13:26:27.657Z   ·   that add's ATC-RESULT logged at 13:26:28
//
//   The write fires ~1s BEFORE the ladder returns, with the listener attached. Timing was never it.
//
//   THE REAL MECHANISM: 3 of the 4 lineitems POSTs are recorded with status -1 — Playwright's marker for
//   a request that never completed. For those it fires `requestfailed`, NOT `response`, so a
//   page.on('response') listener CANNOT see them however long it waits. The 4th completed 200 with no
//   body. The write still reaches the server (badge 0->1->2->3->4; teardown clears 4 items).
//
//   So OBSERVING a write and READING the cart are different events needing different primitives:
//     * OBSERVE -> the `request` event (fires when issued, so an aborted write counts)
//     * READ    -> a response that actually completes: the cart page's own GET
//
// WHAT THIS PROVES, in a real browser, with the adds' POSTs deliberately ABORTED:
//   1. the response listener sees NOTHING (reproducing the live failure);
//   2. the request listener DOES observe every write  -> cartWriteSeen is true;
//   3. the cart GET on /cart yields the full SKU set  -> serverCartSkus is non-null and correct;
//   4. MUST-GO-RED: 3-of-4 still names the missing SKU; right-count/wrong-product still fails.
//
// ★ MIRRORS the spec verbatim (the runner compiles specs with one import form, so this cannot import
//   from the spec). The mirror-drift guard below pins the copies.
//
// Run: node scripts/redtest-cart-aborted-write.mjs   (or: npm run redtest:cart-aborted)
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
function isCartRead(method, url, status) {
  if (method !== 'GET') return false;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
  return onWegmansApi && /\/commerce\/cart\/carts/i.test(url) && status >= 200 && status < 300;
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
function identityVerdict(expectedAdds, serverSkus) {
  const expected = [...new Set(expectedAdds.map((a) => a.sku))];
  const actual = [...new Set(serverSkus)];
  const missing = expected.filter((s) => !actual.includes(s));
  const extra = actual.filter((s) => !expected.includes(s));
  return { expected, actual, missing, extra, pass: !missing.length && !extra.length && actual.length === expected.length };
}
// ---- end mirror ------------------------------------------------------------------------------------

const API = 'https://api.digitaldevelopment.wegmans.cloud';
const LINEITEMS = `${API}/commerce/cart/carts/lineitems`;
const CARTS_GET = `${API}/commerce/cart/carts/`;
const ITEMS = [
  { item: 'milk', sku: '55066' }, { item: 'eggs', sku: '46155' },
  { item: 'bread', sku: '60715' }, { item: 'bananas', sku: '92685' },
];

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// ── 0. MIRROR-DRIFT GUARD ───────────────────────────────────────────────────────────────────────────
const RAW = readFileSync(new URL('../monitors/wegmans/full-shop-flow.spec.ts', import.meta.url), 'utf8');
const CODE = RAW.split('\n')
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');
check(/function isCartRead\(/.test(CODE), 'the spec defines isCartRead (the completed-GET predicate)');
check(/page\.on\('request', onCartRequest\)/.test(CODE), "the spec OBSERVES writes via the 'request' event");
check(/page\.off\('request', onCartRequest\)/.test(CODE), 'and detaches that listener in the wrapper');
check(/waitForResponse\(\(r\) => isCartRead\(/.test(CODE), 'verify-cart-4 arms a wait for the cart READ');

// ── the fixture: adds whose POST is ABORTED; a cart GET that completes ──────────────────────────────
const cart = [];
const pdp = (sku) => `<!doctype html><html><body><h1>product ${sku}</h1>
  <button id="atc">Add to Cart</button>
  <script>
    document.getElementById('atc').addEventListener('click', () => {
      // Fire-and-forget, exactly like the real page: the request is ISSUED, the response never lands.
      fetch(${JSON.stringify(LINEITEMS)}, { method: 'POST', body: JSON.stringify({ sku: '${sku}' }) }).catch(() => {});
      document.getElementById('atc').textContent = 'In Cart';
    });
  </script></body></html>`;
const cartPage = `<!doctype html><html><body>
  <ul class="MuiList-root component--cart-item-list"><li class="component--cart-item">item</li></ul>
  <script>fetch(${JSON.stringify(CARTS_GET)}).catch(()=>{});</script></body></html>`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Desktop Chrome'] })).newPage();
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.href.startsWith(LINEITEMS)) {
    // ★ THE MECHANISM: record the write server-side, then ABORT — so Playwright fires requestfailed and
    //   NEVER a response, reproducing the live status -1.
    const sku = JSON.parse(route.request().postData() || '{}').sku;
    if (sku && !cart.includes(sku)) cart.push(sku);
    return route.abort('failed');
  }
  if (u.href.startsWith(CARTS_GET) && route.request().method() === 'GET') {
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ cartData: [{ cartID: 'c1', lineItems: cart.map((s) => ({ sku: s, quantity: 1 })) }] }) });
  }
  if (u.pathname.startsWith('/shop/product/')) {
    return route.fulfill({ status: 200, contentType: 'text/html', body: pdp(skuFromProductUrl(u.pathname)) });
  }
  if (u.pathname === '/cart') return route.fulfill({ status: 200, contentType: 'text/html', body: cartPage });
  return route.fulfill({ status: 404, body: 'nf' });
});

// ── the spec's ledger + wrapper, mirrored ───────────────────────────────────────────────────────────
const expectedAdds = [];
let serverCartSkus = null, cartWriteSeen = false, responseListenerSaw = 0, cartSeq = 0, bestSeq = -1;

const withCartBodyCapture = async (run) => {
  const parses = [];
  const onCartRequest = (req) => { try { if (isCartWrite(req.method(), req.url(), 200)) cartWriteSeen = true; } catch {} };
  const onCartBody = (resp) => {
    try {
      if (!isCartWrite(resp.request().method(), resp.url(), resp.status())) return;
      responseListenerSaw++; cartWriteSeen = true;
      const seq = cartSeq++;
      parses.push(resp.json().then((b) => {
        const skus = cartSkusFromBody(b);
        if (skus && seq > bestSeq) { bestSeq = seq; serverCartSkus = skus; }
      }).catch(() => {}));
    } catch {}
  };
  page.on('request', onCartRequest);
  page.on('response', onCartBody);
  try { await run(); await Promise.allSettled(parses); }
  finally { page.off('request', onCartRequest); page.off('response', onCartBody); }
};

// ── 1. drive the 4 adds, each with a navigation, each POST aborting ─────────────────────────────────
for (const { item } of ITEMS) {
  await page.goto(`https://www.wegmans.com/shop/product/${ITEMS.find((i) => i.item === item).sku}-x`, { waitUntil: 'domcontentloaded' });
  expectedAdds.push({ item, sku: skuFromProductUrl(page.url()) });
  await withCartBodyCapture(async () => {
    await page.locator('#atc').click();
    await page.locator('#atc').filter({ hasText: 'In Cart' }).waitFor({ state: 'visible', timeout: 5000 });
  });
}

check(responseListenerSaw === 0,
  '★ REPRODUCED: the RESPONSE listener saw NOTHING (aborted POSTs never fire `response`)',
  `responses seen=${responseListenerSaw}`);
check(cartWriteSeen === true,
  '★★ THE FIX (observe): the REQUEST listener DID observe the writes — cartWriteSeen is true');

// ── 2. the authoritative read: the cart page's own GET ──────────────────────────────────────────────
const cartRead = page.waitForResponse((r) => isCartRead(r.request().method(), r.url(), r.status()), { timeout: 15000 }).catch(() => null);
await page.goto('https://www.wegmans.com/cart', { waitUntil: 'domcontentloaded' });
const resp = await cartRead;
if (resp) { try { const s = cartSkusFromBody(await resp.json()); if (s) serverCartSkus = s; } catch {} }

check(resp !== null, '★★ THE FIX (read): the cart GET completed and was captured');
check(serverCartSkus !== null, '★★ serverCartSkus is NON-NULL across the full 4-add flow', `=${JSON.stringify(serverCartSkus)}`);
check(serverCartSkus !== null && serverCartSkus.join(',') === ITEMS.map((i) => i.sku).join(','),
  '★★ and equals exactly the 4 added SKUs', JSON.stringify(serverCartSkus));

const v = identityVerdict(expectedAdds, serverCartSkus ?? []);
check(v.pass === true, '★ the identity assertion PASSES on a correct cart', `missing=[${v.missing}] extra=[${v.extra}]`);

// ── 3. MUST-GO-RED: the fix must not make the value always-present-but-wrong ────────────────────────
const three = identityVerdict(expectedAdds, ITEMS.slice(0, 3).map((i) => i.sku));
check(three.pass === false && three.missing.join(',') === '92685',
  '★★ MUST-GO-RED: 3 of 4 present still FAILS, naming the missing SKU', `missing=[${three.missing}]`);
const wrong = identityVerdict(expectedAdds, ['55066', '46155', '60715', '92928']);
check(wrong.pass === false && wrong.missing.join(',') === '92685' && wrong.extra.join(',') === '92928',
  '★ right COUNT, wrong PRODUCT still FAILS (a count could not catch this)');

// ── 4. the READ predicate must reject an aborted/failed cart response ───────────────────────────────
check(isCartRead('GET', CARTS_GET, -1) === false, '★ isCartRead REJECTS an aborted (-1) cart GET — never parse a body that is not there');
check(isCartRead('GET', CARTS_GET, 500) === false, 'isCartRead rejects a 5xx cart GET');
check(isCartRead('POST', LINEITEMS, 200) === false, 'isCartRead rejects the WRITE endpoint (read and write stay distinct)');

await browser.close();
console.log('');
if (failures.length) { console.error(`RED-TEST FAILED (${failures.length}): ${failures.join('; ')}`); process.exit(1); }
console.log('RED-TEST PASSED — an aborted write is still OBSERVED, and the cart is READ from a response that completes.');
