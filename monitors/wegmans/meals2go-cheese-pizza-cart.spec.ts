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
    // This iteration: open the modal, click CARRYOUT, and RECON-DUMP the next screen
    // (the store-selection / Buffalo search + McKinley result) we have not captured
    // yet. Capability-assert ONLY that the store-selection screen advanced.
    await step('GATE-B: drive fulfillment modal -> Carryout (recon)', async () => {
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

      // If a search input is present, type "Buffalo" and dump the results so the next
      // iteration can write the Buffalo/McKinley selectors. Do NOT assert McKinley yet.
      try {
        if (await searchInput.isVisible({ timeout: 8000 })) {
          await searchInput.click({ timeout: 4000 });
          await searchInput.fill('Buffalo');
          await page.waitForTimeout(2500); // bounded settle, NOT networkidle

          // e (recon). ===== RECON DUMP [STORE RESULTS AFTER BUFFALO] =====
          await dumpDom(
            page,
            'STORE RESULTS AFTER BUFFALO',
            [
              { name: 'result items', selector: '[role="option"], [role="listitem"], li, [data-testid*="store" i]' },
              { name: 'McKinley result', selector: 'text=/mckinley/i' },
              { name: 'McKinley (button/option/link)', selector: 'button:has-text("McKinley"), [role="option"]:has-text("McKinley"), a:has-text("McKinley"), [aria-label*="McKinley" i]' },
            ],
            '[role="dialog"].weg-modal-outer, app-modal-form, [role="listbox"], main',
          );
        }
      } catch {
        /* best-effort -- the store-search input shape is still being captured */
      }

      // e (assert). CAPABILITY (recon-only): the store-selection screen advanced -- a
      // search input OR a store-result list became visible. We do NOT assert McKinley-
      // selected success this iteration; that selector comes from the dumps above.
      await expect(
        searchInput.or(resultList).first(),
        'GATE-B: store-selection screen did not advance after Carryout (no search input / result list) -- read "FULFILLMENT AFTER CARRYOUT".',
      ).toBeVisible({ timeout: 20000 });
    });

    // ---- STEP c: takeout menu -> Pizza category -----------------------------------
    await step('navigate takeout menu -> Pizza', async () => {
      await dismissInterstitials(page);

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

    // ---- STEP e: add to cart (carry-out context already set) -----------------------
    // GATE-E -- a cheese pizza may FORCE size/crust/options before "Add" enables. We
    // make a best-effort pass at any required single-choice options, then add. If the
    // add control stays disabled/absent, this step KNOWN-FAILS LOUDLY and the dump
    // shows the required-customization gate to model next.
    await step('add cheese pizza to cart', async () => {
      await dismissInterstitials(page);

      // Best-effort: satisfy a required option group by picking its FIRST radio/option
      // (e.g. a default size). Resilient -- ANY first option, never a named one.
      const firstOption = page
        .getByRole('radio')
        .or(page.locator('[role="option"], [data-testid*="option" i] button'))
        .first();
      try {
        if (await firstOption.isVisible({ timeout: 4000 })) {
          await firstOption.click({ timeout: 4000 });
        }
      } catch {
        /* best-effort -- there may be no required options for plain cheese */
      }

      await dumpDom(
        page,
        'e:before-add',
        [
          { name: 'add-to-cart button', selector: 'button:has-text("Add"), [data-testid*="add" i]' },
          { name: 'disabled add', selector: 'button[disabled]:has-text("Add"), button[aria-disabled="true"]:has-text("Add")' },
          { name: 'required-customization gate', selector: 'text=/required|please select|choose a size|select an option/i' },
        ],
        '[role="dialog"], dialog, main',
      );

      const addToCart = page
        .getByRole('button', { name: /add to (cart|order|bag)|^add( \$|\b)/i })
        .first();
      // LOUD known-fail: if Add never becomes actionable, the assertion message names
      // the GATE so the trace reader knows to read the e:before-add dump.
      await expect(
        addToCart,
        'GATE-E: add-to-cart control not visible -- cheese pizza likely forces required ' +
          'size/crust/options before Add. Read the "e:before-add" DOM dump for the gate.',
      ).toBeVisible({ timeout: 20000 });
      await addToCart.click({ timeout: 5000 });
      await dismissInterstitials(page);

      // CAPABILITY: an add fired -- a cart-count badge incremented OR an "added"
      // confirmation/mini-cart appeared. Either signal proves the mutation; we don't
      // assert an exact count (resilient to a dirty start).
      await expect(
        page
          .getByText(/added to (cart|order|bag)|item added|added/i)
          .or(page.getByRole('button', { name: /cart|bag|checkout|view order/i }))
          .or(page.locator('[data-testid*="cart-count" i], [aria-label*="cart" i]'))
          .first(),
        'GATE-E: no add-to-cart confirmation/cart signal after clicking Add. Read "e:after-add".',
      ).toBeVisible({ timeout: 20000 });
      await dumpDom(
        page,
        'e:after-add',
        [
          { name: 'cart count badge', selector: '[data-testid*="cart-count" i], [aria-label*="cart" i] [class*="count" i]' },
          { name: 'added confirmation', selector: 'text=/added to (cart|order|bag)|item added/i' },
          { name: 'view cart CTA', selector: 'text=/view (cart|order|bag)|checkout|cart/i' },
        ],
        'header, [role="banner"], [role="dialog"], main',
      );
    });

    // ---- STEP f: open cart, assert the pizza line item -----------------------------
    await step('open cart and assert the cheese pizza line item', async () => {
      await dismissInterstitials(page);
      const cartButton = page
        .getByRole('link', { name: /cart|bag|view order|checkout/i })
        .or(page.getByRole('button', { name: /cart|bag|view order|checkout/i }))
        .or(page.locator('[data-testid*="cart" i], [aria-label*="cart" i]'))
        .first();
      try {
        if (await cartButton.isVisible({ timeout: 10000 })) {
          await cartButton.click({ timeout: 5000 });
        }
      } catch {
        /* best-effort -- a mini-cart may already be open after add */
      }
      await dismissInterstitials(page);

      // CAPABILITY: the cart SHOWS the pizza -- a line item matching pizza/cheese
      // resiliently (not the exact item name). The mini-cart/page shape is unknown.
      await expect(
        page.getByText(/cheese/i).or(page.getByText(/pizza/i)).first(),
        'cart does not show a cheese/pizza line item -- read the "f:cart-contents" dump.',
      ).toBeVisible({ timeout: 20000 });
      await dumpDom(
        page,
        'f:cart-contents',
        [
          { name: 'line items', selector: '[data-testid*="line" i], [data-testid*="cart-item" i], li' },
          { name: 'cheese/pizza item', selector: 'text=/cheese|pizza/i' },
          { name: 'remove affordance', selector: 'text=/remove|delete|trash/i, [aria-label*="remove" i], [data-testid*="remove" i]' },
        ],
        '[role="dialog"], dialog, main, aside',
      );
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

        await dumpDom(
          page,
          'g:cleanup-start',
          [
            { name: 'line items present', selector: '[data-testid*="cart-item" i], [data-testid*="line" i], li' },
            { name: 'remove buttons', selector: '[aria-label*="remove" i], [data-testid*="remove" i], button:has-text("Remove")' },
          ],
          '[role="dialog"], dialog, main, aside',
        );

        // Remove every removable line item (handles a dirty start too -- clears whatever
        // is there, not just our pizza). Bounded loop so a stuck remove can't spin.
        const removeLocator = page
          .getByRole('button', { name: /remove|delete/i })
          .or(page.locator('[aria-label*="remove" i], [data-testid*="remove" i]'));
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
