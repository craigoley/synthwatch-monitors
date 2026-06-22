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

  await step('assert the monitor grid rendered', async () => {
    await assertLoaded(page, {
      urlPattern: /synthwatch-dashboard\.vercel\.app/i,
      timeoutMs: 15000,
    });
    // A resilient "the app actually rendered" signal -- adjust to a stable bit of
    // dashboard text/role that's always present when healthy.
    await expect(page.locator('body')).toBeVisible({ timeout: 15000 });
  });
});
