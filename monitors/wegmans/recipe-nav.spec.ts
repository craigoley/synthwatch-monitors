import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-recipe-nav
 *
 * Journey: wegmans.com -> Meals & Recipes -> Courses -> Dinner -> open the FIRST
 * dinner recipe -> assert a recipe detail page loaded.
 *
 * NOTE (selectors + nav path): on /recipes the categories are ARIA TABS, and
 * "Courses" is a role="tab" (id=category-tab-courses) whose panel is lazy-rendered
 * on click -- VERIFIED from run #844724's trace. The Courses step clicks that tab.
 * ★ Step 4 is RECIPE-AGNOSTIC by design: it clicks whatever recipe is FIRST in the
 * Dinner results (a card link wrapping <img data-testid="img-recipe-card">) and
 * asserts a recipe DETAIL page loaded via STRUCTURAL signals (a /recipes/<cat>/<slug>
 * URL + an ingredients/directions section), NOT a specific recipe name or slug -- so
 * it survives the catalog reordering that broke the old cauliflower-pizza selector
 * (run #844753). The detail-page DOM isn't observable until a recipe is opened; the
 * card selector + URL pattern are verified from the trace, the detail signal is
 * recipe-agnostic. If a step fails, the trace captures the real DOM -- update to match.
 */
test('Wegmans: recipe nav -> first dinner recipe detail', async ({ page }) => {
  await step('open wegmans.com', async () => {
    await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('open Meals & Recipes', async () => {
    const mealsRecipes = page
      .getByRole('link', { name: /meals (&|and) recipes/i })
      .or(page.getByRole('button', { name: /meals (&|and) recipes/i }))
      .first();
    await expect(mealsRecipes).toBeVisible({ timeout: 15000 });
    await mealsRecipes.click();
  });

  await step('navigate Courses -> Dinner', async () => {
    await dismissInterstitials(page);
    // Wegmans /recipes groups categories into ARIA TABS: Top Categories / Courses / Main
    // Ingredient / Dietary Preferences / Time. "Courses" is a role="tab" (id=category-tab-courses,
    // aria-controls=category-tabpanel-courses) — NOT a link, and its panel is lazy: empty + hidden
    // until the tab is clicked. (Verified from run #844724's trace DOM — the old `link name=courses`
    // selector never matched, so its best-effort click was skipped and the Dinner wait timed out.)
    // So we MUST click the Courses tab to reveal the panel that holds Dinner.
    const coursesTab = page.getByRole('tab', { name: /courses/i }).first();
    await expect(coursesTab).toBeVisible({ timeout: 15000 });
    await coursesTab.click();

    // Dinner renders into the now-revealed Courses panel. Scope to that panel (#category-
    // tabpanel-courses) so the "Weeknight dinners made easy" page heading can't false-match, and
    // accept link OR button (Dinner's exact role isn't observable until the tab opens). Resilient
    // name match (starts with "dinner"), not the brittle exact-link the real DOM doesn't satisfy.
    const coursesPanel = page.locator('#category-tabpanel-courses');
    const dinner = coursesPanel
      .getByRole('link', { name: /^dinner\b/i })
      .or(coursesPanel.getByRole('button', { name: /^dinner\b/i }))
      .first();
    await expect(dinner).toBeVisible({ timeout: 15000 });
    await dinner.click();
  });

  await step('open the first dinner recipe', async () => {
    await dismissInterstitials(page);
    // RESILIENT to catalog reordering: click whatever recipe is FIRST, not a named one (the old
    // cauliflower-pizza selector broke when the recipe was reordered out of view). A recipe RESULT
    // card is a link wrapping an <img data-testid="img-recipe-card"> (class component--recipe-card,
    // href /recipes/<category>/<slug>) — verified from run #844753's trace. Filtering links by that
    // card-image test hook scopes to real results, excluding the curated /recipes/collections/ cards
    // (which wrap a <figure> with no such testid) and any tab/filter/nav link.
    const firstRecipe = page
      .getByRole('link')
      .filter({ has: page.getByTestId('img-recipe-card') })
      .first();
    await expect(firstRecipe).toBeVisible({ timeout: 15000 });
    await firstRecipe.click();
  });

  await step('assert a recipe detail page loaded', async () => {
    await dismissInterstitials(page);
    // RECIPE-AGNOSTIC "a detail page rendered" (no specific name/slug): the URL is a recipe DETAIL
    // path /recipes/<category>/<slug> (two segments — distinguishes it from the /recipes/search
    // listing; the result cards link to e.g. /recipes/main-dishes/<slug>, verified from the trace).
    await assertLoaded(page, {
      urlPattern: /\/recipes\/[a-z][a-z0-9-]*\/[a-z0-9-]+/i,
      timeoutMs: 15000,
    });
    // Structural signal true for ANY recipe page but NOT the listing (a search/listing has no
    // ingredients/directions section). Recipe-agnostic — proves a recipe detail, not which recipe.
    await expect(
      page.getByText(/ingredients/i).or(page.getByText(/directions|instructions/i)).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
