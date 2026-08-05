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
    // Ingredient / Dietary Preferences / Time. "Courses" is a role="tab" — NOT a link — and its
    // panel is lazy: empty + hidden until the tab is clicked. (Verified from run #844724's trace
    // DOM — the old `link name=courses` selector never matched, so its best-effort click was
    // skipped and the Dinner wait timed out.) So we MUST click the tab to reveal the panel.
    const coursesTab = page.getByRole('tab', { name: /courses/i }).first();
    await expect(coursesTab, 'the Courses tab did not render on /recipes.').toBeVisible({ timeout: 15000 });

    // Read the panel id BEFORE activating the tab. aria-controls is static, so the panel's IDENTITY
    // does not depend on how the tablist re-renders on click — one less thing to be true at once.
    const panelId = await coursesTab.getAttribute('aria-controls');
    await coursesTab.click();

    // ★★ THE PANEL IS FOUND VIA THE TAB'S OWN aria-controls, NOT A HARDCODED id.
    //
    // OBSERVED 2026-08-03 15:01Z → 08-05: 144 consecutive failures. Wegmans re-generated every
    // tab/panel id with a POSITIONAL SUFFIX:
    //     category-tab-courses        → category-tab-courses-1
    //     #category-tabpanel-courses  → #category-tabpanel-courses-1
    //     (…-top-categories-0, …-main-ingredient-2, …-dietary-preferences-3, …-time-4)
    // The tab locator is role+name so it kept working; only this panel id died, and Dinner was
    // then searched inside an EMPTY set — which is why the failure read "expected element to be
    // visible" rather than anything about the panel. Dinner itself never changed: it is still
    // <a href="/recipes/search?course=dinner">Dinner</a>.
    //
    // ★ DO NOT SWAP IN THE NEW LITERAL id. `courses-1` encodes the tab's ORDINAL POSITION — insert
    //   or reorder one category and it becomes `courses-2`, i.e. pinning it re-arms this exact
    //   failure. aria-controls is the relationship the site MUST maintain for the tabs to work for
    //   screen readers, so it survives both an id rename and a reorder.
    //
    // ★★ AND IT FAILS CLOSED — NO "just use the visible tabpanel" FALLBACK.
    //    That fallback is tempting and WRONG. Top Categories is the un-hidden panel until the
    //    Courses click actually lands, so if the click were ever silently dropped the fallback would
    //    resolve THAT panel, the panel assertion below would PASS on it, and the run would then
    //    blame a missing "Dinner" entry — a green gate on the wrong element followed by a
    //    misdirecting error. That is precisely the vacuous-pass class this repo's gates ban: a check
    //    that cannot identify what it is asserting on must FAIL, not guess.
    //    Losing aria-controls would be a real change to the navigation contract this monitor rides
    //    on, and it deserves a human re-anchoring it, not a heuristic quietly picking a panel.
    if (!panelId) {
      throw new Error(
        'the Courses tab exposes no aria-controls — the tablist lost the ARIA relationship this ' +
          'monitor anchors on. Refusing to guess which panel is the Courses panel (the visible one ' +
          'is Top Categories until the click lands, so guessing can assert on the wrong panel and ' +
          'then blame a missing Dinner). Re-anchor the panel lookup deliberately.',
      );
    }
    const coursesPanel = page.locator(`[id="${panelId}"]`);

    // ★ Assert the PANEL first, so the two failure modes stop sharing one message: "the panel never
    //   opened" (this line) is a different defect from "the panel opened but Dinner is gone" (below).
    //   Conflating them is what made the id change read as a missing recipe category.
    await expect(
      coursesPanel,
      `the Courses tabpanel (#${panelId}) did not open after clicking the tab.`,
    ).toBeVisible({ timeout: 15000 });

    // Dinner renders into the now-revealed panel. Scoping to the panel keeps the "Weeknight dinners
    // made easy" page heading from false-matching; link OR button because Dinner's exact role is not
    // observable until the tab opens. Resilient name match (starts with "dinner").
    const dinner = coursesPanel
      .getByRole('link', { name: /^dinner\b/i })
      .or(coursesPanel.getByRole('button', { name: /^dinner\b/i }))
      .first();
    await expect(dinner, 'the Courses tabpanel opened but holds no "Dinner" entry.').toBeVisible({ timeout: 15000 });
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
