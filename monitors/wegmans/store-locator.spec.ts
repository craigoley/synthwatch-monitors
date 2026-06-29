import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-store-locator
 *
 * Journey: wegmans.com/stores (the store DIRECTORY) → open a Buffalo-area store →
 * assert the store DETAIL page loaded.
 *
 * The store locator is critical for an omnichannel grocer — it drives foot traffic,
 * and the store-selection flow gates other features (pickup, Meals 2 Go ordering).
 *
 * ★ LIVE-DOM RECON (fixed a FALSE POSITIVE): /stores is a static DIRECTORY of store
 * links (<a href="/stores/<slug>">Store Name</a>, e.g. "Alberta Dr." → /stores/
 * alberta-dr-ny — 115 stores, 9 Buffalo-area). It is NOT a search-box + results page:
 * the only input is the GLOBAL header search (#site-header-search-input,
 * placeholder "What can we help you find?"), so the old "fill Buffalo, NY + Enter"
 * did a SITE search, not a store search. And the old assertion
 * getByText(/wegmans|store|miles?|mi/i) matched header/footer CHROME on every page
 * (10 matches BEFORE any search) → it passed regardless of the search and could NOT
 * go red. Now we assert the REAL capability, scoped to real store links + the store-
 * detail page (NOT page-wide text), so a broken directory/navigation FAILS.
 */
test('Wegmans: store directory -> open a Buffalo-area store detail', async ({ page }) => {
  await step('open the store directory', async () => {
    await page.goto('https://www.wegmans.com/stores', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert the directory lists a Buffalo-area store', async () => {
    await dismissInterstitials(page);
    // REAL capability (NOT page-wide chrome): the directory renders specific store links
    // <a href="/stores/<slug>">. Scope to a Buffalo-area store so this proves the directory
    // actually rendered store content — absent on a broken/empty directory or a CDN error page.
    const buffaloStore = page
      .locator('a[href^="/stores/"]')
      .filter({ hasText: /alberta|amherst|mckinley|sheridan|transit|dick rd|losson|west seneca|hamburg|niagara/i })
      .first();
    await expect(
      buffaloStore,
      'store directory did not render a Buffalo-area store link (a[href^="/stores/"]) -- the directory may be broken.',
    ).toBeVisible({ timeout: 15000 });
  });

  await step('open a Buffalo-area store from the directory', async () => {
    await dismissInterstitials(page);
    const buffaloStore = page
      .locator('a[href^="/stores/"]')
      .filter({ hasText: /alberta|amherst|mckinley|sheridan|transit|dick rd|losson|west seneca|hamburg|niagara/i })
      .first();
    await buffaloStore.click();
  });

  await step('assert the store detail page loaded', async () => {
    await dismissInterstitials(page);
    // VERIFIED (live recon): a store detail lives at /stores/<slug> (e.g. /stores/alberta-dr-ny)
    // and renders a store-specific "Set as my store" CTA + an address. The URL pattern
    // distinguishes a real store page from the /stores directory, so a skipped/failed click
    // (URL stays /stores) FAILS this gate -- the must-go-red anchor (mirrors recipe-search).
    await assertLoaded(page, {
      urlPattern: /\/stores\/[a-z][a-z0-9-]+/i,
      timeoutMs: 15000,
    });
    // A store-DETAIL-only signal (absent on the directory + on chrome): the "Set as my store"
    // CTA, or the store address. Scoped to the detail, not page-wide text.
    await expect(
      page
        .getByRole('button', { name: /set as my store|shop this store|make this/i })
        .or(page.getByRole('link', { name: /set as my store|shop this store|make this/i }))
        .or(page.locator('address, [class*="address" i]'))
        .first(),
      'store detail did not render a store-specific signal (Set as my store / address).',
    ).toBeVisible({ timeout: 15000 });
  });
});
