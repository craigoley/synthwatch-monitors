import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: nextdoor-reservations
 *
 * Journey: wegmansnextdoor.com/rochester-new-york/reservations -> assert the OpenTable
 * booking widget LOADS.
 *
 * ★ MIRRORS amore-reservations.spec.ts EXACTLY (same OpenTable embed pattern) -- only the
 * rid, URL, and heading copy differ. Keep the two in sync: an OpenTable-pattern change
 * (e.g. the loader URL shape) must update BOTH specs together.
 *
 * Next Door (sushi/Japanese, Rochester) takes reservations via an EMBEDDED OpenTable
 * widget (rid=2407). The business-critical capability is "a guest can reach the booking
 * widget" -- this monitor NEVER books and NEVER submits anything.
 *
 * ★ GROUND TRUTH (recon #2, 2026-06-30): loading /rochester-new-york/reservations/ fires
 * the OpenTable widget loader REQUEST: GET
 * https://www.opentable.com/widget/reservation/loader?rid=2407 (the embed bootstraps the
 * iframe from this). Two flaky signals we deliberately AVOID (confirmed identical to Amore):
 *   - the OpenTable <iframe> does NOT reliably inject headless, and
 *   - the loader RESPONSE fails headless with net::ERR_HTTP2_PROTOCOL_ERROR (an environment
 *     artifact, not a site failure) -- so waitForResponse never resolves.
 * The reliably-observable capability is the loader REQUEST FIRING: it proves the page wires
 * up the OpenTable booking embed (rid=2407). We assert that + the "Reserve Your Table"
 * heading. (We verify the embed is WIRED, not OpenTable's CDN uptime -- and we never book.)
 *
 * MUST-GO-RED: if /reservations/ breaks OR the OpenTable embed is removed, the loader
 * request never fires -> waitForRequest times out (null) -> RED. B10: sensitive=false
 * (no auth/token/cookie -- the rid is a public restaurant id; verified by network capture).
 */
const OPENTABLE_LOADER = /opentable\.com\/widget\/reservation\/loader/i;
const LOADER_WAIT_MS = 30_000;

test('Next Door: reservations OpenTable widget loads', async ({ page }) => {
  // Arm the REQUEST wait BEFORE navigation so the loader request (fired during page JS
  // bootstrap) is captured. We wait on the request, NOT the response: the OpenTable CDN
  // response errors out headless (ERR_HTTP2_PROTOCOL_ERROR), so the request firing is the
  // reliable, portable capability signal.
  const loaderReqPromise = page
    .waitForRequest((r) => OPENTABLE_LOADER.test(r.url()), { timeout: LOADER_WAIT_MS })
    .catch(() => null);

  await step('open the reservations page', async () => {
    await page.goto('https://www.wegmansnextdoor.com/rochester-new-york/reservations/', {
      waitUntil: 'domcontentloaded',
    });
    await dismissInterstitials(page);
  });

  await step('assert the OpenTable booking embed fired its loader', async () => {
    // ★ THE REAL CAPABILITY SIGNAL: the OpenTable widget loader request fired. If the embed
    // is gone or /reservations/ broke, this is null -> RED.
    const loaderReq = await loaderReqPromise;
    if (!loaderReq) {
      throw new Error(
        `Next Door reservations: the OpenTable widget loader request ` +
          `(opentable.com/widget/reservation/loader) did NOT fire within ${LOADER_WAIT_MS / 1000}s -- ` +
          `the booking embed is broken/removed or /reservations/ failed to load. (Never books; capability check only.)`,
      );
    }
  });

  await step('assert the reservations affordance rendered', async () => {
    // The page's booking heading -- the visible "you can reserve here" affordance.
    await expect(
      page.getByRole('heading', { name: /reserve your table/i }).first(),
      'Next Door reservations: the "Reserve Your Table" heading did not render.',
    ).toBeVisible({ timeout: 15000 });
  });
});
