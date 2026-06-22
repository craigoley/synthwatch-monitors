import { test, expect, step, assertLoaded, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-recipe-nav
 *
 * Journey: wegmans.com -> Meals & Recipes -> Courses -> Dinner -> the
 * "Pesto Tomato and Spinach Cauliflower Crust Pizza" recipe -> assert it loads.
 *
 * NOTE (selectors + nav path): the navigation path ("Meals & Recipes" ->
 * "Courses" -> "Dinner") and the exact recipe name are ASSUMPTIONS about the
 * site's structure. The real nav may differ (a mega-menu, a different category
 * tree, the recipe may have moved). Verify against the live site on the first
 * run; the trace + screenshot will show the real structure. If the path differs,
 * the run fails at the specific step and the real DOM is captured -- update to
 * match rather than guessing repeatedly.
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
    // Some sites expose "Courses" then "Dinner"; others go straight to a
    // category list. Try Courses first (best-effort), then Dinner.
    const courses = page.getByRole('link', { name: /^courses$/i }).first();
    try {
      if (await courses.isVisible({ timeout: 3000 })) await courses.click();
    } catch {
      /* category tree may not nest under Courses; continue to Dinner */
    }
    const dinner = page.getByRole('link', { name: /^dinner$/i }).first();
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
