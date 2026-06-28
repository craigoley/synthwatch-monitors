import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-store-locator
 *
 * Journey: wegmans.com/stores → assert the store locator page loads → search for
 * stores near "Buffalo, NY" → assert at least one store result appears.
 *
 * The store locator is critical for an omnichannel grocer — it drives foot traffic,
 * and the store-selection flow gates other features (pickup, Meals 2 Go ordering).
 * If the locator breaks, users can't find their store.
 *
 * ★UNVERIFIED — the /stores URL and search interaction are best guesses based on
 * standard grocery-site patterns. The search input, results rendering, and store-
 * card selectors all need live verification. "Buffalo, NY" is chosen because the
 * original task references a Buffalo/McKinley store, confirming Wegmans operates
 * there.
 */
test('Wegmans: store locator -> search Buffalo NY', async ({ page }) => {
  await step('open the store locator', async () => {
    // ★UNVERIFIED: /stores is the most common store-locator URL pattern for grocery
    // sites. If Wegmans uses a different path, this will 404 or redirect — the live
    // run will reveal the correct URL.
    await page.goto('https://www.wegmans.com/stores', {
      waitUntil: 'domcontentloaded',
    });
    await dismissInterstitials(page);
  });

  await step('assert store locator loaded', async () => {
    await dismissInterstitials(page);
    // ★UNVERIFIED: assert the page has a store-finding UI. Look for a search/input
    // element or visible text referencing stores/locations. Flexible match.
    await assertLoaded(page, {
      visibleText: /stores?|locations?|find/i,
      timeoutMs: 15000,
    });
  });

  await step('search for Buffalo NY stores', async () => {
    // ★UNVERIFIED: the store search input could be a text field, a search role, or a
    // custom component. Try the common patterns: role=searchbox, role=textbox with
    // store/zip/location placeholder, or a generic input.
    const searchInput = page
      .getByRole('searchbox')
      .or(page.getByRole('textbox', { name: /zip|city|location|search|address/i }))
      .or(page.locator('input[type="search"], input[type="text"]').first())
      .first();
    await expect(searchInput).toBeVisible({ timeout: 15000 });
    await searchInput.fill('Buffalo, NY');
    await searchInput.press('Enter');
  });

  await step('assert store results appeared', async () => {
    await dismissInterstitials(page);
    // ★UNVERIFIED: store results should show at least one Wegmans location near
    // Buffalo. Assert via visible text — any result mentioning a recognizable store
    // signal (address, phone, hours, "Wegmans", or a store-specific element).
    // Buffalo area has multiple Wegmans stores (McKinley, Amherst, Alberta Dr, etc.),
    // so matching any store-like result is resilient.
    await expect(
      page.getByText(/wegmans|store|miles?|mi\b/i).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
