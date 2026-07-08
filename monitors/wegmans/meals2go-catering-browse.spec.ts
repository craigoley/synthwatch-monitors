import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: meals2go-catering-browse
 *
 * Journey: meals2go.com/browse-catering/<slug> -> assert the CATERING menu loads (the anonymous
 * catering DISCOVERY journey: browse a catering cuisine -> see its orderable catering items).
 * NEVER adds to cart.
 *
 * Distinct from meals2go-browse-menu (the everyday takeout menu) by the CATERING backend surface:
 * the kitting menus request carries catering=true, which returns the catering menu tree (a different
 * payload/journey than browse-menu's non-catering menus call). This monitors the catering ordering
 * funnel's entry — high-ticket revenue that browse-menu does NOT touch.
 *
 * SENSITIVITY: non-sensitive (sensitive=false), same rationale as meals2go-browse-menu. Anonymous,
 * accountless flow against a public page -- no login, password, payment, or PII. The page carries a
 * short-lived guest Authorization:Bearer on wegapi calls, but that guest session token protects
 * nothing, so redacting it buys no real protection. (If a future variant logs in / carries account
 * or payment data, THAT variant must be sensitive=true with redact_patterns.)
 *
 * ★ GROUND TRUTH (live recon 2026-07-02, recorded in scratch/live-recon-G1-G6.md, residential-IP run):
 * /browse-catering/custom-cakes?cuisine=1985 -> 200, AUTO-SELECTS a default store (store 16 observed --
 * "Menu for Fairfax"; NO store-selection gauntlet, same as browse-menu), fires
 * GET wegapi.azure-api.net/kitting/stores/<id>/storefronts/1/menus?catering=true&radius=standard -> 200,
 * and renders orderable item cards as button.menu-card-link (19 priced cards observed). The menus-API
 * response is reliable (200), so waitForResponse is appropriate (mirrors browse-menu).
 *
 * ★ ANCHOR IS STORE-AGNOSTIC: the recon flagged the auto-selected store (16/Fairfax) is geo/IP-derived
 * and NOT guaranteed stable, so the network anchor pattern-matches the kitting menus?catering=true URL
 * WITHOUT hardcoding store 16, and the DOM assertion is card-count (>0), NOT a specific dish/store.
 *
 * ★ ENTRY-SLUG RISK (diagnose honestly): the direct entry slug (browse-catering/custom-cakes?cuisine=1985)
 * is the SAME slug-stability risk class as browse-menu's direct /browse-menu/pizza-wings URL -- acceptable
 * per house convention (direct-URL entry = deterministic, no nav race). If this ever 404s / stops firing
 * the catering menus call, suspect ENTRY-ROT (the slug/cuisine id was restructured) FIRST -- re-derive a
 * live catering slug from meals2go.com/browse-catering -- BEFORE concluding the catering backend is down.
 *
 * MUST-GO-RED: if browse fires no catering menus API 200 OR renders no item cards, the catering
 * discovery journey is broken -> RED.
 */
const CATERING_MENUS_API = /wegapi\.azure-api\.net\/kitting\/.*\/menus\?[^"']*catering=true/i;
const MENUS_WAIT_MS = 30_000;
const ENTRY_URL = 'https://www.meals2go.com/browse-catering/custom-cakes?cuisine=1985';

test('Meals2Go: browse a catering menu (anon)', async ({ page }) => {
  // Arm the catering-menus-API wait BEFORE navigation -- the menu content load fires during page JS.
  // The predicate REQUIRES a 200; a non-200 (or no call) leaves this null -> RED.
  const menusRespPromise = page
    .waitForResponse((r) => CATERING_MENUS_API.test(r.url()) && r.status() === 200, { timeout: MENUS_WAIT_MS })
    .catch(() => null);

  await step('open the Custom Cakes catering menu', async () => {
    await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert the catering menus API loaded the menu', async () => {
    // Signal 1 (network): the kitting menus API with catering=true returned 200. If the auto-selected
    // store's catering menu can't load, this is null -> RED. Store-agnostic (no hardcoded store id).
    const menusResp = await menusRespPromise;
    expect(
      menusResp,
      `Meals2Go catering browse: the catering menus API (wegapi.azure-api.net/kitting/.../menus?catering=true) ` +
        `did not return 200 within ${MENUS_WAIT_MS / 1000}s -- the catering discovery journey is broken, ` +
        `OR the entry slug (${ENTRY_URL}) has rotted (re-derive a live catering slug). NEVER carts.`,
    ).toBeTruthy();
  });

  await step('assert catering item cards rendered', async () => {
    // Signal 2 (DOM capability): the catering menu rendered orderable item cards (resilient to which
    // dishes/prices -- not a specific item). Visible-filtered before .first() so a hidden DOM copy can't
    // satisfy it. NEVER clicks/adds.
    await expect(
      page.locator('button.menu-card-link').filter({ visible: true }).first(),
      'Meals2Go catering browse: catering menus API returned 200 but no menu item cards (button.menu-card-link) rendered.',
    ).toBeVisible({ timeout: 15000 });
  });
});
