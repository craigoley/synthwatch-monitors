import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-search-product
 *
 * Journey: go to wegmans.com -> search "ginger sparkling water" -> open the
 * Wegmans-brand ginger sparkling water product -> assert the product page loads.
 *
 * NOTE (selectors): the locators below are RESILIENT GUESSES based on a typical
 * commercetools/MACH storefront. They MUST be verified against the live site on
 * first run -- wegmans.com's actual search input, result-card, and product-page
 * structure may differ. When SynthWatch runs this the first time, if a step
 * fails, the trace + screenshot show the real DOM; update the locator to match.
 * Do NOT assume these are correct until a real run confirms them.
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
    // Stable signals: a product URL shape AND the product title visible.
    // Verify the real product URL pattern on first run and tighten this regex.
    await assertLoaded(page, {
      urlPattern: /\/product\//i,
      visibleText: /ginger.*sparkling/i,
      timeoutMs: 15000,
    });
  });
});
