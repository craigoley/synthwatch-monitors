import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-search-product
 *
 * Journey: go to wegmans.com -> search "ginger sparkling water" -> open the
 * Wegmans-brand ginger sparkling water product -> assert the product page loads.
 *
 * ★ FLAKE FIX (run #844766): the search box is Algolia Autocomplete, and typing "ginger
 * sparkling water" surfaced a highlighted SUGGESTION "ginger sparkling waterloo" (Waterloo
 * Sparkling is a brand). Pressing Enter submitted the HIGHLIGHTED SUGGESTION, not the typed
 * text — the trace showed /shop/search?query=ginger%20sparkling%20**waterloo** while the
 * (correct) recipes search used "…water". When the suggestion wasn't active at Enter-time it
 * searched "water" and passed; when it was, "waterloo" → no Wegmans ginger-sparkling product
 * → 15s timeout. That autocomplete race = the intermittent pass/fail.
 *
 * The fix navigates DIRECTLY to the results URL (/shop/search?query=…, verified status-200 in
 * the trace), bypassing the autocomplete dropdown entirely — deterministic, no suggestion race.
 * ★ TRADEOFF (flagged): this monitors the search RESULTS + the product detail page reliably,
 * but no longer exercises the search-BOX UX (the inherently racy Algolia autocomplete). For a
 * reliability monitor that's the right trade — the business signal is "the ginger-sparkling-water
 * product is reachable + its page loads", not "Algolia autocomplete submits deterministically".
 *
 * Product assertions match ANY ginger-sparkling-water result (not one specific product) — the
 * recurring resilience lesson: assert the CAPABILITY (a relevant product is reachable), resilient
 * to catalog reorder. Step 'assert' uses DOM signals (title + "Add to List" CTA), not a URL/price.
 *
 * ★ PRODUCT-CLICK FIX (run #845953): the open-product step targets the real product <a> by its
 * /shop/product/ href. The previous `.or(getByText(/ginger.*sparkling/i))` fallback matched an
 * invisible screen-reader label (<span class="tw:sr-only">) — un-clickable + under the sticky
 * header → pointer-intercept → 30s timeout. Anchoring on a[href*="/shop/product/"] hits the real,
 * clickable card. (The link is aria-haspopup="dialog" — clicking opens a quick-view on the
 * /shop/search URL, so the assert stays DOM-signal based, NOT a /shop/product/ URL check.)
 */
test('Wegmans: search -> ginger sparkling water product', async ({ page }) => {
  await step('open the ginger sparkling water search results', async () => {
    // Direct to the real results URL — bypasses the Algolia autocomplete suggestion race entirely
    // (the typed query, not a highlighted "waterloo" suggestion). Playwright encodes the spaces.
    await page.goto('https://www.wegmans.com/shop/search?query=ginger sparkling water', {
      waitUntil: 'domcontentloaded',
    });
    await dismissInterstitials(page);
  });

  await step('open the first ginger sparkling water product', async () => {
    await dismissInterstitials(page);
    // ★ Target the REAL product <a> by its /shop/product/ href — NOT getByText. The old
    // `.or(getByText(/ginger.*sparkling/i))` fallback matched an invisible a11y label
    // (<span class="tw:sr-only">Ginger sparkling water</span>), which is un-clickable and sits
    // under the sticky header → 'subtree intercepts pointer events' → 30s timeout (run #845953).
    // The result cards are clean links: <a class="tw:text-left" href="/shop/product/<id>-Ginger-
    // Sparkling-Water-…">. Scoping to a[href*="/shop/product/"] excludes the sr-only span (it's a
    // <span>, no href) AND gives a real, full-card click target the header can't intercept.
    // ANY ginger-sparkling result (resilient to reorder / SKU), .first() = the top one.
    const product = page
      .locator('a[href*="/shop/product/"]')
      .filter({ hasText: /ginger.*sparkling/i })
      .first();
    await expect(product).toBeVisible({ timeout: 15000 });
    await product.click();
  });

  await step('assert product page loaded', async () => {
    await dismissInterstitials(page);
    // Wegmans renders the product detail on the /shop/search?query=… URL (SPA — no /product/
    // route; verified from run #844486's trace). Assert the product DETAIL via DOM signals: a
    // ginger-sparkling product title + the "Add to List" CTA — resilient to which exact product,
    // price, or copy (no specific name / URL / price).
    await assertLoaded(page, {
      visibleText: /ginger.*sparkling/i,
      timeoutMs: 15000,
    });
    await expect(
      page.getByRole('button', { name: /add .*to list/i }).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
