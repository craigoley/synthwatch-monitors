import { test, expect, step, dismissInterstitials, credential, type Page } from '../../lib/flow';

/**
 * Monitor: wegmans-full-shop-flow — ★ FULL AUTHENTICATED PICKUP SHOPPING FLOW (SENSITIVE; ships DISABLED)
 *
 * Journey: login → search+add milk/eggs/bread/bananas → verify 4 in cart → checkout as PICKUP → confirm
 * pickup TIMESLOTS render + are selectable → SELECT a slot → return to cart → clear cart → logout.
 * Destined to be SCHEDULED (interval 900s, eastus2 + centralus). Built to that bar: deterministic,
 * clean teardown, hard run-cap, no production footprint. Ships enabledByDefault:false for on-demand
 * validation first.
 *
 * ★★ SELECTOR-VERIFICATION STATUS (read before trusting a red run) ★★
 * REUSED + already-live-verified (proven in shipped specs — cited inline):
 *   • login: the B2C form ids (#signInName/#password/#next) + the myaccount.wegmans.com bypass-header
 *     scoped route + LOGGED_IN_AFFORDANCE_RX — from b2c-login-test.spec.ts (#52/#60).
 *   • search + first result: /shop/search?query=… + a[href*="/shop/product/"] — from search-product.spec.ts.
 *   • redaction/diag: safeLoc/safeLabel/isVisibleSafe/collectLabels + the survival-fixed emit — from
 *     b2c-login-test.spec.ts (#57/#59).
 * NET-NEW + ★ NOT YET LIVE-VERIFIED (authored resilient/structural; the wegmans.com AUTHENTICATED cart/
 * checkout/pickup/timeslot/clear-cart DOM could not be driven from the authoring session — no test creds
 * + Akamai bot-block from a non-allowlisted IP): add-to-cart, verify-cart-4, checkout-pickup,
 * timeslots-render, select-slot, return-cart, clear-cart, logout. Each is wrapped so a failing step emits
 * a STRUCTURAL diag (STEP-FAIL … DIAG) capturing the real DOM → Craig's FIRST sandbox fire verifies and
 * corrects each selector from the diag (the b2c ship-disabled-then-fix-from-diag pattern). ★ DO NOT
 * SCHEDULE until every net-new step is proven green + clean-teardown across several on-demand fires.
 *
 * ★★ CONCURRENCY (option 3 — offset cron per region; Craig's decision) ★★
 * One SHARED test account, mutated cart. Protection is TWO-PART:
 *   (a) OFFSET CRON (dashboard-owned config Craig sets in SynthWatch, NOT here): eastus2 at :00/:30,
 *       centralus at :15/:45 → the two regions never touch the account at the same time.
 *   (b) HARD IN-SPEC RUN-CAP (RUN_CAP_MS below): a run aborts to teardown well before the next tick of
 *       EITHER region, so a slow run can NEVER structurally bleed into the next same-region tick and
 *       collide on the shared account. This is the guard offset-cron alone does not provide.
 * (Regions/cron are dashboard-owned per the reconcile field-split — set them in SynthWatch, not the
 * manifest. Interval 900s + enabledByDefault:false are declared in manifest.json.)
 *
 * ★★ TIMESLOT SAFETY (Craig-confirmed) ★★ Selecting a pickup slot does NOT hold capacity until
 * ORDER PLACEMENT. So select-slot is safe to run scheduled. ★ This monitor NEVER places the order:
 * it clicks a slot to prove selectability, then returns to cart and clears it. No "Place order" /
 * "Submit order" control is ever clicked (see the guard in select-slot).
 *
 * ★ TEARDOWN IN finally: clear-cart + logout run even on mid-flow failure — a scheduled monitor must
 * never leave a full cart / live session for the next run (a dirty run poisons its own next run).
 *
 * sensitive=true: real login. redact_patterns (manifest) + the built-in denylist scrub Bearer/JWT/
 * B2C-session values; all diag is safeLoc(url host/path) + safeLabel(PII-filtered) + booleans — never
 * creds/DOM/token.
 */

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const SHOPPING_ITEMS = ['milk', 'eggs', 'bread', 'bananas'] as const;
const B2C_HOST = 'myaccount.wegmans.com';
const BYPASS_HEADER = 'x-vercel-protection-bypass';
/** Hard wall-clock cap: abort to teardown before this. Kept well under the runner's per-run budget AND
 *  the 15-min tick so a run can't bleed into the next tick (concurrency axis b). */
