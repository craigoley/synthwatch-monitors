import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: nextdoor-homepage
 *
 * Journey: wegmansnextdoor.com -> assert the LOCATION PICKER renders both locations.
 *
 * Next Door by Wegmans (sushi/Japanese) operates two locations, and its homepage's core
 * job is to let a guest CHOOSE one. The homepage is a location picker with two
 * server-rendered links: /rochester-new-york/ and /astor-place-new-york/.
 *
 * ★ GROUND TRUTH (recon 2026-06-30): the mega-menu nav is JS-hydrated and FLAKY HEADLESS
 * (it did not populate within 5s), but the two location links ARE in the server-rendered
 * HTML. So we assert the SERVER-RENDERED location links, NOT the mega-menu.
 *
 * MUST-GO-RED: if the picker fails to render either location link, a guest can't choose a
 * location (the homepage's core function) -> RED. B10: sensitive=false (anon marketing
 * page; no auth/token/cookie -- verified by network capture).
 */
test('Next Door: homepage location picker renders both locations', async ({ page }) => {
  await step('open the Next Door homepage', async () => {
    await page.goto('https://www.wegmansnextdoor.com/', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert both location links are present', async () => {
    // CAPABILITY: the location picker offers BOTH locations (server-rendered hrefs, not the
    // flaky mega-menu). Either missing = the homepage can't do its one job -> RED.
    // The href matches MANY copies (mega-menu, footer, body) -- most hidden. Filter to the
    // VISIBLE picker button before .first() (the #19 duplicate-element lesson) so we assert
    // the real, user-clickable location choice, not a hidden DOM copy.
    await expect(
      page.locator('a[href*="rochester-new-york"]').filter({ visible: true }).first(),
      'Next Door homepage: the Rochester location link is missing -- the location picker is broken.',
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('a[href*="astor-place"]').filter({ visible: true }).first(),
      'Next Door homepage: the Astor Place location link is missing -- the location picker is broken.',
    ).toBeVisible({ timeout: 15000 });
  });
});
