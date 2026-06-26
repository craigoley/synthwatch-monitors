import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-search-product
 *
 * Journey: go to wegmans.com -> search "ginger sparkling water" -> open the
 * Wegmans-brand ginger sparkling water product -> assert the product page loads.
 *
 * NOTE (selectors): VERIFIED against run #844486's trace on the live site.
 * Steps 1-3 (open wegmans.com / search / open the product) pass with the locators
 * below. Step 4 originally asserted a `/\/product\//i` URL, but Wegmans is an SPA:
 * opening a product does NOT navigate to a /product/ route -- the product detail
 * renders on the same `/shop/search?query=…` URL (the trace captured no /product/
 * navigation), so that URL check could never match even though the product page
 * was correctly loaded. Step 4 now asserts the product DETAIL via DOM signals the
 * trace confirms (the product title + the "Add to List" CTA) -- resilient to
 * price/copy/URL changes. If a step fails, the trace + screenshot show the real
 * DOM; update the locator to match.
 */
test('Wegmans: search -> ginger sparkling water product', async ({ page }) => {
  await step('open wegmans.com', async () => {
    await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('search ginger sparkling water', async () => {
    // Resilient: find the search box by role/placeholder rather than a CSS id.
    const search = page
      .getByRole('searchbox')
      .or(page.getByPlaceholder(/search/i))
      .first();
    await expect(search).toBeVisible({ timeout: 15000 });
    await search.fill('ginger sparkling water');
    await search.press('Enter');
  });

  await step('open the Wegmans ginger sparkling water product', async () => {
    await dismissInterstitials(page);
    // Prefer the Wegmans-brand result. Match a product link/card by visible text.
    // .first() guards against multiple matches; refine after a real run if it
    // grabs the wrong item.
    const product = page
      .getByRole('link', { name: /wegmans .*ginger.*sparkling/i })
      .or(page.getByText(/wegmans .*ginger.*sparkling/i))
      .first();
    await expect(product).toBeVisible({ timeout: 15000 });
    await product.click();
  });

  await step('assert product page loaded', async () => {
    await dismissInterstitials(page);
    // Wegmans renders the product detail on the /shop/search?query=… URL (SPA — no /product/
    // route; verified from run #844486's trace). Assert the product DETAIL via DOM signals the
    // trace confirms are present: the product title heading, plus the "Add to List" CTA (the
    // product-detail action — resilient to price/copy changes, unlike a URL or a hard-coded price).
    await assertLoaded(page, {
      visibleText: /wegmans ginger sparkling water/i,
      timeoutMs: 15000,
    });
    await expect(
      page.getByRole('button', { name: /add .*to list/i }).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