const RUN_CAP_MS = 200_000;
const STEP_TIMEOUT = 20_000;
const LOGGED_IN_AFFORDANCE_RX = /account|profile|orders|my wegmans|rewards|sign ?out|log ?out|hello|welcome/i;

// ── Redaction-safe helpers (inlined; a spec cannot import another spec — lib/* won't resolve at runtime) ──
/** host + pathname only — drops query/fragment where tokens live. Safe to log. */
function safeLoc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable-url)';
  }
}
const SAFE_LABEL_ALLOWLIST = new Set([
  'account', 'my account', 'your account', 'my wegmans', 'rewards', 'sign out', 'log out', 'logout',
  'sign in', 'log in', 'orders', 'my orders', 'profile', 'cart', 'view cart', 'checkout', 'shop', 'help',
  'home', 'menu', 'search', 'store', 'stores', 'pickup', 'delivery', 'add to cart', 'remove', 'reserve',
]);
/** Redact a control label: greetings (account-name PII the runner redactor won't scrub) → ‹greeting›;
 *  known nav labels pass; anything else → ‹control›. Structural signal only. */
function safeLabel(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n || n.length > 40) return n ? '‹control›' : '';
  if (/^(hi|hello|hey|welcome|greetings|good (morning|afternoon|evening))\b/i.test(n)) return '‹greeting›';
  return SAFE_LABEL_ALLOWLIST.has(n.toLowerCase()) ? n : '‹control›';
}
type Loc = ReturnType<Page['locator']>;
async function isVisibleSafe(loc: Loc): Promise<boolean> {
  try {
    return await loc.first().isVisible({ timeout: 1000 });
  } catch {
    return false;
  }
}
async function countSafe(loc: Loc): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return -1;
  }
}
async function collectLabels(loc: Loc, scanCap: number, out: string[]): Promise<void> {
  const n = Math.min(await loc.count().catch(() => 0), scanCap);
  for (let i = 0; i < n && out.length < 10; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const label = safeLabel(await el.innerText({ timeout: 200 }).catch(() => ''));
    if (label && !out.includes(label)) out.push(label);
  }
}
const loggedInAffordance = (page: Page) =>
  page.getByRole('link', { name: LOGGED_IN_AFFORDANCE_RX }).or(page.getByRole('button', { name: LOGGED_IN_AFFORDANCE_RX }));

/**
 * ★ STRUCTURAL, REDACTION-SAFE step-failure diagnostic (reuses the b2c OTHER-DIAG design + its
 * survival fix). Everything is structure / URL host+path / PII-filtered labels — NO page.content(),
 * no input values, no creds/token. Returns {full (for Node stdout), compact (≤195, for the persisted
 * channels: page-console.warn → trace_signals.console, and the thrown error → error_message)}.
 */
async function captureStepDiag(page: Page, stepName: string): Promise<{ full: string; compact: string }> {
  const b = (v: boolean) => (v ? '1' : '0');
  const loggedIn = await isVisibleSafe(loggedInAffordance(page));
  const signInFormPresent = await isVisibleSafe(page.locator('#signInName, #password'));
  const cartPresent = await isVisibleSafe(page.locator('[class*="cart" i], [data-testid*="cart" i]').first());
  const checkoutPresent = await isVisibleSafe(
    page.getByRole('button', { name: /checkout|proceed/i }).or(page.locator('[class*="checkout" i]')),
  );
  const fulfillmentModalPresent = await isVisibleSafe(
    page.getByText(/pickup|delivery|how (do|would) you|choose (a|your) store|shopping mode/i),
  );
  const timeslotPresent = await isVisibleSafe(
    page.locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]').or(page.getByText(/pick up (between|at)|reserve (a )?time|available times?/i)),
  );
  const itemUnavailable = await isVisibleSafe(page.getByText(/unavailable|out of stock|not available|sold out/i));
  const counts = {
    links: await countSafe(page.getByRole('link')),
    buttons: await countSafe(page.getByRole('button')),
    inputs: await countSafe(page.locator('input')),
  };
  const visibleControls: string[] = [];
  await collectLabels(page.getByRole('button'), 16, visibleControls).catch(() => {});
  await collectLabels(page.getByRole('link'), 12, visibleControls).catch(() => {});

  const full = JSON.stringify({
    step: stepName,
    finalUrl: safeLoc(page.url()),
    found: { loggedIn, signInFormPresent, cartPresent, checkoutPresent, fulfillmentModalPresent, timeslotPresent, itemUnavailable, counts, visibleControls },
  });
  const flags = `li${b(loggedIn)}sgn${b(signInFormPresent)}cart${b(cartPresent)}chk${b(checkoutPresent)}ful${b(fulfillmentModalPresent)}slot${b(timeslotPresent)}oos${b(itemUnavailable)}`;
  const ctrls = visibleControls.slice(0, 3).join(',').slice(0, 40);
  const compact = `[full-shop-flow] STEP-FAIL ${stepName} url=${safeLoc(page.url()).slice(0, 50)} f=${flags} c=[${ctrls}]`.slice(0, 195);
  return { full, compact };
}

