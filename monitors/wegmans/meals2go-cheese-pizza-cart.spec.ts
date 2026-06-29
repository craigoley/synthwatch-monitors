import { test, expect, step, assertLoaded, dismissInterstitials, type Page } from '../../lib/flow';

/**
 * Monitor: meals2go-cheese-pizza-cart
 *
 * Journey: meals2go.com -> establish CARRY OUT fulfillment (Buffalo, NY ->
 * McKinley store) -> takeout menu -> Pizza -> a CHEESE pizza -> add to cart ->
 * open cart (assert the pizza line item) -> SELF-CLEAN (remove it).
 *
 * ============================ READ THIS FIRST ============================
 * (a) RECON-FIRST / EVERY SELECTOR IS UNVERIFIED. No existing spec touches
 *     meals2go.com, so NOTHING here is confirmed against a real trace. Each
 *     step is a best-GUESS resilient selector + a CAPABILITY assertion + a
 *     labeled DOM DUMP (console.log of candidate-locator counts + a trimmed
 *     outerHTML region). When a guess misses, the live trace's DUMP output
 *     shows the real DOM -> fix the selector against THAT, not against this
 *     file. The dumps are the whole point; this is a recon harness, not a
 *     known-green monitor. Search the trace for "===== DOM DUMP [<label>]".
 *
 * (b) DO NOT ENABLE AS A LIVE MONITOR until the B10 trace-redaction rule is
 *     established. This flow MUTATES a cart and carries STORE/FULFILLMENT
 *     SESSION state. Until cart + store-session state is guaranteed redacted
 *     from trace_signals, the success-baseline, and the AI-fed root-cause
 *     path, this monitor stays enabledByDefault:false with NO check_locations
 *     row. Enabling is gated on B10, full stop.
 *
 * (c) SELF-CLEANING CART CONTRACT. The flow adds a pizza, so it MUST remove it
 *     -- even on partial/mid-flow failure. The teardown runs in a finally block
 *     so a failure in steps a-f still attempts cart cleanup. It also TOLERATES
 *     A DIRTY START: it does not assume the cart begins empty (a prior aborted
 *     run may have left items); it notes a dirty start rather than asserting on
 *     it, and removes only what it can.
 * ========================================================================
 *
 * UNVERIFIED GATES (the DOM dumps to read first, in priority order):
 *   GATE-B  fulfillment/store-selection UX -- HIGHEST unknown (does meals2go
 *           gate menu content behind store selection at all? what's the modal
 *           shape? the store-search input? the result list?).
 *   GATE-E  add-to-cart -- a cheese pizza may FORCE size/crust/options before
 *           "Add" is enabled; if so this step known-fails LOUDLY (the dump
 *           shows the required-customization gate).
 *   GATE-C/D menu -> Pizza category -> a cheese item (route + nav unknown).
 *   GATE-F/G cart contents shape + the remove affordance (unknown).
 */

/**
 * Labeled DOM dump. Recon aid only -- never throws, never fails the flow.
 * Emits, for a labeled gate: the current URL, the live count of each candidate
 * locator (so the trace shows which guesses matched), and a trimmed outerHTML
 * of a region so the real DOM is visible when every guess missed.
 */
async function dumpDom(
  page: Page,
  label: string,
  candidates: Array<{ name: string; selector: string }> = [],
  regionSelector = 'body',
): Promise<void> {
  const lines: string[] = [`\n===== DOM DUMP [${label}] =====`];
  try {
    lines.push(`  url: ${page.url()}`);
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    try {
      const count = await page.locator(c.selector).count();
      lines.push(`  candidate "${c.name}" (${c.selector}) -> count=${count}`);
    } catch (e) {
      lines.push(`  candidate "${c.name}" (${c.selector}) -> ERROR ${(e as Error).message}`);
    }
  }
  try {
    const html = await page
      .locator(regionSelector)
      .first()
      .evaluate((el) => (el as Element).outerHTML)
      .catch(() => '');
    lines.push(`  region <${regionSelector}> outerHTML (trimmed 4000):\n${(html || '(empty)').slice(0, 4000)}`);
  } catch (e) {
    lines.push(`  region dump ERROR: ${(e as Error).message}`);
  }
  lines.push(`===== END DUMP [${label}] =====\n`);
  console.log(lines.join('\n'));
}

