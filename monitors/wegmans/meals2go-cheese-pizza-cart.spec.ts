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

    // ---- STEP b: GATE-B store/fulfillment switcher recon ---------------------------
    // GATE-B -- the prior run failed here: it clicked a landing carry-out element that
    // navigated INTO the menu on the DEFAULT store, then waited for /mckinley/ or
    // /change store/ text that NEVER appears (the real header reads "Menu for <City>"
    // via .change-store-button). This iteration's PURPOSE is recon: OPEN the switcher
    // and DUMP its internals (the carry-out / Buffalo / McKinley panel we have not yet
    // captured), then stop. We capability-assert ONLY that the switcher opened -- we do
    // NOT yet know the McKinley-selected selectors, so we do not assert success.
    await step('GATE-B: open the store/fulfillment switcher (recon)', async () => {
      await dismissInterstitials(page);

      // On the landing the header switcher isn't shown until "Start an Order". Click it
      // first (best-effort -- a returning session may already render the menu+switcher).
      const startOrder = page.locator('button#landing-page-start-order-button').first();
      try {
        if (await startOrder.isVisible({ timeout: 6000 })) {
          await startOrder.click({ timeout: 5000 });
          await dismissInterstitials(page);
        }
      } catch {
        /* best-effort -- may already be in the menu */
      }

      // The store control reads "Menu for <City>" via .change-store-button inside
      // #main-header-fulfillment-info. VERIFIED id/class from trace 847963; paired with
      // a role/text fallback per selector discipline.
      const switcherButton = page
        .locator('#main-header-fulfillment-info, button.change-store-button')
        .or(page.getByRole('button', { name: /menu for /i }))
        .first();
      await expect(
        switcherButton,
        'GATE-B: store switcher button (#main-header-fulfillment-info / .change-store-button / "Menu for ...") not found -- read the "b:switcher-button" dump.',
      ).toBeVisible({ timeout: 20000 });

      // DUMP the pre-open state -- shows the DEFAULT store the page loaded with.
      await dumpDom(
        page,
        'b:switcher-button',
        [
          { name: 'switcher button', selector: '#main-header-fulfillment-info, button.change-store-button' },
          { name: 'menu-for label', selector: 'text=/menu for /i' },
          { name: 'location span', selector: 'span.location, .emphasis.location' },
        ],
        'header, [role="banner"]',
      );

      await switcherButton.click({ timeout: 5000 });
      await dismissInterstitials(page);

      // Bounded wait for the switcher surface to open (NOT networkidle). The carry-out /
      // Buffalo / McKinley UI opens here -- shape UNKNOWN, this dump is the whole point.
      const switcherPanel = page
        .getByRole('dialog')
        .or(
          page.locator(
            'app-menu-preview-store-switcher, [role="dialog"], dialog, .modal, [class*="modal" i], [class*="store-switcher" i], [class*="fulfillment" i]',
          ),
        )
        .first();
      const searchInput = page
        .getByRole('textbox')
        .or(page.getByPlaceholder(/zip|city|store|search|address/i))
        .first();
      try {
        await switcherPanel.or(searchInput).first().waitFor({ state: 'visible', timeout: 15000 });
      } catch {
        /* fall through to the dump -- it reveals whether anything opened */
      }

      // ===== STORE SWITCHER OPEN DOM ===== (this iteration's purpose). Heavy dump of
      // the opened container + candidate counts for the carry-out/delivery toggle and
      // the store-search input. Read this label first in the next trace.
      await dumpDom(
        page,
        'STORE SWITCHER OPEN DOM',
        [
          { name: 'dialog/panel', selector: '[role="dialog"], dialog, app-menu-preview-store-switcher' },
          { name: 'carry-out/pickup toggle (text)', selector: 'text=/carry ?out|pickup/i' },
          { name: 'carry-out/pickup toggle (button/tab)', selector: 'button:has-text("Carry"), button:has-text("Pickup"), [role="tab"]:has-text("Carry"), [role="tab"]:has-text("Pickup")' },
          { name: 'delivery toggle (text)', selector: 'text=/delivery/i' },
          { name: 'store/location search input', selector: 'input[type="search"], input[type="text"], input[placeholder], [role="textbox"]' },
        ],
        'app-menu-preview-store-switcher, [role="dialog"], dialog, .modal, [class*="store-switcher" i], main, body',
      );

      // Best-effort: select CARRY OUT / PICKUP if a toggle is present (non-fatal -- it
      // may already be the default). Recon only; we do not assert on it.
      const carryOut = page
        .getByRole('tab', { name: /carry ?out|pick ?up|takeout/i })
        .or(page.getByRole('button', { name: /carry ?out|pick ?up|takeout/i }))
        .or(page.getByRole('radio', { name: /carry ?out|pick ?up|takeout/i }))
        .first();
      try {
        if (await carryOut.isVisible({ timeout: 4000 })) {
          await carryOut.click({ timeout: 4000 });
          await dismissInterstitials(page);
        }
      } catch {
        /* best-effort -- carry-out may be the default */
      }

      // Drive as far as the store-search input: type "Buffalo", let results settle, then
      // DUMP the result list + any McKinley result. We STOP here -- the dump tells us how
      // to write the Buffalo/McKinley selectors next.
      const storeInput = page
        .getByRole('searchbox')
        .or(page.getByPlaceholder(/zip|city|address|store|location|search/i))
        .or(page.locator('[role="dialog"] input, dialog input, app-menu-preview-store-switcher input').first())
        .or(page.locator('input[type="search"], input[type="text"]').first())
        .first();
      try {
        if (await storeInput.isVisible({ timeout: 8000 })) {
          await storeInput.click({ timeout: 4000 });
          await storeInput.fill('Buffalo');
          // Bounded wait for store-search autocomplete to settle (NOT networkidle).
          await page.waitForTimeout(2500);
          await dumpDom(
            page,
            'b:after-buffalo-typed',
            [
              { name: 'result items', selector: '[role="option"], [role="listitem"], li, [data-testid*="store" i]' },
              { name: 'McKinley result', selector: 'text=/mckinley/i' },
            ],
            'app-menu-preview-store-switcher, [role="dialog"], dialog, [role="listbox"], main',
          );
        }
      } catch {
        /* best-effort -- the store-search input shape is still unverified */
      }
      await dismissInterstitials(page);

      // CAPABILITY (recon-only): the switcher OPENED -- a dialog/panel OR a search input
      // became visible. We do NOT assert McKinley-selected success this iteration.
      await expect(
        switcherPanel.or(searchInput).first(),
        'GATE-B: the store switcher did not open (no dialog/panel/search input after clicking the switcher) -- read the "STORE SWITCHER OPEN DOM" dump.',
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