/** Wrap a labeled step so the runner funnel shows where it broke AND a failure emits the structural diag
 *  to the persisted channels (page-console → trace_signals.console; thrown error → error_message). */
async function runStep(page: Page, name: string, body: () => Promise<void>): Promise<void> {
  return step(name, async () => {
    try {
      await body();
    } catch (err) {
      const d = await captureStepDiag(page, name).catch(() => ({ full: '', compact: '' }));
      console.log(`[full-shop-flow] STEP-FAIL ${name} DIAG ${d.full}`); // Node stdout (deep-dive)
      if (d.compact) await page.evaluate((m) => console.warn(m), d.compact).catch(() => {}); // → trace_signals.console
      throw new Error(`${d.compact || `[full-shop-flow] step "${name}" failed`} :: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

test('Wegmans: full authenticated pickup shopping flow', async ({ page }) => {
  // Creds from credential() ONLY (model-B) — check 355's UI-set login_credentials, decrypted + published by
  // the runner as SW_CRED_<ROLE> (credential('username') → SW_CRED_USERNAME; env-mapping proven exact +
  // fail-closed in b2c #64). credential() throws on unset/empty → a broken cred path REDS loudly. No env
  // fallback: the shop-flow has no green baseline to protect (never passed), so fail-closed is exactly right.
  const username = credential('username');
  const password = credential('password');
  // ★ RESOLUTION SIGNAL (value-free): reaching this line means credential() resolved BOTH (else it threw) —
  // this is the shop-flow's FIRST-EVER cred resolution. Lands in the runner container logs. NEVER the value.
  console.log('[full-shop-flow] cred-source username=credential password=credential (model-B; credential()-only)');
  const bypassToken = process.env.VERCEL_BYPASS_TOKEN;
  const startedAt = Date.now();
  const abortIfOverCap = () => {
    if (Date.now() - startedAt > RUN_CAP_MS) {
      throw new Error(`[full-shop-flow] run-cap ${Math.round(RUN_CAP_MS / 1000)}s exceeded — aborting to teardown (concurrency guard).`);
    }
  };

  // Reuse b2c: the runner injects the bypass header for www.wegmans.com but NOT myaccount.wegmans.com
  // (PROTECTED_BYPASS_HOSTS omits it) — inject it host-scoped here so the login redirect carries it.
  let bypassAppliedToB2C = false;
  await page.route(`https://${B2C_HOST}/**`, async (route) => {
    const req = route.request();
    if (bypassToken) {
      bypassAppliedToB2C = true;
      await route.continue({ headers: { ...req.headers(), [BYPASS_HEADER]: bypassToken } });
    } else {
      await route.continue();
    }
  });

  try {
    // ---- STEP: login (REUSED selectors from b2c-login-test) ----------------------------------------
    await runStep(page, 'login', async () => {
      await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      const signIn = page
        .getByRole('link', { name: /sign ?in|log ?in/i })
        .or(page.getByRole('button', { name: /sign ?in|log ?in/i }))
        .filter({ visible: true })
        .first();
      if (await signIn.isVisible({ timeout: 8000 }).catch(() => false)) await signIn.click({ timeout: 5000 });
      await page.locator('#signInName').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await page.locator('#signInName').first().fill(username);
      await page.locator('#password').first().fill(password);
      await page.locator('#next, #continue').or(page.getByRole('button', { name: /sign ?in|log ?in|continue|next/i })).filter({ visible: true }).first().click({ timeout: 5000 });
      // Logged-in when the account affordance renders on wegmans.com (LOGGED_IN_AFFORDANCE_RX, #60).
      await expect(loggedInAffordance(page).first(), 'login: no logged-in account affordance after submit').toBeVisible({ timeout: STEP_TIMEOUT });
      if (!bypassAppliedToB2C && bypassToken) {
        // The B2C redirect never rode our route → the login likely used a cached session; not fatal.
        console.log('[full-shop-flow] note: bypass header route did not fire on B2C (cached session?).');
      }
    });

    // ---- STEP: select the McKinley store — GATES add-to-cart ---------------------------------------
    // Diagnosis (live add-milk STEP-FAIL: li1 cart0 ful1 + a "Stores" control): wegmans.com/shop gates the
    // Add-to-Cart affordance behind a SELECTED STORE. Establish McKinley once, before the add loop; store
    // context persists for the session.
    // ★ REUSE: the McKinley store-list/row selectors are lifted VERBATIM from meals2go-cheese-pizza-cart
    // .spec.ts (input#store-search-input filter → app-wegmans-store / button.wegmans-store-container row,
    // matched by the store NAME "Mckinley" — a stable anchor, not position). ★ CAVEAT: that is the
    // meals2go.com app; wegmans.com/shop is a DIFFERENT app that may render a different store-picker DOM
    // (the two may share the Wegmans store-picker component — unverified). So this is NET-NEW / UNVERIFIED
    // for the shop-flow, like the other net-new steps: a name-based role/text fallback backs the reused
    // selectors, and a failure emits the structural OTHER-DIAG (via runStep) so the first sandbox fire
    // reveals the real wegmans.com store-picker DOM and corrects it (runbook #63).
    abortIfOverCap();
    await runStep(page, 'select-store-mckinley', async () => {
      await page.goto('https://www.wegmans.com/shop/search?query=milk', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      // Best-effort: open the store/fulfillment picker if it isn't already showing (the add-milk diag saw
      // ful1, so it is often already present). Guarded — a no-op if the picker is already open.
      const openPicker = page
        .getByRole('button', { name: /choose (a|your) store|select (a )?store|set (your )?store|change store|find a store|store|pickup/i })
        .filter({ visible: true })
        .first();
      if (await isVisibleSafe(openPicker)) await openPicker.click({ timeout: 5000 }).catch(() => {});
      await dismissInterstitials(page);
      // REUSED (meals2go): filter the (virtualized) store list to McKinley via input#store-search-input,
      // with a resilient role fallback for the wegmans.com store-picker.
      const storeFilter = page
        .locator('input#store-search-input')
        .or(page.locator('app-store-selector input[type="text"], app-store-selector input'))
        .or(page.getByRole('textbox', { name: /store|search|zip|city/i }))
        .filter({ visible: true })
        .first();
      if (await isVisibleSafe(storeFilter)) {
        await storeFilter.click({ timeout: 4000 }).catch(() => {});
        await storeFilter.fill('Mckinley').catch(() => {});
      }
      // REUSED (meals2go): click the McKinley store ROW (button.wegmans-store-container — the row, not the
      // title span), matched by NAME; resilient name-based role/text fallback for the wegmans.com DOM.
      const mckinleyStore = page
        .locator('app-wegmans-store:has(span.store-title:text-is("Mckinley")) button.wegmans-store-container')
        .or(page.locator('app-wegmans-store').filter({ hasText: /mckinley/i }).locator('button.wegmans-store-container'))
        .or(page.getByRole('button', { name: /mckinley/i }))
        .filter({ visible: true })
        .first();
      await expect(
        mckinleyStore,
        'select-store-mckinley: McKinley store row not found — NET-NEW for wegmans.com/shop (store-picker DOM likely differs from the reused meals2go pattern); verify from the diag.',
      ).toBeVisible({ timeout: STEP_TIMEOUT });
      await mckinleyStore.click({ timeout: 5000 });
      await dismissInterstitials(page);
      // Confirm a McKinley store context is established (REUSED confirmation shape + resilient fallback).
      const storeSet = page
        .locator('#main-header-fulfillment-info, button.change-store-button')
        .filter({ hasText: /mckinley/i })
        .or(page.getByText(/mckinley/i))
        .first();
      await expect(
        storeSet,
        'select-store-mckinley: no McKinley store-context confirmation after selecting — verify from the diag.',
      ).toBeVisible({ timeout: STEP_TIMEOUT });
    });

    // ---- STEP(s): search + add each item (REUSED search selectors; NET-NEW add-to-cart) ------------
    for (const item of SHOPPING_ITEMS) {
      abortIfOverCap();
      await runStep(page, `add-${item}`, async () => {
        // REUSED: direct-URL search + first product card (search-product.spec.ts).
        await page.goto(`https://www.wegmans.com/shop/search?query=${encodeURIComponent(item)}`, { waitUntil: 'domcontentloaded' });
        await dismissInterstitials(page);
        const firstProduct = page.locator('a[href*="/shop/product/"]').filter({ visible: true }).first();
        await expect(firstProduct, `add-${item}: no product result (a[href*="/shop/product/"]) for "${item}"`).toBeVisible({ timeout: STEP_TIMEOUT });
        await firstProduct.click({ timeout: 5000 }).catch(() => {});
        await dismissInterstitials(page);

        // ★ NET-NEW / UNVERIFIED: the authenticated Add-to-Cart affordance (a pickup fulfillment must be
        // set; a store/fulfillment modal may intercept). Resilient: prefer a real "Add to Cart" button;
        // if a fulfillment modal blocks it, choose PICKUP and retry. First-fire diag corrects this.
        const addToCart = page
          .getByRole('button', { name: /add to cart/i })
          .or(page.locator('button[class*="add" i][class*="cart" i]'))
          .filter({ visible: true })
          .first();
        if (!(await isVisibleSafe(addToCart))) {
          const pickup = page.getByRole('button', { name: /pickup/i }).filter({ visible: true }).first();
          if (await isVisibleSafe(pickup)) await pickup.click({ timeout: 5000 }).catch(() => {});
          await dismissInterstitials(page);
        }
        // Skip gracefully if the item is genuinely unavailable (determinism: don't hard-depend on stock).
        const unavailable = page.getByText(/unavailable|out of stock|not available|sold out/i).first();
        if (await isVisibleSafe(unavailable)) {
          throw new Error(`add-${item}: first result is unavailable — widen the search or pick the next in-stock result (determinism gap to close on first fire).`);
        }
        await expect(addToCart, `add-${item}: Add to Cart affordance not found (NET-NEW selector — verify from diag)`).toBeVisible({ timeout: STEP_TIMEOUT });
        await addToCart.click({ timeout: 5000 });
      });
    }

    // ---- STEP: verify all 4 in cart (NET-NEW) ------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'verify-cart-4', async () => {
      await page.goto('https://www.wegmans.com/shop/cart', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      // ★ NET-NEW / UNVERIFIED: cart line-item count. PREFER a cart network anchor once the first-fire
      // diag reveals the cart API (mirror meals2go-cheese-pizza-cart's cart-items API assertion). For now,
      // a resilient DOM count of distinct line items.
      const lineItems = page.locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]').filter({ visible: true });
      await expect(lineItems.first(), 'verify-cart-4: no cart line items rendered (NET-NEW selector — verify from diag)').toBeVisible({ timeout: STEP_TIMEOUT });
      const n = await countSafe(lineItems);
      expect(n, `verify-cart-4: expected ≥4 cart line items, saw ${n} (some adds may have failed — read per-step diags)`).toBeGreaterThanOrEqual(4);
    });

    // ---- STEP: checkout as PICKUP (NET-NEW) --------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'checkout-pickup', async () => {
      await page.getByRole('button', { name: /checkout|proceed to checkout/i }).or(page.getByRole('link', { name: /checkout/i })).filter({ visible: true }).first().click({ timeout: 5000 });
      await dismissInterstitials(page);
      const pickup = page.getByRole('button', { name: /pickup/i }).or(page.getByRole('radio', { name: /pickup/i })).or(page.getByText(/pick ?up/i)).filter({ visible: true }).first();
      await expect(pickup, 'checkout-pickup: PICKUP fulfillment option not found (NET-NEW — verify from diag)').toBeVisible({ timeout: STEP_TIMEOUT });
      await pickup.click({ timeout: 5000 }).catch(() => {});
      await dismissInterstitials(page);
    });

    // ---- STEP: timeslots render + selectable (NET-NEW) --------------------------------------------
    abortIfOverCap();
    await runStep(page, 'timeslots-render', async () => {
      const slots = page.locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]').or(page.getByRole('button', { name: /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i })).filter({ visible: true });
      await expect(slots.first(), 'timeslots-render: no pickup timeslots rendered (NET-NEW — verify from diag)').toBeVisible({ timeout: STEP_TIMEOUT });
      const n = await countSafe(slots);
      expect(n, `timeslots-render: expected ≥1 selectable timeslot, saw ${n}`).toBeGreaterThanOrEqual(1);
    });

    // ---- STEP: select a slot (NET-NEW; SAFE per Craig — no hold until order placement; NEVER place order) --
    abortIfOverCap();
    await runStep(page, 'select-slot', async () => {
      const slot = page.locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]').or(page.getByRole('button', { name: /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i })).filter({ visible: true }).first();
      await slot.click({ timeout: 5000 });
      // ★ HARD SAFETY GUARD: this monitor NEVER places the order. Selecting a slot holds no capacity
      // (Craig-confirmed) — but we assert we are NOT on/allowed to click a place-order control, and we
      // never do. (The teardown below clears the cart, releasing any transient checkout state.)
      const placeOrder = page.getByRole('button', { name: /place (your )?order|submit order|pay now|complete (your )?order/i }).filter({ visible: true }).first();
      if (await isVisibleSafe(placeOrder)) {
        console.log('[full-shop-flow] note: a place-order control is present — NOT clicking it (never place the order).');
      }
    });

    // ---- STEP: return to cart (NET-NEW) -----------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'return-cart', async () => {
      await page.goto('https://www.wegmans.com/shop/cart', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      await expect(page.locator('[class*="cart" i], [data-testid*="cart" i]').first(), 'return-cart: cart did not render').toBeVisible({ timeout: STEP_TIMEOUT });
    });
  } finally {
    // ---- TEARDOWN (always runs — a dirty run poisons its own next run). Best-effort + guarded so it
    //      never throws; clear-cart THEN logout. No lock to release (option 3). --------------------------
    await clearCart(page).catch(() => {});
    await logout(page).catch(() => {});
  }
});

