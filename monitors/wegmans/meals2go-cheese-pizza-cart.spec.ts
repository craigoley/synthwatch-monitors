import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: meals2go-cheese-pizza-cart
 *
 * Journey: meals2go.com → establish CARRY OUT fulfillment (Buffalo, NY → McKinley store) →
 * takeout menu → Pizza → a CHEESE pizza → add to cart → VERIFY via the cart-items API.
 * The guest cart is EPHEMERAL (fresh guest per run), so no self-clean is needed.
 *
 * ★ MUST-GO-RED ANCHOR (step e): the add-to-cart is verified over the NETWORK, not the UI. This
 * Angular SPA renders no reliable cart badge/toast, so the add fires POST .../cart-items and we
 * assert the response is 200 with a NON-EMPTY cartItems (total quantity ≥ 1). It goes RED on no
 * request / 4xx / 200-but-empty — it cannot pass on always-present chrome (the false positive the
 * old DOM/header-icon checks gave). A 60s response window covers the cloud handler deferring the
 * POST behind upstream calls (a shorter window once false-negatived a successful add, trace 849441).
 *
 * ★ EPHEMERAL GUEST CART — NO SELF-CLEAN NEEDED (verified 2026-07-01). Each run is a fresh browser
 * context → a freshly-minted guest-idp token → a fresh, EMPTY guest cart. Verified: a NEW guest
 * token is minted per context, and repeated add runs showed NO cross-run accumulation (a different
 * cartId each run, each cart holding only its own added item). The added pizza is discarded when the
 * context closes; nothing persists to clean. The earlier finally did a cart-items/<id> DELETE that
 * ALWAYS 404'd (the real remove endpoint uses a different, un-reverse-engineered shape) — but since
 * nothing accumulates, no cleanup is required. If the runner ever persists guest sessions, a WORKING
 * removal must be added then (reverse-engineer the real DELETE from the site's own remove call).
 *
 * sensitive=false (reclassified 2026-06-30): anonymous/accountless — no login, payment, or PII; the
 * guest session token is short-lived and protects nothing.
 *
 * Selectors are VERIFIED against live traces (this flow is green in prod). Ground-truth kept inline:
 * the fulfillment modal (#fulfillment-confirmation-confirm-button-carryout), the two-stage store
 * select (Google address autocomplete → app-wegmans-store list, filtered via input#store-search-
 * input), the thin-crust sub-cuisine tab (button#cuisine-thin-crust-pizza — rendered twice, so
 * filter to visible), and the add button (button.cart-button inside app-pop-open-pane).
 */
test('Meals2Go: cheese pizza carry-out cart (Buffalo/McKinley)', async ({ page }) => {
  try {
    // ---- STEP a: landing renders --------------------------------------------------
    await step('open meals2go.com landing', async () => {
      await page.goto('https://www.meals2go.com', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);

      // CAPABILITY: the "Start an Order" CTA OR the header store switcher (a returning session may
      // skip the landing and drop straight onto the menu with its switcher in the header).
      const startOrder = page.locator('button#landing-page-start-order-button');
      const storeSwitcher = page
        .locator('#main-header-fulfillment-info, button.change-store-button')
        .or(page.getByRole('button', { name: /menu for /i }));
      await expect(
        startOrder.or(storeSwitcher).first(),
        'STEP a: neither the "Start an Order" CTA nor the header store switcher rendered.',
      ).toBeVisible({ timeout: 20000 });
    });

    // ---- STEP b: Carryout -> Buffalo address -> McKinley store ---------------------
    // dismissInterstitials is SCOPED to skip flow-driven modals (lib/flow.ts
    // FLOW_MODAL_EXCLUDE_SELECTOR), so it won't close this fulfillment/store modal.
    await step('GATE-B: Carryout -> pick address -> select McKinley store', async () => {
      await dismissInterstitials(page);

      // Open the fulfillment modal via the landing CTA.
      const startOrder = page.locator('button#landing-page-start-order-button').first();
      try {
        if (await startOrder.isVisible({ timeout: 8000 })) await startOrder.click({ timeout: 5000 });
      } catch {
        /* a returning session may already be past the landing */
      }
      await dismissInterstitials(page);

      const fulfillmentModal = page
        .locator('[role="dialog"].weg-modal-outer')
        .or(page.locator('app-fulfillment-type-change'))
        .or(page.getByText(/how do you want to get your order/i))
        .first();
      await expect(
        fulfillmentModal,
        'GATE-B: fulfillment modal did not open after "Start an Order".',
      ).toBeVisible({ timeout: 20000 });

      // Choose CARRYOUT.
      const carryout = page
        .locator('#fulfillment-confirmation-confirm-button-carryout')
        .or(page.getByRole('button', { name: 'Carryout' }))
        .first();
      await expect(carryout, 'GATE-B: Carryout button not visible in the modal.').toBeVisible({ timeout: 15000 });
      await carryout.click({ timeout: 5000 });

      // STAGE 1 — the carryout screen is a GOOGLE ADDRESS autocomplete (not a store list). Type the
      // locality, wait for the result rows to render, then pick the "Buffalo, NY" row.
      const searchInput = page.getByRole('textbox').or(page.getByPlaceholder(/zip|city|store|search|address/i)).first();
      await expect(searchInput, 'GATE-B: carryout address search input did not appear.').toBeVisible({ timeout: 15000 });
      await searchInput.click({ timeout: 4000 });
      await searchInput.fill('Buffalo');
      // deterministic: the address autocomplete rows rendered (replaces a blind settle).
      await page.locator('button.google-result').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

      const buffaloFiltered = page.locator('button.google-result').filter({ hasText: /buffalo,?\s*ny/i }).first();
      const firstResult = page
        .locator('button.google-result')
        .first()
        .or(page.locator('[role="listitem"] button, [role="option"]').first());
      const buffaloAddress = (await buffaloFiltered.count().catch(() => 0)) > 0 ? buffaloFiltered : firstResult;
      await expect(buffaloAddress, 'GATE-B: no "Buffalo, NY" address row to pick.').toBeVisible({ timeout: 15000 });
      await buffaloAddress.click({ timeout: 5000 });

      // STAGE 2 — picking the address advances to store selection: the autocomplete panel hides and
      // the store selector appears (deterministic boundaries replace two blind settles).
      await page
        .locator('app-google-search-results, .google-results-container')
        .first()
        .waitFor({ state: 'hidden', timeout: 12000 })
        .catch(() => {});
      await page
        .locator('input#store-search-input, app-store-selector')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => {});

      // The store list is VIRTUALIZED (~56 of 113, distance-sorted; McKinley ~7.9mi down), so filter
      // via input#store-search-input, then click the store ROW (button.wegmans-store-container — NOT
      // the title span). The subsequent toBeVisible is the deterministic wait on the filtered list.
      const storeFilter = page
        .locator('input#store-search-input')
        .or(page.locator('app-store-selector input[type="text"], app-store-selector input'))
        .first();
      try {
        if (await storeFilter.isVisible({ timeout: 8000 })) {
          await storeFilter.click({ timeout: 4000 });
          await storeFilter.fill('Mckinley');
        }
      } catch {
        /* if the filter input shape changed, the row match below still tries */
      }

      const mckinleyStore = page
        .locator('app-wegmans-store:has(span.store-title:text-is("Mckinley")) button.wegmans-store-container')
        .or(page.locator('app-wegmans-store').filter({ hasText: /mckinley/i }).locator('button.wegmans-store-container'))
        .first();
      await expect(
        mckinleyStore,
        'GATE-B: McKinley store row (button.wegmans-store-container) not found after filtering.',
      ).toBeVisible({ timeout: 15000 });
      await mckinleyStore.click({ timeout: 5000 });

      // Selecting the store closes the modal onto the menu (deterministic boundary).
      await page.locator('app-store-selector').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await dismissInterstitials(page);

      // CAPABILITY: a store context is established — the header switcher shows "Menu for <store>"
      // (prefer McKinley) and/or the store modal closed onto the menu.
      const storeContextSignal = page
        .locator('#main-header-fulfillment-info, button.change-store-button')
        .filter({ hasText: /mckinley/i })
        .or(page.getByRole('button', { name: /menu for /i }))
        .or(page.locator('#main-header-fulfillment-info, button.change-store-button'))
        .first();
      await expect(
        storeContextSignal,
        'GATE-B: store not selected — no "Menu for <store>" header after clicking McKinley.',
      ).toBeVisible({ timeout: 20000 });
    });

    // ---- STEP c: takeout menu -> Pizza category -----------------------------------
    await step('navigate takeout menu -> Pizza', async () => {
      await dismissInterstitials(page);

      const menu = page
        .getByRole('link', { name: /menu|order|shop|food/i })
        .or(page.getByRole('button', { name: /menu|order|shop|food/i }))
        .first();
      try {
        if (await menu.isVisible({ timeout: 8000 })) await menu.click({ timeout: 5000 });
      } catch {
        /* best-effort — a returning session may already be on the menu */
      }
      await dismissInterstitials(page);

      // Click the Pizza category (role unknown — accept tab/link/button).
      const pizzaCategory = page
        .getByRole('tab', { name: /pizza/i })
        .or(page.getByRole('link', { name: /pizza/i }))
        .or(page.getByRole('button', { name: /pizza/i }))
        .first();
      await expect(pizzaCategory, 'STEP c: Pizza category not found.').toBeVisible({ timeout: 20000 });
      await pizzaCategory.click({ timeout: 5000 });
      await dismissInterstitials(page);

      // CAPABILITY: a Pizza listing rendered (resilient to menu reorder / seasonal SKUs).
      await expect(page.getByText(/pizza/i).first(), 'STEP c: Pizza listing did not render.').toBeVisible({ timeout: 20000 });
    });

    // ---- STEP d: open a CHEESE pizza ----------------------------------------------
    await step('open a cheese pizza item', async () => {
      await dismissInterstitials(page);

      // Select the THIN CRUST PIZZA sub-cuisine tab FIRST (the orderable cheese pizza lives under it;
      // the default "Promo & Packages" tab has none). button#cuisine-thin-crust-pizza is rendered
      // twice (sticky + desktop) — filter to visible so we click the active copy, not a hidden one.
      const thinCrustTab = page
        .locator('button#cuisine-thin-crust-pizza')
        .or(page.getByRole('tab', { name: /thin crust pizza/i }))
        .or(page.getByRole('button', { name: /thin crust pizza/i }))
        .filter({ visible: true })
        .first();
      try {
        if (await thinCrustTab.isVisible({ timeout: 8000 })) await thinCrustTab.click({ timeout: 5000 });
      } catch {
        /* menu may be restructured — the cheese match below still tries */
      }
      await dismissInterstitials(page);

      // Match a CHEESE pizza, preferring a clickable product card (link → button → any clickable
      // cheese card) over a bare text node. .first() of the chosen kind (no hardcoded SKU).
      const cheeseLink = page.getByRole('link', { name: /cheese/i }).first();
      const cheeseButton = page.getByRole('button', { name: /cheese/i }).first();
      const cheeseCard = page
        .locator(
          'a:has-text("cheese"), button:has-text("cheese"), [data-testid*="product" i]:has-text("cheese"), [data-testid*="item" i]:has-text("cheese"), article:has-text("cheese"), li:has-text("cheese")',
        )
        .first();
      let cheesePizza = cheeseLink;
      if (!(await cheeseLink.count().catch(() => 0))) {
        cheesePizza = (await cheeseButton.count().catch(() => 0)) ? cheeseButton : cheeseCard;
      }
      await expect(
        cheesePizza,
        'STEP d: no clickable cheese pizza under the thin-crust listing.',
      ).toBeVisible({ timeout: 20000 });

      // The detail pane opens INSTANTLY (trace 849266); a click-settle retry is NOT a failure here,
      // so click without blocking on post-actionability and gate on the PANE appearing instead.
      await cheesePizza.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
      await dismissInterstitials(page);
      await expect(
        page.locator('app-pop-open-pane h1.item-name, app-pop-open-pane button.cart-button').first(),
        'STEP d: detail pane did not open after clicking the cheese item.',
      ).toBeVisible({ timeout: 20000 });
    });

    // ---- STEP e: add to cart -- VERIFIED VIA THE cart-items API (the must-go-red anchor) --
    await step('add cheese pizza to cart', async () => {
      await dismissInterstitials(page);

      // The add button is button.cart-button inside the detail pane ("Add to cart • $14.00", not
      // disabled; no required size/crust gate — dipping sauces are optional). Class-based; accessible-
      // name fallback (the name is split across spans, so the class is the reliable target).
      const addToCart = page
        .locator('app-pop-open-pane button.cart-button, button.cart-button')
        .or(page.getByRole('button', { name: /add to cart/i }))
        .first();
      await expect(addToCart, 'STEP e: add-to-cart button did not render in the detail pane.').toBeVisible({ timeout: 15000 });

      // Request-level flag: did the cart-items POST fire at all? Distinguishes a timing timeout
      // (add worked, response not caught in time — trace 849441) from a genuine no-op (no request).
      let cartPostRequestSeen = false;
      const onCartReq = (req: import('@playwright/test').Request) => {
        if (req.method() === 'POST' && /\/cart-items(\?|$)/.test(req.url())) cartPostRequestSeen = true;
      };
      page.on('request', onCartReq);

      // Arm the response wait BEFORE clicking (60s — the cloud handler defers the POST behind
      // upstream calls: cart context, commitment-times).
      const CART_WAIT_MS = 60_000;
      const addRespPromise = page
        .waitForResponse((r) => r.request().method() === 'POST' && /\/cart-items(\?|$)/.test(r.url()), { timeout: CART_WAIT_MS })
        .catch(() => null);

      // Click the add button; escalate past the sticky-footer actionability quirk if a normal click
      // is intercepted (force → DOM-level dispatch). The API response below is the success signal.
      try {
        await addToCart.scrollIntoViewIfNeeded({ timeout: 5000 });
        await addToCart.click({ timeout: 5000 });
      } catch {
        try {
          await addToCart.click({ force: true, timeout: 5000 });
        } catch {
          await addToCart.dispatchEvent('click').catch(() => {});
        }
      }

      // ★ THE MUST-GO-RED ANCHOR: the add mutation succeeded server-side. The cart-items POST must
      // return 200 with a NON-EMPTY cartItems (quantity ≥ 1). Fails on no request / 4xx / 200-but-
      // empty; cannot pass on always-present chrome. No navigation before this — we verify the SAME
      // cart the POST populated (navigating to / would reset to a fresh empty guest cart).
      const addResp = await addRespPromise;
      page.off('request', onCartReq);
      if (!addResp) {
        const secs = CART_WAIT_MS / 1000;
        throw new Error(
          cartPostRequestSeen
            ? `GATE-E: the cart-items POST fired but its response was not observed within ${secs}s — ` +
              `likely a monitor/timing issue (the add probably succeeded); raise CART_WAIT_MS.`
            : `GATE-E: no cart-items POST was attempted within ${secs}s — the add did not fire ` +
              `(dead handler / wrong target / API contract change).`,
        );
      }

      const status = addResp.status();
      type CartItem = { cartItemId?: string; quantity?: number };
      type CartBody = { cartId?: string; cartItems?: CartItem[] };
      let body: CartBody | null = null;
      try {
        body = (await addResp.json()) as CartBody;
      } catch {
        body = null;
      }
      expect(status, `GATE-E: cart-items responded HTTP ${status}, expected 200.`).toBe(200);

      const cartItems: CartItem[] = body && Array.isArray(body.cartItems) ? body.cartItems : [];
      expect(
        cartItems.length,
        'GATE-E: cart-items returned 200 but cartItems is EMPTY — the add no-opped server-side.',
      ).toBeGreaterThan(0);
      const totalQty = cartItems.reduce((s: number, it: CartItem) => s + (Number(it?.quantity) || 0), 0);
      expect(totalQty, 'GATE-E: cartItems present but total quantity < 1.').toBeGreaterThanOrEqual(1);
    });
  } finally {
    // No server-side self-clean: the guest cart is EPHEMERAL (see the header). Each run is a fresh
    // context → a fresh guest-idp token → a fresh, empty cart, discarded when the context closes;
    // nothing accumulates across runs (verified 2026-07-01). The earlier cart-items/<id> DELETE here
    // ALWAYS 404'd (wrong endpoint shape) yet nothing leaked — because there is nothing to clean.
    console.log('[cart] guest cart is ephemeral — no self-clean needed (fresh, empty cart each run).');
  }
});
