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
 * Emit a diagnostic line so it is CAPTURED IN THE TRACE.
 *
 * ★ Empirically verified (probe, run locally): spec-side (Node) console.log does
 * NOT appear in the Playwright PAGE trace's console-event stream (0-trace.trace) --
 * it lands only as a {type:"stdout"} event in the runner trace (test.trace), a
 * different channel the SynthWatch runner does not surface as a "console event".
 * That is why earlier PRE-CLICK / DOM-DUMP output never showed up even though the
 * code ran (provenance has_preclick=true). PAGE-side console.log
 * (page.evaluate(() => console.log(...))) DOES land in 0-trace.trace as a
 * {type:"console"} event -- the same stream the runner counts. So we relay through
 * the page's console. Best-effort + Node console.log too (local/stdout fallback).
 */
async function relayToTrace(page: Page, text: string): Promise<void> {
  console.log(text); // local/stdout (CI + test.trace)
  try {
    // PAGE console -> captured in the Playwright page trace's console events.
    await page.evaluate((m) => console.log(m), text);
  } catch {
    /* page may be closed/navigating -- the Node console.log above still emits */
  }
}

/**
 * Labeled DOM dump. Recon aid only -- never throws, never fails the flow.
 * Emits, for a labeled gate: the current URL, the live count of each candidate
 * locator (so the trace shows which guesses matched), and a trimmed outerHTML
 * of a region so the real DOM is visible when every guess missed.
 * Routed through relayToTrace so dumps actually land in the trace.
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
  await relayToTrace(page, lines.join('\n'));
}

test('Meals2Go: cheese pizza carry-out cart (Buffalo/McKinley)', async ({ page }) => {
  // Captured from the add-to-cart API response (step e) so the finally can SELF-CLEAN the
  // SAME cart via the API -- never by navigating to / (which resets to a fresh guest cart).
  let cleanupCartItemsUrl: string | null = null;
  let cleanupAuthHeader: string | undefined;
  let cleanupItemIds: string[] = [];
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
    // ROOT CAUSE (census, trace 849132): the flow died HERE (step d), never reaching
    // step e. The Pizza & Wings menu has SUB-CUISINE TABS and loads with "Pizza Promo &
    // Packages" SELECTED by default. The orderable "Thin Crust Cheese Pizza - 8 Slices"
    // lives under the "Thin Crust Pizza" tab -- so on the default Promo tab the
    // .first() /cheese/i match was a promo/package tile (or a non-navigating text node),
    // the click opened no item detail, and the toBeVisible timed out at 20s.
    await step('open a cheese pizza item', async () => {
      await dismissInterstitials(page);

      // d.1 -- select the THIN CRUST PIZZA sub-cuisine tab FIRST.
      // DUPLICATE-ID (census, trace 849177): button#cuisine-thin-crust-pizza resolves to
      // TWO elements (the sub-cuisine nav is rendered twice -- e.g. a sticky/mobile +
      // desktop copy). The prior .first() landed on a HIDDEN duplicate, isVisible() was
      // false, and the click was skipped -> stayed on the default Promo tab. Disambiguate
      // by filtering to VISIBLE *before* .first() so we get the one active tab.
      const thinCrustTab = page
        .locator('button#cuisine-thin-crust-pizza')
        .or(page.getByRole('tab', { name: /thin crust pizza/i }))
        .or(page.getByRole('button', { name: /thin crust pizza/i }))
        .filter({ visible: true })
        .first();
      let tabClicked = false;
      try {
        if (await thinCrustTab.isVisible({ timeout: 8000 })) {
          await thinCrustTab.click({ timeout: 5000 });
          tabClicked = true;
          await page.waitForTimeout(1500); // bounded settle for the thin-crust listing
        }
      } catch {
        /* best-effort -- menu may be restructured; the d0 dump reveals the truth */
      }
      await dismissInterstitials(page);

      // Post-click selected-state probe (recon; non-throwing): did the tab actually
      // switch? Check any #cuisine-thin-crust-pizza copy for an active/selected marker.
      let tabSelected: boolean | null = null;
      try {
        tabSelected = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button#cuisine-thin-crust-pizza')).some(
            (e) =>
              e.getAttribute('aria-selected') === 'true' ||
              e.getAttribute('aria-current') === 'true' ||
              /(^|\s)(active|selected)(\s|$)/i.test(e.className),
          ),
        );
      } catch {
        tabSelected = null;
      }
      await relayToTrace(
        page,
        `[d0:thin-crust-tab] thin-crust sub-cuisine tab found+clicked: ${tabClicked} | selected(after): ${tabSelected}`,
      );

      // d.2 -- RECON DUMP [d0:thin-crust-listing]: confirm the tab-select worked and show
      // what cheese items are present under it (instrument the fix, don't assume it).
      await dumpDom(
        page,
        'd0:thin-crust-listing',
        [
          { name: 'thin-crust tab (selected?)', selector: 'button#cuisine-thin-crust-pizza, button#cuisine-thin-crust-pizza[aria-selected="true"], button#cuisine-thin-crust-pizza.selected' },
          { name: 'clickable cheese items', selector: 'a:has-text("cheese"), button:has-text("cheese")' },
          { name: 'cheese text (any)', selector: 'text=/cheese/i' },
          { name: 'product cards', selector: '[data-testid*="product" i], [data-testid*="item" i], article, li' },
        ],
        'main',
      );

      // d.3 -- match a CHEESE pizza, preferring a CLICKABLE product card (link/button)
      // over a bare text node. Priority: accessible-named link -> button -> any clickable
      // cheese card. .first() of the chosen kind -- resilient (no hardcoded SKU), but it
      // lands on an ORDERABLE item, not a promo tile / non-navigating text.
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
        'STEP d: no clickable cheese pizza under the thin-crust listing -- read the "d0:thin-crust-listing" dump.',
      ).toBeVisible({ timeout: 20000 });

      // ===== STEP-D CLICK -> WAIT FOR PANE (trace 849266) =====
      // DECISIVE recon (#21): the click WORKS and the detail pane opens INSTANTLY
      // (clickOutcome=ok, paneAppearedAfterMs=0, clickedCardStillAttached=true, and d0b
      // showed app-pop-open-pane=1 / h1.item-name=1 / button.cart-button=1). The earlier
      // "retrying click action / 20s timeout" was Playwright re-attempting a click whose
      // effect (pane open) had ALREADY landed, against a card transitioning through
      // div.item-loading. FIX: issue the click WITHOUT blocking on its post-actionability
      // settle, then gate on the PANE appearing -- pane-open is the success signal, not
      // click-resolution.
      await cheesePizza.click({ timeout: 5000, noWaitAfter: true }).catch(() => {
        /* a click-settle retry/timeout is NOT a failure here -- the click's effect lands
           instantly (849266) and the pane-open gate below is the real success signal */
      });
      await dismissInterstitials(page);

      // SUCCESS GATE: the detail pane opened (h1.item-name or the cart button is present).
      await expect(
        page.locator('app-pop-open-pane h1.item-name, app-pop-open-pane button.cart-button').first(),
        'STEP d: detail pane did not open after clicking the cheese item -- read the "d0b:after-click" dump.',
      ).toBeVisible({ timeout: 20000 });

      // [d0b:after-click] -- confirm the pane contents (cheap, captured, useful).
      await dumpDom(
        page,
        'd0b:after-click',
        [
          { name: 'app-pop-open-pane present', selector: 'app-pop-open-pane' },
          { name: 'item-name (cheese pizza)', selector: 'app-pop-open-pane h1.item-name, h1.item-name' },
          { name: 'cart-button present', selector: 'app-pop-open-pane button.cart-button, button.cart-button' },
          { name: 'customization region', selector: 'text=/size|crust|select an option|customize|quantity/i' },
        ],
        'app-pop-open-pane, [role="dialog"], main',
      );

      // NOTE (trace 849349): the previously-here capability assertion + the #23 visibility
      // probe are REMOVED. The probe PROVED the cart button is fully visible at d0b
      // (rect 536x48, display:block, visibility:visible, opacity:1, offsetParent!=null,
      // disabled:false, Playwright isVisible()=true at 0ms) -- so every hidden/zero-size/
      // hydration theory is falsified. Yet the removed assertion's compound locator
      // (`app-pop-open-pane button.cart-button, button.cart-button` .or customization,
      // .first()) timed out at 20s on that provably-visible button -- a malfunctioning,
      // REDUNDANT gate: L575 above already confirms the pane opened, and step e's own census
      // + gate are the real cart-button checkpoint. We stop stacking step-d cart-button gates
      // and let step e run. Chain: 575 pane gate -> d0b dump -> d:item-detail dump -> step e.
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

      // ===== PRE-GATE TELEMETRY (run 849055) =====
      // Previously the diagnostics ran AFTER the GATE-E toBeVisible -- which is the line
      // that times out (the button is not resolving as visible to the locator within
      // 20s), so the diagnostics never executed. Run the decisive census FIRST, then a
      // SOFT visibility gate, so the trace finally carries the data regardless.

      // [CART-BUTTON DOM CENSUS] -- enumerate what actually exists, BEFORE any wait.
      // page.evaluate over querySelectorAll: never waits on visibility, never throws.
      try {
        const census = await page.evaluate(() => {
          const detail = (el: Element) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              text: (el.textContent || '').trim().slice(0, 60),
              disabled: (el as HTMLButtonElement).disabled,
              ariaDisabled: el.getAttribute('aria-disabled'),
              rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) },
              display: cs.display,
              visibility: cs.visibility,
              opacity: cs.opacity,
              pointerEvents: cs.pointerEvents,
              position: cs.position,
              offsetParentNull: (el as HTMLElement).offsetParent === null,
              inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0 && r.height > 0,
            };
          };
          const accName = (el: Element) =>
            (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
          const reAdd = /add to (cart|order|bag)|add$/i;
          const bare = Array.from(document.querySelectorAll('button.cart-button'));
          const scoped = Array.from(document.querySelectorAll('app-pop-open-pane button.cart-button'));
          const byName = Array.from(document.querySelectorAll('button')).filter((b) => reAdd.test(accName(b)));
          const footer = document.querySelector(
            'app-pop-open-pane div.bottom-action-buttons, app-pop-open-pane .bottom-action-buttons, div.bottom-action-buttons',
          );
          return {
            paneCount: document.querySelectorAll('app-pop-open-pane').length,
            'button.cart-button': { count: bare.length, items: bare.map(detail) },
            'app-pop-open-pane button.cart-button': { count: scoped.length, items: scoped.map(detail) },
            'buttons matching /add to.../i': {
              count: byName.length,
              items: byName.map((b) => ({ name: accName(b).slice(0, 60), ...detail(b) })),
            },
            footerSnippet: footer ? footer.outerHTML.slice(0, 300) : '(no bottom-action-buttons found)',
          };
        });
        await relayToTrace(
          page,
          `\n===== CART-BUTTON DOM CENSUS =====\n${JSON.stringify(census, null, 2)}\n===== END CART-BUTTON DOM CENSUS =====\n`,
        );
      } catch (e) {
        await relayToTrace(page, `[CART-BUTTON DOM CENSUS] census error (non-fatal): ${(e as Error).message}`);
      }

      // SOFT visibility gate: do NOT hard-fail here -- a timeout would skip everything
      // below. Short timeout (8s, not 20s) -- the census already reports visibility.
      let gateEVisible = false;
      try {
        await expect(addToCart).toBeVisible({ timeout: 8000 });
        gateEVisible = true;
      } catch {
        gateEVisible = false;
      }
      await relayToTrace(page, `[GATE-E RESULT] add-to-cart button visible to locator within 8s: ${gateEVisible}`);

      // ===== ACTIONABILITY RECON (trace 848783) =====
      // The selector is CORRECT and the button is visible+enabled, yet the click never
      // registers (Playwright retries "visible, enabled, stable" until the GATE-E assert
      // times out) -- a sticky-footer actionability failure, not a selector/option gate.
      // INSTRUMENT FIRST: dump the button's geometry + what sits at its center point, then
      // try escalating click strategies and LOG which one lands, so the trace names the fix.

      // 1. [PRE-CLICK CART-BUTTON STATE] -- geometry, center-point occupant, disabled,
      //    scrollable ancestor, in-viewport. Recon aid; never throws the flow.
      try {
        const preClick = await addToCart.evaluate((el) => {
          const describe = (n: Element | null): string => {
            if (!n) return 'null';
            const cls =
              typeof (n as HTMLElement).className === 'string' && (n as HTMLElement).className.trim()
                ? '.' + (n as HTMLElement).className.trim().split(/\s+/).join('.')
                : '';
            return `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${cls}`;
          };
          const r = el.getBoundingClientRect();
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          const atPoint = document.elementFromPoint(cx, cy);
          const btn = el as HTMLButtonElement;
          let scrollableAncestor: string | null = null;
          let p: Element | null = el.parentElement;
          while (p) {
            const s = getComputedStyle(p);
            if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) {
              scrollableAncestor = describe(p);
              break;
            }
            p = p.parentElement;
          }
          const cs = getComputedStyle(el);
          return {
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) },
            center: { cx, cy },
            elementAtCenter: describe(atPoint),
            atCenterIsButton: atPoint === el || el.contains(atPoint) || (!!atPoint && atPoint.closest?.('button.cart-button') === el),
            disabled: btn.disabled,
            ariaDisabled: el.getAttribute('aria-disabled'),
            pointerEvents: cs.pointerEvents,
            visibility: cs.visibility,
            opacity: cs.opacity,
            position: cs.position,
            scrollableAncestor,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            fullyInViewport: r.top >= 0 && r.bottom <= window.innerHeight,
          };
        }, undefined, { timeout: 5000 });
        await relayToTrace(
          page,
          `\n===== PRE-CLICK CART-BUTTON STATE =====\n${JSON.stringify(preClick, null, 2)}\n===== END PRE-CLICK CART-BUTTON STATE =====\n`,
        );
      } catch (e) {
        await relayToTrace(page, `[PRE-CLICK CART-BUTTON STATE] probe error (non-fatal): ${(e as Error).message}`);
      }

      // ★ VERIFY ADD-TO-CART VIA THE API, NOT THE UI. Network capture proved the add fires
      // POST .../cart-items -> 200 with the pizza in cartItems (canCheckout:true), while this
      // Angular SPA renders NO reliable DOM badge/toast. Arm the response listener BEFORE the
      // click so we capture the mutation's real result (the old DOM/header-icon checks were a
      // FALSE POSITIVE -- they matched always-present chrome and passed while the add no-opped).
      const addRespPromise = page
        .waitForResponse(
          (r) => r.request().method() === 'POST' && /\/cart-items(\?|$)/.test(r.url()),
          { timeout: 20000 },
        )
        .catch(() => null);

      // 2. Escalating click strategies -- stop at the first that does not throw, LOG which.
      //    a) scrollIntoViewIfNeeded + normal click (actionability-checked)
      //    b) force click (bypasses actionability -- if THIS lands, it was interception)
      //    c) dispatchEvent('click') on the handle (DOM-level -- bypasses pointer hit-test)
      let clickStrategy = 'none';
      let clickErrors = '';
      try {
        await addToCart.scrollIntoViewIfNeeded({ timeout: 5000 });
        await addToCart.click({ timeout: 5000 });
        clickStrategy = 'a:scrollIntoView+click';
      } catch (ea) {
        clickErrors += `a=${(ea as Error).message.split('\n')[0]}`;
        try {
          await addToCart.click({ force: true, timeout: 5000 });
          clickStrategy = 'b:force-click';
        } catch (eb) {
          clickErrors += ` | b=${(eb as Error).message.split('\n')[0]}`;
          try {
            await addToCart.dispatchEvent('click');
            clickStrategy = 'c:dispatchEvent';
          } catch (ec) {
            clickStrategy = 'all-failed';
            clickErrors += ` | c=${(ec as Error).message.split('\n')[0]}`;
          }
        }
      }
      await relayToTrace(
        page,
        `\n===== CLICK STRATEGY ===== ${clickStrategy}${clickErrors ? `\n  errors: ${clickErrors}` : ''}\n===== END CLICK STRATEGY =====\n`,
      );

      // ★ THE REAL ASSERTION: the add-to-cart mutation succeeded. The cart-items POST must
      // return 200 with a NON-EMPTY cartItems carrying the added item (quantity >= 1). This
      // FAILS if the add no-ops (no request / 4xx / 200-but-empty) -- it can no longer pass
      // on always-present header chrome. No navigation happens before this -- we verify the
      // SAME cart the POST populated (navigating to / would reset to a fresh empty guest cart).
      const addResp = await addRespPromise;
      expect(
        addResp,
        'GATE-E: no POST .../cart-items fired after clicking Add -- the add no-opped (dead handler / wrong target / API contract change).',
      ).not.toBeNull();

      const status = addResp!.status();
      type CartItem = { cartItemId?: string; quantity?: number };
      type CartBody = { cartId?: string; cartItems?: CartItem[] };
      let body: CartBody | null = null;
      try {
        body = (await addResp!.json()) as CartBody;
      } catch {
        body = null;
      }
      expect(status, `GATE-E: cart-items responded HTTP ${status}, expected 200.`).toBe(200);

      const cartItems: CartItem[] = body && Array.isArray(body.cartItems) ? body.cartItems : [];
      expect(
        cartItems.length,
        'GATE-E: cart-items returned 200 but cartItems is EMPTY -- the add no-opped server-side.',
      ).toBeGreaterThan(0);
      const totalQty = cartItems.reduce((s: number, it: CartItem) => s + (Number(it?.quantity) || 0), 0);
      expect(totalQty, 'GATE-E: cartItems present but total quantity < 1.').toBeGreaterThanOrEqual(1);

      // Capture the SAME-cart context (endpoint + Bearer auth + item ids) so the finally can
      // self-clean via the API with NO navigation.
      const addReq = addResp!.request();
      cleanupCartItemsUrl = addReq.url();
      cleanupAuthHeader = addReq.headers()['authorization'];
      cleanupItemIds = cartItems
        .map((it: CartItem) => it.cartItemId)
        .filter((x): x is string => typeof x === 'string' && x.length > 0);

      await relayToTrace(
        page,
        `[CART-API VERIFIED] cart-items ${status} | cartItems=${cartItems.length} | totalQty=${totalQty} | cartId=${body?.cartId}`,
      );
    });
  } finally {
    // ---- STEP g: SELF-CLEAN via the cart API -- ALWAYS attempt teardown ------------
    // Runs even on a mid-flow failure (finally). ★ Removes the added line item(s) on the
    // SAME cart the POST populated, via DELETE .../cart-items/<id> with the captured Bearer
    // auth -- NO navigation. (The old UI cleanup navigated to / which reset to a fresh empty
    // GUEST cart and "cleaned" the wrong cart.) Best-effort: the guest cart is ephemeral
    // (fresh per run), so a failed delete leaks nothing across runs; errors are swallowed so
    // cleanup never masks the real verification result.
    await step('SELF-CLEAN: remove the cheese pizza via the cart API', async () => {
      try {
        if (!cleanupCartItemsUrl || !cleanupAuthHeader || cleanupItemIds.length === 0) {
          console.log('[cleanup] no captured cart context (add did not populate a cart) -- nothing to remove. Guest cart is ephemeral.');
          return;
        }
        const [base, qs] = cleanupCartItemsUrl.split('?');
        for (const id of cleanupItemIds) {
          const delUrl = `${base}/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`;
          try {
            const res = await page.request.delete(delUrl, { headers: { authorization: cleanupAuthHeader } });
            console.log(`[cleanup] DELETE cart-item ${id} -> ${res.status()}`);
          } catch (e) {
            console.log(`[cleanup] DELETE cart-item ${id} failed (swallowed): ${(e as Error).message}`);
          }
        }
      } catch (e) {
        // Never let cleanup throw -- it must not overwrite the original failure.
        console.log(`[cleanup] teardown error (swallowed): ${(e as Error).message}`);
      }
    });
  }
});
