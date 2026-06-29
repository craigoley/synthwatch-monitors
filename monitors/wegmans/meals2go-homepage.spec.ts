import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-meals2go-homepage
 *
 * Journey: meals2go.com → assert the Meals 2 Go homepage loads → assert core
 * ordering UI elements are present (menu/order/takeout references).
 *
 * Meals 2 Go is Wegmans' order-ahead platform (separate domain: meals2go.com). It
 * has its own frontend and backend — a wegmans.com outage may not take it down, and
 * vice versa. This monitor covers the basic "is Meals 2 Go up?" signal, which gates
 * all ordering flows (takeout, catering, party trays).
 *
 * ★UNVERIFIED — this is a completely separate domain from wegmans.com. No existing
 * spec touches meals2go.com, so ALL selectors are unverified. The URL, page title,
 * and content assertions are best guesses based on the brand name and common food-
 * ordering-site patterns. Every step needs live verification on the Mac mini.
 *
 * ★ KEY UNKNOWN (from prior recon attempt): does meals2go.com require choosing a
 * store/fulfillment type (carry out vs delivery) BEFORE showing a menu, or can you
 * browse first? The homepage assertions here are intentionally shallow (just "does
 * the site load and show ordering-related content") to avoid that ambiguity. A
 * deeper ordering-flow monitor should be built after live recon reveals the real
 * store-selection flow.
 */
test('Meals 2 Go: homepage loads', async ({ page }) => {
  await step('open meals2go.com', async () => {
    await page.goto('https://www.meals2go.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert Meals 2 Go branding loaded', async () => {
    await dismissInterstitials(page);
    // ★UNVERIFIED: the page should contain Meals 2 Go or Wegmans branding. This is
    // the most basic "the site loaded, not a CDN error page" assertion.
    await assertLoaded(page, {
      visibleText: /meals\s*2\s*go|wegmans|order/i,
      timeoutMs: 15000,
    });
  });

  await step('assert ordering UI present', async () => {
    // ★UNVERIFIED: a food-ordering site should surface menu/order/takeout/catering
    // concepts on its homepage. Look for any link or button referencing ordering.
    const orderingElement = page
      .getByRole('link', { name: /order|menu|takeout|catering|start/i })
      .or(page.getByRole('button', { name: /order|menu|takeout|catering|start/i }))
      .first();
    await expect(orderingElement).toBeVisible({ timeout: 15000 });
  });
});
