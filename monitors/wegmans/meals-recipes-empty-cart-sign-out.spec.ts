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

  await step('Open meals and recipes and select recipe', async () => {
    const mealsAndRecipes = page
      .getByRole('link', { name: /meals\s*&?\s*recipes/i })
      .or(page.getByRole('button', { name: /meals\s*&?\s*recipes/i }))
      .filter({ visible: true })
      .first();
    await expect(mealsAndRecipes).toBeVisible({ timeout: 30_000 });
    await mealsAndRecipes.click();

    const under30 = page
      .getByRole('link', { name: /ready in under 30 minutes/i })
      .or(page.getByRole('button', { name: /ready in under 30 minutes/i }))
      .filter({ visible: true })
      .first();
    await expect(under30).toBeVisible({ timeout: 30_000 });
    await under30.click();

    const firstRecipe = page
      .locator('a:has(img), a:has([class*="recipe-card-image" i])')
      .filter({ visible: true })
      .first();
    await expect(firstRecipe).toBeVisible({ timeout: 30_000 });
    await firstRecipe.click();
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
