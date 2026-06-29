import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-shop-category-browse
 *
 * Journey: wegmans.com/shop → browse a department (Beverages) → open the FIRST
 * product in the results → assert the product detail loads.
 *
 * This covers the PRIMARY shopping path — category/department browsing — which is
 * distinct from search (covered by search-product). Most grocery shoppers browse
 * by aisle/department, not search. If the department browse → product path breaks,
 * the main shopping experience is broken.
 *
 * ★UNVERIFIED — the /shop URL structure and product card selectors are extrapolated
 * from search-product.spec.ts (which proves a[href*="/shop/product/"] is the real
 * product card link pattern and "Add to List" is the detail CTA). Department/aisle
 * navigation selectors are ★UNVERIFIED and need a live run to confirm the real
 * category structure. "Beverages" is chosen because ginger sparkling water (from
 * the search spec) is a beverage, so the department demonstrably exists.
 *
 * ★DESIGN NOTE: navigates directly to /shop/search filtered by department rather
 * than clicking through department UI, applying the same flake-avoidance lesson as
 * search-product (direct URL navigation = deterministic, no autocomplete/UI race).
 */
test('Wegmans: shop category browse -> first product', async ({ page }) => {
  await step('open the shop beverages category', async () => {
    // ★UNVERIFIED URL structure: Wegmans shop likely supports category/department filtering.
    // Direct URL navigation avoids any category-picker UI race (same pattern as search-product).
    // If this URL doesn't resolve to a filtered product listing, the next step's product-card
    // assertion will fail — the live run will reveal the correct URL structure.
    await page.goto('https://www.wegmans.com/shop/search?category=beverages', {
      waitUntil: 'domcontentloaded',
    });
    await dismissInterstitials(page);
  });

  await step('assert product results loaded', async () => {
    await dismissInterstitials(page);
    // VERIFIED pattern from search-product.spec.ts: product result cards are
    // <a href="/shop/product/..."> links. If ANY product card renders, the category
    // browse returned results. Category-agnostic — works for any department.
    const productCard = page
      .locator('a[href*="/shop/product/"]')
      .first();
    await expect(productCard).toBeVisible({ timeout: 15000 });
  });

  await step('open the first product', async () => {
    // VERIFIED pattern from search-product.spec.ts: clicking a product card link
    // opens the product detail (SPA — renders on the same URL).
    const firstProduct = page
      .locator('a[href*="/shop/product/"]')
      .first();
    await firstProduct.click();
  });

  await step('assert product detail loaded', async () => {
    await dismissInterstitials(page);
    // ★ SCOPE TO THE OPENED QUICK-VIEW, not page-wide (mirror of the #26 search-product fix).
    // Clicking a result card opens a native <dialog class="component--product-details-dialog">.
    // The RESULTS PAGE already shows "Add to List" on every product card (11 visible), so a
    // page-wide getByRole('button',{name:/add .*to list/i}) passed even when no product opened
    // (false positive — could not go red). The detail container .component--product-details is
    // ABSENT on the bare results page, so scoping every signal to it holds ONLY when the
    // quick-view is actually open.
    const productDetail = page
      .locator('dialog.component--product-details-dialog')
      .or(page.locator('.component--product-details'))
      .or(page.getByRole('dialog'))
      .first();
    await expect(
      productDetail,
      'product quick-view did not open after clicking the result — the click no-opped (no detail dialog).',
    ).toBeVisible({ timeout: 15000 });
    // The "Add to List" CTA, SCOPED to the opened dialog (not the page). Fails if no detail opened.
    await expect(
      productDetail.getByRole('button', { name: /add .*to list/i }).first(),
      'opened quick-view does not show the product-detail "Add to List" CTA.',
    ).toBeVisible({ timeout: 15000 });
  });
});
