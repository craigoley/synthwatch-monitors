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

  await step('assert a downloadable menu link is present', async () => {
    // CAPABILITY (not content): a menu PDF is reachable. Match a .pdf link whose href
    // mentions "Menu", OR a link named like the menu-download affordance -- resilient to
    // the exact filename/date and to which menu (food/dessert/beverages).
    const menuLink = page
      .locator('a[href$=".pdf"][href*="Menu" i]')
      .or(page.getByRole('link', { name: /(download|view).*(food )?menu|food menu pdf|menu pdf/i }))
      .first();
    await expect(
      menuLink,
      'Amore menu: no downloadable menu link (a[href$=".pdf"] / "Download Food Menu PDF") on /menus/ -- the menu page is broken.',
    ).toBeVisible({ timeout: 15000 });
  });
});
