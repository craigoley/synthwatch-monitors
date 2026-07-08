import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-search-autocomplete
 *
 * Journey: wegmans.com -> type a partial query in the header search -> assert the Algolia
 * search-as-you-type SUGGESTIONS appear. Distinct, high-traffic capability that the
 * search-product spec deliberately bypasses (it goes straight to the results URL).
 *
 * ★★ NEVER PRESSES ENTER / NEVER SUBMITS. The old "waterloo" flake that made search-product
 * bypass the typeahead was a SUBMIT race: pressing Enter selected a highlighted suggestion
 * ("ginger sparkling waterloo") instead of the typed text. This monitor only TYPES and
 * asserts the suggestions dropdown -- it never submits, so that race cannot occur.
 *
 * ★ GROUND TRUTH (recon 2026-06-30): the header search is an Algolia Autocomplete widget
 * (input#site-header-search-input, role=searchbox; dropdown = [role="option"] items in
 * [role="listbox"]). Typing fires POST algolia.net/1/indexes/<index>/queries -> 200 (measured
 * reliable: 200 + 12 options on milk/banana/eggs across 3 runs). Unlike the OpenTable embed,
 * the RESPONSE is reliable here, so waitForResponse is appropriate.
 *
 * MUST-GO-RED: if typing fires no Algolia query (search-as-you-type backend down) OR the
 * dropdown renders no [role="option"] suggestions, the capability is broken -> RED.
 * B10: sensitive=false -- Algolia uses a public, search-only x-algolia-api-key (no
 * Authorization:Bearer, no PII; same backend as search-product/recipe-search, both
 * sensitive=false). Verified by network capture.
 */
const ALGOLIA_QUERIES = /algolia\.net\/1\/indexes\/.*\/queries/i;
const QUERY = 'milk';
const QUERY_WAIT_MS = 20_000;

test('Wegmans: search autocomplete suggestions', async ({ page }) => {
  // Arm the Algolia query-response wait BEFORE typing. The predicate requires a 200 -- a
  // non-200 (or no call) leaves this null -> RED. We assert the REQUEST fired AND succeeded.
  const queryRespPromise = page
    .waitForResponse((r) => ALGOLIA_QUERIES.test(r.url()) && r.status() === 200, { timeout: QUERY_WAIT_MS })
    .catch(() => null);

  await step('open wegmans.com', async () => {
    await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('type a partial query (no submit)', async () => {
    const box = page.locator('#site-header-search-input').first();
    await expect(box, 'header search box (#site-header-search-input) not found').toBeVisible({ timeout: 15000 });
    await box.click();
    // ★ TYPE only -- pressSequentially, NEVER .press('Enter'). No submit, no waterloo race.
    await box.pressSequentially(QUERY, { delay: 120 });
  });

  await step('assert Algolia returned suggestions', async () => {
    // Signal 1 (network): the search-as-you-type query fired and returned 200.
    const queryResp = await queryRespPromise;
    expect(
      queryResp,
      `Wegmans autocomplete: typing "${QUERY}" did not produce a 200 from the Algolia ` +
        `search-as-you-type query (algolia.net/1/indexes/*/queries) within ${QUERY_WAIT_MS / 1000}s -- ` +
        `the typeahead backend is down or the search box is broken.`,
    ).toBeTruthy();
    // Signal 2 (DOM): the suggestions dropdown actually rendered an option.
    await expect(
      page.getByRole('option').first(),
      'Wegmans autocomplete: Algolia returned 200 but no suggestion [role="option"] rendered.',
    ).toBeVisible({ timeout: 15000 });
  });
});
