import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: meals2go-browse-menu
 *
 * Journey: meals2go.com/browse-menu/pizza-wings -> assert the menu loads (the anonymous
 * DISCOVERY journey: browse a cuisine -> see its menu items). NEVER adds to cart.
 *
 * Distinct from meals2go-homepage (landing only) and meals2go-cheese-pizza-cart (the heavy
 * cart-mutating carryout flow). This is the lightweight anonymous "view a menu" capability.
 *
 * ★★ B10 = TRUE (the recon's headline finding). Even ANONYMOUS browse carries a guest
 * Authorization:Bearer token on every wegapi call (12 captured on this page). A non-sensitive
 * monitor's success-baseline + failure trace zips capture request HEADERS -> the guest Bearer
 * would leak (the exact meals2go-cart vector). The "anonymous => sensitive=false" heuristic
 * does NOT hold for meals2go. This monitor is sensitive=true with Bearer/JWT redact_patterns
 * (mirroring meals2go-cheese-pizza-cart) FROM DAY ONE. ★ On activation, the DB check MUST be
 * materialized WITH sensitive=true (the manifest flag is not the enforcement point -- the
 * meals2go-cart lesson: a window where manifest=true but DB=false leaked).
 *
 * ★ GROUND TRUTH (recon 2026-06-30): /browse-menu/pizza-wings fetches its menu via
 * GET wegapi.azure-api.net/kitting/stores/16/storefronts/1/menus -> 200 (store 16 is the
 * auto-selected default -- no store-select gauntlet for browse), and renders item cards as
 * button.menu-card-link (62 cards / 58 priced items observed). The menus-API response is
 * reliable (200), so waitForResponse is appropriate.
 *
 * MUST-GO-RED: if browse fires no menus API 200 OR renders no item cards, the discovery
 * journey is broken -> RED.
 */
const MENUS_API = /wegapi\.azure-api\.net\/kitting\/.*\/menus/i;
const MENUS_WAIT_MS = 30_000;

test('Meals2Go: browse a cuisine menu (anon)', async ({ page }) => {
  // Arm the menus-API wait BEFORE navigation -- the menu content load fires during page JS.
  const menusRespPromise = page
    .waitForResponse((r) => MENUS_API.test(r.url()) && r.status() === 200, { timeout: MENUS_WAIT_MS })
    .catch(() => null);

  await step('open the Pizza & Wings browse menu', async () => {
    await page.goto('https://www.meals2go.com/browse-menu/pizza-wings', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert the menu API loaded the menu', async () => {
    // Signal 1 (network): the kitting menus API returned 200. If the default store's menu
    // can't load, this is null -> RED.
    const menusResp = await menusRespPromise;
    if (!menusResp) {
      throw new Error(
        `Meals2Go browse: the menus API (wegapi.azure-api.net/kitting/.../menus) did not return ` +
          `200 within ${MENUS_WAIT_MS / 1000}s -- the menu discovery journey is broken (NEVER carts).`,
      );
    }
  });

  await step('assert menu item cards rendered', async () => {
    // Signal 2 (DOM capability): the menu rendered orderable item cards (resilient to which
    // dishes/prices -- not a specific item). NEVER clicks/adds.
    await expect(
      page.locator('button.menu-card-link').first(),
      'Meals2Go browse: menus API returned 200 but no menu item cards (button.menu-card-link) rendered.',
    ).toBeVisible({ timeout: 15000 });
  });
});
