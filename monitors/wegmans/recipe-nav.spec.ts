import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-recipe-nav
 *
 * Journey: wegmans.com -> Meals & Recipes -> Courses -> Dinner -> the
 * "Pesto Tomato and Spinach Cauliflower Crust Pizza" recipe -> assert it loads.
 *
 * NOTE (selectors + nav path): on /recipes the categories are ARIA TABS, and
 * "Courses" is a role="tab" (id=category-tab-courses) whose panel is lazy-rendered
 * on click -- VERIFIED from run #844724's trace. The Courses step now clicks that
 * tab. "Dinner" and the exact recipe name remain best-effort: Dinner's markup isn't
 * observable until the Courses tab opens (its panel is empty+hidden in the trace),
 * so its selector is a resilient name match scoped to the revealed panel; the recipe
 * may move. If a step fails, the trace + screenshot capture the real DOM -- update
 * that step to match rather than guessing repeatedly.
 */
test('Wegmans: recipe nav -> cauliflower-crust pesto pizza', async ({ page }) => {
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

  await step('open the cauliflower-crust pesto pizza recipe', async () => {
    await dismissInterstitials(page);
    const recipe = page
      .getByRole('link', { name: /pesto .*(tomato|spinach).*cauliflower.*crust.*pizza/i })
      .or(page.getByText(/pesto .*(tomato|spinach).*cauliflower.*crust.*pizza/i))
      .first();
    await expect(recipe).toBeVisible({ timeout: 15000 });
    await recipe.click();
  });

  await step('assert recipe loaded', async () => {
    await dismissInterstitials(page);
    // Stable signals: the recipe title visible AND a recipe page indicator
    // (ingredients/instructions present, or a recipe URL shape). Tighten after
    // a real run confirms the actual URL + page structure.
    await assertLoaded(page, {
      urlPattern: /\/recipes?\//i,
      visibleText: /cauliflower.*crust.*pizza/i,
      timeoutMs: 15000,
    });
    // A second resilient signal that it's a real recipe page, not a 404/listing:
    await expect(
      page.getByText(/ingredients/i).or(page.getByText(/instructions|directions/i)).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
