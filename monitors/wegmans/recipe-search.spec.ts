import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-recipe-search
 *
 * Journey: wegmans.com/recipes → search for "chicken" → assert recipe search
 * results appear → open the first result → assert the recipe detail page loads.
 *
 * This covers recipe SEARCH (distinct from the category NAV in recipe-nav.spec.ts).
 * Recipe search uses a different backend/index than product search, so it can break
 * independently. "Chicken" is chosen as a high-frequency, always-in-catalog query
 * that should always return results (resilient to seasonal/trending recipe changes).
 *
 * ★ PARTIALLY VERIFIED — the recipe detail assertions (URL pattern + ingredients/
 * directions text) are VERIFIED from recipe-nav.spec.ts. The recipe search input
 * and results-listing selectors are ★UNVERIFIED (recipe-nav navigates by category
 * tabs, not search). The recipe card selector (link wrapping img[data-testid=
 * "img-recipe-card"]) IS verified from recipe-nav and is reused here.
 *
 * ★DESIGN NOTE: navigates directly to /recipes/search/chicken rather than typing
 * into a search box, applying the same flake-avoidance lesson as search-product
 * (direct URL = no autocomplete race).
 */
test('Wegmans: recipe search -> first chicken recipe', async ({ page }) => {
  await step('open chicken recipe search results', async () => {
    // ★UNVERIFIED URL structure: Wegmans recipe search likely uses /recipes/search?query=
    // or /recipes/search/<term>. If neither works, the live run will reveal the correct
    // pattern from the search UI's form action or XHR.
    await page.goto('https://www.wegmans.com/recipes/search?query=chicken', {
      waitUntil: 'domcontentloaded',
    });
    await dismissInterstitials(page);
  });

  await step('assert recipe results loaded', async () => {
    await dismissInterstitials(page);
    // VERIFIED pattern from recipe-nav.spec.ts: recipe cards are links wrapping an
    // <img data-testid="img-recipe-card">. If any such card renders, the search returned
    // results. Query-agnostic — works for any search that returns results.
    const recipeCard = page
      .getByRole('link')
      .filter({ has: page.getByTestId('img-recipe-card') })
      .first();
    await expect(
      recipeCard,
      'Wegmans recipe search: no recipe cards rendered on /recipes/search?query=chicken. Suspect ' +
        'ENTRY-ROT first (the recipe-search URL shape may have changed -- re-derive it from the live ' +
        '/recipes search UI) BEFORE concluding recipe search is down.',
    ).toBeVisible({ timeout: 15000 });
  });

  await step('open the first chicken recipe', async () => {
    // VERIFIED pattern from recipe-nav.spec.ts: click the FIRST recipe card (resilient
    // to result reordering — asserts capability, not a specific recipe).
    const firstRecipe = page
      .getByRole('link')
      .filter({ has: page.getByTestId('img-recipe-card') })
      .first();
    await firstRecipe.click();
  });

  await step('assert recipe detail loaded', async () => {
    await dismissInterstitials(page);
    // VERIFIED from recipe-nav.spec.ts: recipe detail pages have a /recipes/<cat>/<slug>
    // URL pattern and contain ingredients/directions sections.
    await assertLoaded(page, {
      urlPattern: /\/recipes\/[a-z][a-z0-9-]*\/[a-z0-9-]+/i,
      timeoutMs: 15000,
    });
    await expect(
      page.getByText(/ingredients/i).or(page.getByText(/directions|instructions/i)).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