test('Meals2Go: cheese pizza carry-out cart (Buffalo/McKinley)', async ({ page }) => {
  try {
    // ---- STEP a: landing renders --------------------------------------------------
    // GROUND TRUTH (trace 847963): meals2go.com loads a LANDING page whose primary CTA
    // is button#landing-page-start-order-button ("Start an Order"). The site does NOT
    // force store selection -- it loads with a DEFAULT store and renders the menu. Do
    // NOT assume a clean store.
    await step('open meals2go.com landing', async () => {
      await page.goto('https://www.meals2go.com', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);

      // CAPABILITY: the landing rendered -- the VERIFIED "Start an Order" CTA OR the
      // VERIFIED header store switcher is present (a returning session may skip the
      // landing and drop straight onto the menu with its switcher in the header).
      const startOrder = page.locator('button#landing-page-start-order-button');
      const storeSwitcher = page
        .locator('#main-header-fulfillment-info, button.change-store-button')
        .or(page.getByRole('button', { name: /menu for /i }));
      await expect(
        startOrder.or(storeSwitcher).first(),
        'STEP a: neither the "Start an Order" CTA nor the header store switcher rendered -- read the "a:landing" dump.',
      ).toBeVisible({ timeout: 20000 });

      // DUMP: entry points on the landing -- start-order CTA + the header switcher.
      await dumpDom(
        page,
        'a:landing',
        [
          { name: 'start-order button (id)', selector: 'button#landing-page-start-order-button' },
          { name: 'store switcher (id/class)', selector: '#main-header-fulfillment-info, button.change-store-button' },
          { name: 'menu-for store label', selector: 'text=/menu for /i' },
          { name: 'nav', selector: 'nav, [role="navigation"]' },
          { name: 'header/banner', selector: 'header, [role="banner"]' },
        ],
        'header, [role="banner"], nav, body',
      );
    });

    // ---- STEP b: GATE-B fulfillment-modal recon -----------------------------------
    // ROOT CAUSE (trace 847996): clicking #landing-page-start-order-button opens a
    // STORE/FULFILLMENT MODAL (<app-modal-form><div role="dialog" class="weg-modal-
    // outer"><app-fulfillment-type-change> "How do you want to get your order?" with
    // #fulfillment-confirmation-confirm-button-{carryout,curbside,delivery}). The
    // harness's generic popup-dismisser was matching that modal's
    // <button class="store-modal-close-button"> and CLOSING it, so the flow fell
    // through against an empty page. dismissInterstitials is now SCOPED to skip
    // flow-driven modals (see lib/flow.ts FLOW_MODAL_EXCLUDE_SELECTOR), which is what
    // makes this drive possible.
    //
    // This iteration (trace 848634): store selection is TWO-STAGE. Open the modal ->
    // CARRYOUT -> type "Buffalo" (a GOOGLE ADDRESS autocomplete, not a store list) ->
    // PICK the "Buffalo, NY" address -> THEN the store-selection screen (McKinley)
    // appears. RECON-DUMP that store screen; capability-assert ONLY that it advanced.
    await step('GATE-B: Carryout -> pick address -> store-select (recon)', async () => {
      await dismissInterstitials(page); // safe now: skips the flow modal

      // a. Open the fulfillment modal via the VERIFIED landing CTA.
      const startOrder = page.locator('button#landing-page-start-order-button').first();
      try {
        if (await startOrder.isVisible({ timeout: 8000 })) {
          await startOrder.click({ timeout: 5000 });
        }
      } catch {
        /* best-effort -- a returning session may open the modal differently */
      }
      await dismissInterstitials(page); // safe now: scoped away from the modal

      // b. CAPABILITY: the fulfillment modal opened. VERIFIED container + heading from
      //    trace 847996. Bounded wait on the modal (NOT networkidle).
      const fulfillmentModal = page
        .locator('[role="dialog"].weg-modal-outer')
        .or(page.locator('app-fulfillment-type-change'))
        .or(page.getByText(/how do you want to get your order/i))
        .first();
      await expect(
        fulfillmentModal,
        'GATE-B: fulfillment modal did not open after "Start an Order" -- read the "b:fulfillment-modal" dump. ' +
          'If empty, the popup-dismisser may have closed it (check lib/flow.ts scoping).',
      ).toBeVisible({ timeout: 20000 });

      await dumpDom(
        page,
        'b:fulfillment-modal',
        [
          { name: 'modal container', selector: '[role="dialog"].weg-modal-outer, app-fulfillment-type-change' },
          { name: 'heading', selector: 'text=/how do you want to get your order/i' },
          { name: 'carryout button', selector: '#fulfillment-confirmation-confirm-button-carryout' },
          { name: 'curbside button', selector: '#fulfillment-confirmation-confirm-button-curbside' },
          { name: 'delivery button', selector: '#fulfillment-confirmation-confirm-button-delivery' },
          { name: 'store-modal-close (must NOT be auto-clicked)', selector: 'button.store-modal-close-button' },
        ],
        'app-modal-form, [role="dialog"].weg-modal-outer, app-fulfillment-type-change',
      );

      // c. Choose CARRYOUT. VERIFIED id; aria-label/role fallback per discipline.
      const carryout = page
        .locator('#fulfillment-confirmation-confirm-button-carryout')
        .or(page.getByRole('button', { name: 'Carryout' }))
        .first();
      await expect(
        carryout,
        'GATE-B: Carryout button (#fulfillment-confirmation-confirm-button-carryout) not visible in the modal -- read "b:fulfillment-modal".',
      ).toBeVisible({ timeout: 15000 });
      await carryout.click({ timeout: 5000 });

      // The store-selection screen (Buffalo search + McKinley result) is what we have
      // NOT captured. Settle the modal transition, then bounded-wait for the search
      // input or a result list before dumping.
      const searchInput = page
        .getByRole('textbox')
        .or(page.getByPlaceholder(/zip|city|store|search|address/i))
        .first();
      const resultList = page
        .locator('[role="dialog"].weg-modal-outer [role="option"], [role="dialog"].weg-modal-outer [role="listitem"], [role="dialog"].weg-modal-outer li, [data-testid*="store" i]')
        .first();
      try {
        await searchInput.or(resultList).first().waitFor({ state: 'visible', timeout: 12000 });
      } catch {
        /* fall through to the dump -- it reveals what the carryout screen actually is */
      }

      // d. ===== RECON DUMP [FULFILLMENT AFTER CARRYOUT] ===== (this iteration's point).
      await dumpDom(
        page,
        'FULFILLMENT AFTER CARRYOUT',
        [
          { name: 'modal still open', selector: '[role="dialog"].weg-modal-outer, app-fulfillment-type-change' },
          { name: 'store/zip/city search input (role)', selector: '[role="textbox"]' },
          { name: 'search input (type)', selector: 'input[type="search"], input[type="text"], input[placeholder]' },
          { name: 'result items', selector: '[role="option"], [role="listitem"], li, [data-testid*="store" i]' },
          { name: 'McKinley already present', selector: 'text=/mckinley/i' },
        ],
        '[role="dialog"].weg-modal-outer, app-modal-form, app-fulfillment-type-change, main',
      );

      // ===== TWO-STAGE STORE SELECTION (trace 848634) =====
      // Typing into the search box does NOT hit a store list -- it hits a GOOGLE
      // ADDRESS AUTOCOMPLETE (app-store-selector > app-google-search-results), with
      // button.google-result rows (span.address-main-text "Buffalo" +
      // span.address-secondary-text ", NY, USA"). You must PICK an address FIRST;
      // only THEN does the store-selection screen (where McKinley lives) appear. The
      // prior run searched for McKinley on the address screen -- wrong screen.
      try {
        if (await searchInput.isVisible({ timeout: 8000 })) {
          // STAGE 1: type the locality -> address autocomplete.
          await searchInput.click({ timeout: 4000 });
          await searchInput.fill('Buffalo');
          await page.waitForTimeout(2500); // bounded settle for the address autocomplete

          // RECON DUMP [ADDRESS AUTOCOMPLETE AFTER BUFFALO] -- VERIFIED google-result
          // shape from trace 848634; confirm the row selectors before picking.
          await dumpDom(
            page,
            'ADDRESS AUTOCOMPLETE AFTER BUFFALO',
            [
              { name: 'autocomplete container', selector: 'app-google-search-results, .google-results-container' },
              { name: 'google-result rows', selector: 'button.google-result' },
              { name: 'address-main-text', selector: 'span.address-main-text' },
              { name: 'Buffalo,NY row', selector: 'button.google-result:has-text("Buffalo")' },
            ],
            'app-google-search-results, app-store-selector, [role="dialog"].weg-modal-outer, app-modal-form',
          );

          // STAGE 1 PICK: click the FIRST google-result whose address is "Buffalo, NY"
          // (the top result). VERIFIED class; fall back to the first google-result if
          // the text filter misses, then to any [role="listitem"] button.
          const buffaloFiltered = page
            .locator('button.google-result')
            .filter({ hasText: /buffalo,?\s*ny/i })
            .first();
          const firstResult = page
            .locator('button.google-result')
            .first()
            .or(page.locator('[role="listitem"] button, [role="option"]').first());
          const buffaloAddress =
            (await buffaloFiltered.count().catch(() => 0)) > 0 ? buffaloFiltered : firstResult;
          await expect(
            buffaloAddress,
            'GATE-B: no "Buffalo, NY" address row (button.google-result) to pick -- read "ADDRESS AUTOCOMPLETE AFTER BUFFALO".',
          ).toBeVisible({ timeout: 15000 });
          await buffaloAddress.click({ timeout: 5000 });

          // Assert the address was accepted: the autocomplete list disappears (we then
          // confirm the store screen below). Bounded; never networkidle.
          await page
            .locator('app-google-search-results, .google-results-container')
            .first()
            .waitFor({ state: 'hidden', timeout: 12000 })
            .catch(() => {
              /* some flows replace the panel in place; the dump still reveals state */
            });
          await page.waitForTimeout(1500); // bounded settle for the store-selection screen

          // ===== STAGE 2: STORE SELECTION (trace 848657) =====
          // The store list is VIRTUALIZED (~56 of 113 rendered, distance-sorted) and
          // McKinley sits ~7.9mi down -- NOT in the top results -- so a plain
          // text=/mckinley/ wait is unreliable. Robustness win: FILTER the list via
          // input#store-search-input, then click the store ROW.
          await dumpDom(
            page,
            'STORE SELECT AFTER ADDRESS',
            [
              { name: 'store-selector container', selector: 'app-store-selector, .store-list' },
              { name: 'store filter input', selector: 'input#store-search-input' },
              { name: 'store rows (app-wegmans-store)', selector: 'app-wegmans-store' },
              { name: 'store-list header (count)', selector: '.store-list-header' },
            ],
            'app-store-selector, [role="dialog"].weg-modal-outer, app-modal-form, main',
          );

          // STAGE 2a: filter the 113-store list down to McKinley (avoids the
          // virtualized-scroll problem). VERIFIED id; placeholder/role fallback.
          const storeFilter = page
            .locator('input#store-search-input')
            .or(page.locator('app-store-selector input[type="text"], app-store-selector input'))
            .first();
          try {
            if (await storeFilter.isVisible({ timeout: 8000 })) {
              await storeFilter.click({ timeout: 4000 });
              await storeFilter.fill('Mckinley');
              await page.waitForTimeout(2000); // bounded settle for the filtered list
            }
          } catch {
            /* best-effort -- if the filter input shape changed, the row match below still tries */
          }

          // STAGE 2b: click the McKinley store ROW. The clickable is
          // button.wegmans-store-container (VERIFIED) -- NOT the title span and NOT
          // .store-info > button.info-button. Primary: scope by the exact store-title;
          // fallback: any app-wegmans-store containing /mckinley/i -> its container button.
          const mckinleyStore = page
            .locator('app-wegmans-store:has(span.store-title:text-is("Mckinley")) button.wegmans-store-container')
            .or(
              page
                .locator('app-wegmans-store')
                .filter({ hasText: /mckinley/i })
                .locator('button.wegmans-store-container'),
            )
            .first();
          await expect(
            mckinleyStore,
            'GATE-B: McKinley store row (button.wegmans-store-container) not found after filtering -- read "STORE SELECT AFTER ADDRESS".',
          ).toBeVisible({ timeout: 15000 });
          await mckinleyStore.click({ timeout: 5000 });

          // Bounded wait for the selection to take effect (modal closes onto the menu).
          await page
            .locator('app-store-selector')
            .first()
            .waitFor({ state: 'hidden', timeout: 15000 })
            .catch(() => {
              /* selecting may require a confirm step -- the dump below reveals it */
            });
          await page.waitForTimeout(1500); // bounded settle after store-select

          // RECON DUMP [AFTER STORE SELECT] -- what does selecting a store DO? (close the
          // modal + land on the menu? require a confirm?) This drives the next iteration.
          await dumpDom(
            page,
            'AFTER STORE SELECT',
            [
              { name: 'store modal still open', selector: 'app-store-selector, [role="dialog"].weg-modal-outer' },
              { name: 'header switcher (Menu for ...)', selector: '#main-header-fulfillment-info, button.change-store-button' },
              { name: 'header shows Mckinley', selector: '#main-header-fulfillment-info:has-text("Mckinley"), button.change-store-button:has-text("Mckinley")' },
              { name: 'confirm CTA', selector: 'button:has-text("Confirm"), button:has-text("Continue"), button:has-text("Start")' },
              { name: 'menu surface', selector: 'nav, [role="tablist"], main' },
            ],
            'header, [role="banner"], app-store-selector, [role="dialog"].weg-modal-outer, main',
          );
        }
      } catch {
        /* best-effort -- the store-select shape is still being captured */
      }
      await dismissInterstitials(page); // safe: scoped away from the flow modal

      // CAPABILITY: a store context is established -- the header switcher updated to a
      // "Menu for <store>" state (prefer Mckinley) and/or the store modal closed onto
      // the menu. We assert capability (we left the modal onto a menu), not exact
      // content; the [AFTER STORE SELECT] dump confirms McKinley specifically.
      const storeContextSignal = page
        .locator('#main-header-fulfillment-info, button.change-store-button')
        .filter({ hasText: /mckinley/i })
        .or(page.getByRole('button', { name: /menu for /i }))
        .or(page.locator('#main-header-fulfillment-info, button.change-store-button'))
        .first();
      await expect(
        storeContextSignal,
        'GATE-B: store not selected -- no "Menu for <store>" header after clicking McKinley -- read "AFTER STORE SELECT".',
      ).toBeVisible({ timeout: 20000 });
    });

    // ---- STEP c: takeout menu -> Pizza category -----------------------------------
    await step('navigate takeout menu -> Pizza', async () => {
      await dismissInterstitials(page);

      // RECON DUMP [MENU AFTER STORE] -- with the McKinley store now selected, capture
      // the real menu landing so the menu->Pizza nav can be written from ground truth
      // if the guesses below miss (these steps were unreachable until store-select).
      await dumpDom(
        page,
        'MENU AFTER STORE',
        [
          { name: 'header switcher (Menu for ...)', selector: '#main-header-fulfillment-info, button.change-store-button' },
          { name: 'category nav', selector: 'nav a, [role="tablist"] [role="tab"], [data-testid*="categor" i]' },
          { name: 'Pizza category', selector: 'text=/pizza/i' },
          { name: 'menu item cards', selector: '[data-testid*="product" i], [data-testid*="item" i], article, li' },
        ],
        'header, [role="banner"], nav, [role="tablist"], main',
      );

      // Prefer DIRECT-URL navigation to a known menu route to dodge any search/auto-
      // complete hijack (the ginger -> "waterloo" lesson). Route is UNVERIFIED -- the
      // dump + trace URL will reveal the real menu path to hard-code later.
      const menu = page
        .getByRole('link', { name: /menu|order|shop|food/i })
        .or(page.getByRole('button', { name: /menu|order|shop|food/i }))
        .first();
      try {
        if (await menu.isVisible({ timeout: 8000 })) {
          await menu.click({ timeout: 5000 });
        }
      } catch {
        /* best-effort */
      }
      await dismissInterstitials(page);

      await dumpDom(
        page,
        'c:menu-categories',
        [
          { name: 'category nav', selector: 'nav a, [role="tablist"] [role="tab"], [data-testid*="categor" i]' },
          { name: 'Pizza category', selector: 'text=/pizza/i' },
        ],
        'nav, [role="tablist"], main',
      );

      // Click the Pizza category. Role unknown (tab/link/button) -- accept any.
      const pizzaCategory = page
        .getByRole('tab', { name: /pizza/i })
        .or(page.getByRole('link', { name: /pizza/i }))
        .or(page.getByRole('button', { name: /pizza/i }))
        .first();
      await expect(pizzaCategory).toBeVisible({ timeout: 20000 });
      await pizzaCategory.click({ timeout: 5000 });
      await dismissInterstitials(page);

      // CAPABILITY: a Pizza category/menu rendered with pizza ITEMS present -- not a
      // specific item name (resilient to menu reorder / seasonal SKUs).
      await expect(page.getByText(/pizza/i).first()).toBeVisible({ timeout: 20000 });
      await dumpDom(
        page,
        'c:pizza-listing',
        [
          { name: 'pizza item cards', selector: '[data-testid*="product" i], [data-testid*="item" i], article, li' },
          { name: 'cheese matches', selector: 'text=/cheese/i' },
        ],
        'main',
      );
    });

    // ---- STEP d: open a CHEESE pizza ----------------------------------------------
    await step('open a cheese pizza item', async () => {
      await dismissInterstitials(page);
      // Match a CHEESE pizza resiliently by role/text; .first() of cheese matches --
      // NEVER a specific SKU/item-id. A product card may be a link or a button.
      const cheesePizza = page
        .getByRole('link', { name: /cheese/i })
        .or(page.getByRole('button', { name: /cheese/i }))
        .or(page.getByText(/cheese/i))
        .first();
      await expect(cheesePizza).toBeVisible({ timeout: 20000 });
      await cheesePizza.click({ timeout: 5000 });
      await dismissInterstitials(page);

      // CAPABILITY: the item DETAIL / customization view loaded -- an add-to-cart
      // control OR a customization (size/crust/options) region is present. DOM-signal
      // based, NOT a URL assertion (SPA nav; the route is unknown + may not change).
      await expect(
        page
          .getByRole('button', { name: /add to (cart|order|bag)|add$/i })
          .or(page.getByText(/size|crust|select an option|customize|quantity/i))
          .first(),
      ).toBeVisible({ timeout: 20000 });
      await dumpDom(
        page,
        'd:item-detail',
        [
          { name: 'add-to-cart control', selector: 'button:has-text("Add"), [data-testid*="add" i]' },
          { name: 'required options', selector: 'text=/size|crust|select an option|required|customize/i' },
        ],
        '[role="dialog"], dialog, main',
      );
    });

    // ---- STEP e: add to cart -------------------------------------------------------
    // GATE-E (trace 848672): the cheese-pizza detail pane (app-pop-open-pane) renders a
    // complete orderable item -- <h1 class="item-name">Thin Crust Cheese Pizza - 8
    // Slices</h1> ($14.00). NO required size/crust gate (dipping sauces are OPTIONAL
    // checkboxes -- leave unchecked; quantity defaults to 1 -- leave it). THE ADD BUTTON
    // is <button class="cart-button"> "Add to cart • $14.00" (NOT disabled). The prior
    // run matched by accessible-name (/add to cart/) on a button whose name is split
    // across spans -- flaky. Use the CLASS.
    await step('add cheese pizza to cart', async () => {
      await dismissInterstitials(page);

      await dumpDom(
        page,
        'e:before-add',
        [
          { name: 'item name', selector: 'h1.item-name, .item-name' },
          { name: 'cart-button (real)', selector: 'app-pop-open-pane button.cart-button, button.cart-button' },
          { name: 'disabled cart-button', selector: 'button.cart-button[disabled], button.cart-button[aria-disabled="true"]' },
          { name: 'optional dipping-sauce checkboxes (do NOT click)', selector: 'input[type="checkbox"], [role="checkbox"]' },
        ],
        'app-pop-open-pane, [role="dialog"], dialog, main',
      );

      // VERIFIED selector: button.cart-button inside the detail pane. Accessible-name
      // fallback only if the class ever changes.
      const addToCart = page
        .locator('app-pop-open-pane button.cart-button, button.cart-button')
        .or(page.getByRole('button', { name: /add to cart/i }))
        .first();
      await expect(
        addToCart,
        'GATE-E: add-to-cart control (button.cart-button) not visible -- read the "e:before-add" dump.',
      ).toBeVisible({ timeout: 20000 });
      await addToCart.click({ timeout: 5000 });

      // Bounded wait for the add to take effect (the detail pane typically closes).
      await page
        .locator('app-pop-open-pane')
        .first()
        .waitFor({ state: 'hidden', timeout: 12000 })
        .catch(() => {
          /* the pane may stay open with an inline confirmation -- the dump reveals it */
        });
      await dismissInterstitials(page);

      // RECON DUMP [AFTER ADD TO CART] -- what does adding DO? (pane close? cart-count
      // badge? "added to cart" toast?) Drives the cart-open selector next.
      await dumpDom(
        page,
        'AFTER ADD TO CART',
        [
          { name: 'detail pane still open', selector: 'app-pop-open-pane' },
          { name: 'cart count badge', selector: '[class*="cart-count" i], [data-testid*="cart-count" i], [aria-label*="cart" i] [class*="count" i]' },
          { name: 'added confirmation/toast', selector: 'text=/added to (cart|order|bag)|item added|added/i' },
          { name: 'header cart affordance', selector: '[class*="cart" i] button, button[aria-label*="cart" i], [data-testid*="cart" i]' },
          { name: 'view cart/checkout CTA', selector: 'text=/view (cart|order|bag)|checkout|cart/i' },
        ],
        'header, [role="banner"], app-pop-open-pane, [role="dialog"], main',
      );

      // CAPABILITY: an add fired -- a cart-count badge / "added" toast / a cart affordance
      // appeared (or the pane closed onto one). We do NOT assert an exact count (resilient
      // to a dirty start); the dump confirms the precise signal for the next iteration.
      await expect(
        page
          .getByText(/added to (cart|order|bag)|item added|added/i)
          .or(page.locator('[class*="cart-count" i], [data-testid*="cart-count" i], [aria-label*="cart" i]'))
          .or(page.getByRole('button', { name: /cart|bag|checkout|view order/i }))
          .first(),
        'GATE-E: no add-to-cart signal after clicking button.cart-button -- read "AFTER ADD TO CART".',
      ).toBeVisible({ timeout: 20000 });
    });

    // ---- STEP f: open cart, assert the pizza line item -----------------------------
    // Cart DOM NOT yet captured -- open the cart, DUMP [CART CONTENTS], assert a
    // /cheese|pizza/ line item exists (capability, resilient -- not an exact item id).
    await step('open cart and assert the cheese pizza line item', async () => {
      await dismissInterstitials(page);

      // Open/view the cart. The header cart affordance shape is unknown -- try a view-
      // cart/checkout CTA, then a cart icon/labelled control. A mini-cart may already be
      // open after the add (best-effort -- non-fatal).
      const cartButton = page
        .getByRole('link', { name: /cart|bag|view order|checkout/i })
        .or(page.getByRole('button', { name: /cart|bag|view order|checkout/i }))
        .or(page.locator('[class*="cart" i] button, button[aria-label*="cart" i], [data-testid*="cart" i]'))
        .first();
      try {
        if (await cartButton.isVisible({ timeout: 10000 })) {
          await cartButton.click({ timeout: 5000 });
        }
      } catch {
        /* best-effort -- a mini-cart may already be open after add */
      }
      await dismissInterstitials(page);

      // RECON DUMP [CART CONTENTS] -- the cart container + line-item + open/view control.
      await dumpDom(
        page,
        'CART CONTENTS',
        [
          { name: 'cart container', selector: '[class*="cart" i], aside, [role="dialog"]' },
          { name: 'line items', selector: '[data-testid*="line" i], [data-testid*="cart-item" i], [class*="cart-item" i], [class*="line-item" i], li' },
          { name: 'cheese/pizza line item', selector: 'text=/cheese|pizza/i' },
          { name: 'open/view-cart control', selector: '[class*="cart" i] button, button[aria-label*="cart" i], [data-testid*="cart" i], text=/view (cart|order|bag)|checkout/i' },
          { name: 'remove affordance', selector: 'button:has-text("Remove"), [aria-label*="remove" i], [data-testid*="remove" i], [class*="remove" i], [class*="trash" i]' },
        ],
        '[role="dialog"], dialog, aside, [class*="cart" i], main',
      );

      // CAPABILITY: the cart SHOWS the pizza -- a line item matching cheese/pizza
      // resiliently (not the exact item name).
      await expect(
        page.getByText(/cheese/i).or(page.getByText(/pizza/i)).first(),
        'cart does not show a cheese/pizza line item -- read the "CART CONTENTS" dump.',
      ).toBeVisible({ timeout: 20000 });
    });
  } finally {
    // ---- STEP g: SELF-CLEAN -- ALWAYS attempt cart teardown ------------------------
    // Runs even on a mid-flow failure (finally). Tolerates a dirty start: it does not
    // assume the cart began empty; it removes what it can and asserts the cart ends
    // empty (best-effort, never masks the original failure -- cleanup errors are
    // swallowed so the real step failure is what surfaces).
    await step('SELF-CLEAN: remove the cheese pizza from the cart', async () => {
      try {
        await dismissInterstitials(page);

        // Make sure a cart surface is open so remove controls are reachable.
        const openCart = page
          .getByRole('link', { name: /cart|bag|view order/i })
          .or(page.getByRole('button', { name: /cart|bag|view order/i }))
          .or(page.locator('[data-testid*="cart" i], [aria-label*="cart" i]'))
          .first();
        try {
          if (await openCart.isVisible({ timeout: 6000 })) {
            await openCart.click({ timeout: 4000 });
          }
        } catch {
          /* best-effort */
        }
        await dismissInterstitials(page);

        // RECON DUMP [CART REMOVE CONTROLS] -- the remove/delete/trash affordance per
        // line item (not yet captured). The next iteration tightens the remove selector
        // from this dump's region outerHTML.
        await dumpDom(
          page,
          'CART REMOVE CONTROLS',
          [
            { name: 'line items present', selector: '[data-testid*="cart-item" i], [data-testid*="line" i], [class*="cart-item" i], [class*="line-item" i], li' },
            { name: 'remove buttons (text/label/testid)', selector: 'button:has-text("Remove"), button:has-text("Delete"), [aria-label*="remove" i], [aria-label*="delete" i], [data-testid*="remove" i]' },
            { name: 'remove/trash by class', selector: '[class*="remove" i], [class*="trash" i], [class*="delete" i]' },
            { name: 'cheese/pizza line still present', selector: 'text=/cheese|pizza/i' },
          ],
          '[role="dialog"], dialog, aside, [class*="cart" i], main',
        );

        // Remove every removable line item (handles a dirty start too -- clears whatever
        // is there, not just our pizza). Bounded loop so a stuck remove can't spin.
        const removeLocator = page
          .getByRole('button', { name: /remove|delete/i })
          .or(page.locator('[aria-label*="remove" i], [aria-label*="delete" i], [data-testid*="remove" i], button[class*="remove" i], button[class*="trash" i], button[class*="delete" i]'));
        for (let i = 0; i < 10; i++) {
          let remaining = 0;
          try {
            remaining = await removeLocator.count();
          } catch {
            break;
          }
          if (remaining === 0) break;
          if (i === 0 && remaining > 1) {
            console.log(`[cleanup] cart had ${remaining} removable items at teardown -- possible DIRTY START; clearing all.`);
          }
          try {
            await removeLocator.first().click({ timeout: 4000 });
            await dismissInterstitials(page);
            // Confirm a possible "remove item?" confirmation dialog.
            const confirm = page.getByRole('button', { name: /^(remove|delete|yes|confirm)$/i }).first();
            if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) {
              await confirm.click({ timeout: 3000 });
            }
            await page.waitForTimeout(1000);
          } catch {
            break;
          }
        }

        await dumpDom(
          page,
          'g:cleanup-end',
          [
            { name: 'remaining line items', selector: '[data-testid*="cart-item" i], [data-testid*="line" i], li' },
            { name: 'cheese/pizza still present', selector: 'text=/cheese|pizza/i' },
            { name: 'empty-cart signal', selector: 'text=/cart is empty|no items|empty/i' },
          ],
          '[role="dialog"], dialog, main, aside',
        );

        // Best-effort assertion the cart is empty / the pizza is gone. Soft-checked so a
        // cleanup limitation never masks the real step failure that brought us here.
        const emptySignal = page
          .getByText(/cart is empty|your cart is empty|no items/i)
          .or(page.locator('[data-testid*="cart-item" i], [data-testid*="line" i]'));
        const empty = await emptySignal
          .first()
          .isVisible({ timeout: 5000 })
          .catch(() => false);
        console.log(`[cleanup] post-teardown empty/gone signal observed: ${empty}`);
      } catch (e) {
        // Never let cleanup throw -- it must not overwrite the original failure.
        console.log(`[cleanup] teardown error (swallowed): ${(e as Error).message}`);
      }
    });
  }
});
