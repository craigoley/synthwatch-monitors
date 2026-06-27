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
    // ANY ginger-sparkling-water result (resilient to reorder / brand changes), not one specific
    // product. .first() takes the top result.
    const product = page
      .getByRole('link', { name: /ginger.*sparkling/i })
      .or(page.getByText(/ginger.*sparkling/i))
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
