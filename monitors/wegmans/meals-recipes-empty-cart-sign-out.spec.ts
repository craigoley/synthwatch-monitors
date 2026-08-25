import { test, expect, step, credential, dismissInterstitials, type Page } from '../../lib/flow';

async function applyWegmansHeaders(page: Page): Promise<void> {
  const bypassToken = process.env.VERCEL_BYPASS_TOKEN;
  const cf1 = process.env.CF1;
  const routeHosts = ['https://www.wegmans.com/**', 'https://myaccount.wegmans.com/**'];

  if (!bypassToken && !cf1) return;

  for (const routeHost of routeHosts) {
    await page.route(routeHost, async (route) => {
      const headers = route.request().headers();
      if (bypassToken) headers['x-vercel-protection-bypass'] = bypassToken;
      if (bypassToken) headers['x-vercel-set-bypass-cookie'] = 'true';
      if (cf1) headers.cf1 = cf1;
      await route.continue({ headers });
    });
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  const signIn = page
    .getByRole('link', { name: /sign ?in|log ?in|register/i })
    .or(page.getByRole('button', { name: /sign ?in|log ?in|register/i }))
    .filter({ visible: true })
    .first();
  await signIn.click();

  await page.waitForURL(/myaccount\.wegmans\.com/, { timeout: 20_000 });
  await page.waitForLoadState('domcontentloaded');

  const usernameInput = page.locator('#signInName');
  const passwordInput = page.locator('#password');
  await expect(usernameInput).toBeVisible({ timeout: 15_000 });
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await usernameInput.type(username, { delay: 50 });
  await passwordInput.type(password, { delay: 50 });

  const tokenEvent = page
    .waitForResponse(
      (r) => /\/oauth2\/v2\.0\/token/i.test(r.url()) && r.status() >= 200 && r.status() < 400,
      { timeout: 45_000 },
    )
    .catch(() => null);
  await page.locator('#next').click();
  expect(await tokenEvent).toBeTruthy();

  await expect(
    page.getByRole('link', { name: /hello|account|my wegmans|rewards|sign ?out|log ?out/i })
      .or(page.getByRole('button', { name: /hello|account|my wegmans|rewards|sign ?out|log ?out/i }))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

test('Meal and Recipes empty cart and sign out Terraform flow', async ({ page }) => {
  const username = credential('username');
  const password = credential('password');

  await applyWegmansHeaders(page);
  await page.route('**/monitoring?*', (route) => route.abort());

  await step('Navigate to homepage and sign in', async () => {
    await page.goto(process.env.BASE_URL ?? 'https://www.wegmans.com', {
      waitUntil: 'domcontentloaded',
    });
    await dismissInterstitials(page);
    await login(page, username, password);
  });

  await step('Open Meals and Recipes', async () => {
    const mealsAndRecipes = page
      .getByRole('link', { name: /meals (&|and) recipes/i })
      .or(page.getByRole('button', { name: /meals (&|and) recipes/i }))
      .first();
    await expect(
      mealsAndRecipes,
      'the "Meals & Recipes" nav entry did not render on the homepage.',
    ).toBeVisible({ timeout: 30_000 });
    await mealsAndRecipes.click();
    await dismissInterstitials(page);
  });

  await step('Open the Under 30 Minutes recipe category', async () => {
    // The TF clickpath clicked the "Ready in Under 30 Minutes" category tile by DOM position.
    // Two things make that unusable here: the live tile is captioned "Under 30 Minutes" (NOT
    // "Ready in ..."), and it is a lazily rendered <figure> inside the Time tab panel, so both a
    // name match and a positional match are brittle. Its href IS the stable contract --
    // /recipes/search?totalTime=30 -- so navigate it directly (same direct-URL lesson as
    // recipe-search.spec.ts, which avoids the autocomplete/tab-panel races entirely).
    await page.goto(`${process.env.BASE_URL ?? 'https://www.wegmans.com'}/recipes/search?totalTime=30`, {
      waitUntil: 'domcontentloaded',
    });
    await dismissInterstitials(page);
  });

  await step('Open the first recipe', async () => {
    // Repo-proven card anchor (recipe-nav.spec.ts / recipe-search.spec.ts): a result card is a
    // link wrapping an <img data-testid="img-recipe-card">. Recipe-agnostic, so catalog
    // reordering cannot break it, and it excludes curated collection tiles + nav/filter links
    // that the old `a:has(img)` selector would have matched first.
    const firstRecipe = page
      .getByRole('link')
      .filter({ has: page.getByTestId('img-recipe-card') })
      .first();
    await expect(
      firstRecipe,
      'no recipe cards rendered on /recipes/search?totalTime=30 -- suspect ENTRY-ROT in that ' +
        'category URL before concluding recipe browse is down.',
    ).toBeVisible({ timeout: 30_000 });
    await firstRecipe.click();

    // A recipe DETAIL page is /recipes/<category>/<slug> (two segments) -- distinguishes it from
    // the listing, so a click that silently no-ops reds HERE instead of in the add-to-list step.
    await expect(page).toHaveURL(/\/recipes\/[a-z][a-z0-9-]*\/[a-z0-9-]+/i, { timeout: 30_000 });
  });

  await step('Add recipe ingredients to list', async () => {
    const addSelected = page
      .getByRole('button', { name: /add selected items to my list/i })
      .or(page.getByRole('button', { name: /add selected items to list/i }))
      .filter({ visible: true })
      .first();
    await expect(addSelected).toBeVisible({ timeout: 30_000 });
    await addSelected.click();

    const listWrite = page.waitForResponse(
      (r) => {
        if (['GET', 'HEAD'].includes(r.request().method())) return false;
        try {
          const host = new URL(r.url()).hostname.toLowerCase();
          const onApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /azure-api\.net$/.test(host);
          return onApi && /\/(cart|list|shopping-?list|cart-items)/i.test(r.url()) && r.status() < 500;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );

    const confirmAdd = page
      .getByRole('button', { name: /add selected items to list/i })
      .filter({ visible: true })
      .first();
    const confirmVisible = await confirmAdd
      .waitFor({ state: 'visible', timeout: 7_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmVisible) await confirmAdd.click();

    await listWrite;
  });

  await step('Open list and empty it', async () => {
    await page.goto((process.env.BASE_URL ?? 'https://www.wegmans.com') + '/my-list', {
      waitUntil: 'domcontentloaded',
    });

    const emptyList = page
      .getByRole('link', { name: /empty my list/i })
      .or(page.getByRole('button', { name: /empty my list/i }))
      .or(page.getByText(/empty my list/i))
      .filter({ visible: true })
      .first();
    await expect(emptyList).toBeVisible({ timeout: 30_000 });
    await emptyList.click();

    const confirmButton = page
      .getByRole('button', { name: /yes,?\s*delete items|confirm/i })
      .filter({ visible: true })
      .first();
    const confirmAppeared = await confirmButton
      .waitFor({ state: 'visible', timeout: 7_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmAppeared) await confirmButton.click();

    await expect(
      page.getByText(/your list is empty/i)
        .or(page.getByText(/get it \(0\)/i))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  await step('Sign out', async () => {
    const greeting = page
      .getByRole('button', { name: /hello|account|my wegmans|rewards/i })
      .or(page.getByRole('link', { name: /hello|account|my wegmans|rewards/i }))
      .filter({ visible: true })
      .first();
    await expect(greeting).toBeVisible({ timeout: 30_000 });
    await greeting.click();

    const signOut = page
      .getByRole('button', { name: /sign ?out|log ?out/i })
      .or(page.getByRole('link', { name: /sign ?out|log ?out/i }))
      .filter({ visible: true })
      .first();
    await expect(signOut).toBeVisible({ timeout: 30_000 });
    await signOut.click();

    await expect(
      page.getByRole('link', { name: /sign ?in|log ?in|register/i })
        .or(page.getByRole('button', { name: /sign ?in|log ?in|register/i }))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});
