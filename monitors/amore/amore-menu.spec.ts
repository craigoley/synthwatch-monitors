import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: amore-menu
 *
 * Journey: wegmansamore.com/menus -> assert the menu is reachable (a downloadable menu).
 *
 * "View the menu" is a core marketing-site capability. The /menus/ page renders the menu
 * as on-page HTML sections AND offers downloadable PDFs.
 *
 * ★ GROUND TRUTH (recon 2026-06-30): /menus/ exposes PDF menu downloads, e.g.
 * <a href="/wp-content/uploads/.../Amore-Dinner-Menu.pdf">Download Food Menu PDF</a>
 * (also Dessert/Beverages PDFs). We assert the downloadable-menu AFFORDANCE rather than
 * any specific dish/price (menu CONTENT changes; the capability does not).
 *
 * MUST-GO-RED: if /menus/ 404s or the menu links vanish, no PDF menu link is visible -> RED.
 * B10: sensitive=false (static marketing page; no auth/token/cookie -- verified).
 */
test('Amore: menu page exposes a downloadable menu', async ({ page }) => {
  await step('open the menu page', async () => {
    await page.goto('https://wegmansamore.com/menus/', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert a downloadable menu PDF is present', async () => {
    // ★ STRICT — the assertion must be ABSENT ON FAILURE. Match ONLY a menu PDF link:
    // a[href$=".pdf"][href*="Menu" i]. If every menu PDF vanishes, this has no match -> RED.
    // (VERIFIED live 2026-07-13: 8 menu PDFs on /menus/, all .pdf with "Menu" in the href —
    // Amore-Dinner-Menu.pdf / Amore-Dessert-Menu.pdf / Amore-Beverages-Menu.pdf.)
    // ★ REMOVED a lenient `getByRole('link', {name:/(download|view).*menu/i})` fallback: that could
    // match a PERSISTENT nav "View Menu" element and stay GREEN even if every PDF were removed (the
    // check-223 assert-chrome trap). A strict assertion that reds honestly beats a lenient one that lies.
    const menuLink = page.locator('a[href$=".pdf"][href*="Menu" i]').first();
    await expect(
      menuLink,
      'Amore menu: no downloadable menu PDF (a[href$=".pdf"][href*="Menu"], e.g. Amore-Dinner-Menu.pdf) on /menus/ -- the menu PDFs are gone or the page is broken.',
    ).toBeVisible({ timeout: 15000 });
  });
});
