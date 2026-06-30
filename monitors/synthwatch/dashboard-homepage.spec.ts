import { test, expect, step, assertLoaded } from '../../lib/flow';

/**
 * Monitor: synthwatch-self-homepage  (TEMPLATE / example)
 *
 * The simplest possible flow, kept as the copy-paste starting point for new
 * monitors. Loads the SynthWatch dashboard and asserts the monitor grid renders.
 *
 * To add a new monitor:
 *   1. Copy this file to monitors/<area>/<name>.spec.ts
 *   2. Write the journey as named steps (step('...', async () => { ... }))
 *      using resilient locators (getByRole/getByText), asserting STABLE signals.
 *   3. Add a matching entry to manifest.json (a unique id + the script path).
 *   4. Open a PR. CI compiles the script + validates the manifest; once merged,
 *      SynthWatch syncs it and it appears in the browser-monitor picker.
 */
test('SynthWatch dashboard loads', async ({ page }) => {
  await step('open the dashboard', async () => {
    await page.goto('https://synthwatch-dashboard.vercel.app', {
      waitUntil: 'domcontentloaded',
    });
  });

  await step('assert the dashboard app rendered', async () => {
    await assertLoaded(page, {
      urlPattern: /synthwatch-dashboard\.vercel\.app/i,
      timeoutMs: 15000,
    });
    // ★ MUST-GO-RED signal (recon 2026-06-30): the dashboard's Monitors view renders an
    // <h1>Monitors</h1>. Assert THAT (a heading-role match, so it won't false-match the
    // "Monitors" nav LINK) -- it's present on the healthy app and ABSENT on an error page /
    // blank render / failed deploy. The old `expect(body).toBeVisible()` was true on EVERY
    // page (incl. error pages) -> it could never go red (false positive). This can.
    await expect(
      page.getByRole('heading', { name: /monitors/i }).first(),
      'SynthWatch dashboard: the "Monitors" heading did not render -- the app failed to load (error page / blank / failed deploy).',
    ).toBeVisible({ timeout: 15000 });
  });
});