/** Teardown — clear every cart line item (NET-NEW / UNVERIFIED). Best-effort loop with a cap so it can
 *  never hang; tries per-item Remove, then a bulk "clear/empty cart" affordance. Verify from first-fire
 *  diag: a scheduled monitor MUST end with an empty cart. */
async function clearCart(page: Page): Promise<void> {
  await step('clear-cart (teardown)', async () => {
    await page.goto('https://www.wegmans.com/shop/cart', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await dismissInterstitials(page);
    for (let i = 0; i < 12; i++) {
      const remove = page.getByRole('button', { name: /^remove$|remove item|delete item/i }).filter({ visible: true }).first();
      if (!(await remove.isVisible({ timeout: 1500 }).catch(() => false))) break;
      await remove.click({ timeout: 4000 }).catch(() => {});
      await dismissInterstitials(page);
    }
    const bulkClear = page.getByRole('button', { name: /clear cart|empty cart|remove all/i }).filter({ visible: true }).first();
    if (await bulkClear.isVisible({ timeout: 1500 }).catch(() => false)) await bulkClear.click({ timeout: 4000 }).catch(() => {});
    // Assert empty so a red teardown is VISIBLE (a dirty cart must not pass silently).
    const remaining = page.locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]').filter({ visible: true });
    const left = await countSafe(remaining);
    if (left > 0) {
      const d = await captureStepDiag(page, 'clear-cart').catch(() => ({ full: '', compact: '' }));
      console.log(`[full-shop-flow] STEP-FAIL clear-cart DIAG ${d.full}`);
      if (d.compact) await page.evaluate((m) => console.warn(m), d.compact).catch(() => {});
      throw new Error(`${d.compact} :: clear-cart: ${left} item(s) remain — teardown incomplete (NET-NEW selector; fix from diag BEFORE scheduling).`);
    }
  });
}

