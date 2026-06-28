import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-homepage-load
 *
 * Journey: load wegmans.com → assert the homepage renders with core navigation
 * and a key content section (hero/promo area or department links).
 *
 * This is the simplest, highest-impact monitor: if wegmans.com itself is down,
 * every other journey fails too. Runs at a shorter interval than journey monitors
 * so outages are caught fast.
 *
 * ★UNVERIFIED — selectors built from patterns in the existing specs (the header
 * nav link "Meals & Recipes" is verified from recipe-nav.spec.ts) + general
 * Wegmans.com knowledge. Needs a live Mac-mini run to confirm the homepage
 * content assertions. The header nav assertion IS verified (recipe-nav already
 * proves "Meals & Recipes" is a visible link/button in the header).
 */
test('Wegmans: homepage loads', async ({ page }) => {
  await step('open wegmans.com', async () => {
    await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert core navigation rendered', async () => {
    await dismissInterstitials(page);
    // The header nav includes "Meals & Recipes" — this is VERIFIED from recipe-nav.spec.ts
    // (that spec clicks this exact element successfully). Proving this link renders = the
    // header + global nav framework loaded, which is the key structural signal.
    const navLink = page
      .getByRole('link', { name: /meals (&|and) recipes/i })
      .or(page.getByRole('button', { name: /meals (&|and) recipes/i }))
      .first();
    await expect(navLink).toBeVisible({ timeout: 15000 });
  });

  await step('assert homepage content loaded', async () => {
    // ★UNVERIFIED: assert a shopping/shop-related element is present — Wegmans homepage
    // always has a path to shop online. The search-product spec proves /shop/search works,
    // so "shop" as a concept exists on the site. We assert any visible link containing "shop"
    // in the href as a generic "the homepage rendered shopping content" signal.
    const shopLink = page
      .getByRole('link', { name: /shop/i })
      .or(page.locator('a[href*="/shop"]'))
      .first();
    await expect(shopLink).toBeVisible({ timeout: 15000 });
  });
});
