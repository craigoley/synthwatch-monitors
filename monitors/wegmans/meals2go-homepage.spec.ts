import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-meals2go-homepage
 *
 * Journey: meals2go.com → assert the homepage's first-party bootstrap succeeds → assert the
 * ordering-entry UI rendered. Meals 2 Go is Wegmans' order-ahead platform (separate domain:
 * meals2go.com) with its own frontend + backend — a wegmans.com outage may not take it down and
 * vice versa. This is the "is Meals 2 Go up?" signal that gates all ordering flows.
 *
 * ★ MUST-GO-RED — NETWORK-ANCHORED (recon 2026-07-01, live network capture). The old assertion
 * was a broad visibleText match (/meals 2 go|wegmans|order/i) + a generic ordering link. Both
 * matched always-present chrome/footer copy, so a degraded/wrong page could still satisfy them —
 * the monitor could not reliably go red (a false-positive risk sitting live in prod). Replaced with
 * a REAL capability signal: the homepage's first-party app-config bootstrap.
 *
 * On every healthy load the SPA calls its own API gateway to bootstrap — captured live (all 200):
 *   GET wegapi.azure-api.net/app-config/client/kv?key=servicedisruptioncheck,... (the app's config
 *       bootstrap — anchored here), plus location/locations, guest-idp/token, order-capture/*.
 * We anchor on the app-config call: it's FIRST-PARTY (Wegmans' gateway, not a third-party transport
 * we don't control — Adobe/FB/LaunchDarkly/Dynatrace etc. are deliberately NOT used), it fires on
 * every functional load, uses the oldest/most-stable api-version, and is the app checking its own
 * service status — exactly the "the platform backend is serving" signal an uptime monitor wants.
 *
 * waitForResponse (not waitForRequest): the recon confirmed this response is reliably observable
 * headless with status 200 (unlike the OpenTable loader, which errors on response headless). So we
 * assert the backend actually RESPONDED 200 — a stronger signal than the request merely firing
 * (mirrors meals2go-browse-menu + search-autocomplete).
 *
 * RED CONDITION (what a real failure looks like → what the red-test drives): the app-config
 * bootstrap absent or non-200 (backend down / platform outage) → the waitForResponse(200) resolves
 * null → RED. Verified by routing that one call to a 500 (scoped to the API, NOT the main document,
 * so the deploy-marker capture that rides page.content()/main-doc headers is undisturbed).
 *
 * sensitive=false is correct: anonymous/accountless public page; the guest Bearer it carries is a
 * short-lived guest session token that protects nothing (guest-Bearer ≠ sensitive policy).
 */
const BOOTSTRAP_API = /wegapi\.azure-api\.net\/app-config\/client\/kv/i;
const BOOTSTRAP_WAIT_MS = 30_000;

test('Meals 2 Go: homepage loads', async ({ page }) => {
  // Arm the bootstrap-API wait BEFORE navigation — it fires during the page's JS bootstrap. The
  // predicate REQUIRES a 200; a non-200 (or no call) leaves this null → RED.
  const bootstrapRespPromise = page
    .waitForResponse((r) => BOOTSTRAP_API.test(r.url()) && r.status() === 200, { timeout: BOOTSTRAP_WAIT_MS })
    .catch(() => null);

  await step('open meals2go.com', async () => {
    await page.goto('https://www.meals2go.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert the homepage bootstrapped (first-party app-config API 200)', async () => {
    // THE MUST-GO-RED ANCHOR: the meals2go platform backend served the app's config bootstrap.
    const resp = await bootstrapRespPromise;
    if (!resp) {
      throw new Error(
        `Meals 2 Go homepage: the first-party app-config bootstrap ` +
          `(wegapi.azure-api.net/app-config/client/kv) did not return 200 within ${BOOTSTRAP_WAIT_MS / 1000}s — ` +
          `the Meals 2 Go platform backend is down or the homepage failed to initialize.`,
      );
    }
  });

  await step('assert the homepage rendered its ordering entry points', async () => {
    // Complementary DOM capability (catches "backend 200 but UI didn't render"): the homepage
    // renders menu-navigation cards linking to /browse-menu (takeout/catering/etc.). Specific +
    // functional — absent on a blank/error render — NOT broad chrome or marketing copy. Visible-
    // filtered before .first() so a hidden DOM copy can't satisfy it (the duplicate-element lesson).
    await expect(
      page.locator('a[href*="/browse-menu"]').filter({ visible: true }).first(),
      'Meals 2 Go homepage: no menu-navigation card (a[href*="/browse-menu"]) rendered — the homepage UI did not load its ordering entry points.',
    ).toBeVisible({ timeout: 15000 });
  });
});