/** Teardown — logout (REUSE loggedInAffordance to open the account menu, then Sign Out). Best-effort. */
async function logout(page: Page): Promise<void> {
  await step('logout (teardown)', async () => {
    const menu = loggedInAffordance(page).filter({ visible: true }).first();
    if (await menu.isVisible({ timeout: 2000 }).catch(() => false)) await menu.click({ timeout: 4000 }).catch(() => {});
    const signOut = page.getByRole('link', { name: /sign ?out|log ?out/i }).or(page.getByRole('button', { name: /sign ?out|log ?out/i })).or(page.getByRole('menuitem', { name: /sign ?out|log ?out/i })).filter({ visible: true }).first();
    if (await signOut.isVisible({ timeout: 3000 }).catch(() => false)) await signOut.click({ timeout: 4000 }).catch(() => {});
    // Confirm signed out: the sign-IN affordance returns (best-effort; a stuck session is flagged, not thrown).
    const signInBack = page.getByRole('link', { name: /sign ?in|log ?in/i }).or(page.getByRole('button', { name: /sign ?in|log ?in/i })).first();
    if (!(await signInBack.isVisible({ timeout: 4000 }).catch(() => false))) {
      console.log('[full-shop-flow] note: could not confirm logout (sign-in affordance not visible) — verify the logout selector from the first-fire diag.');
    }
  });
}
