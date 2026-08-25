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

async function setPickup(page: Page): Promise<void> {
  const fulfillmentButton = page
    .locator('button.selector-button[aria-haspopup="dialog"]')
    .or(page.getByRole('button', { name: /in store|pickup|delivery|change store|set store/i }))
    .filter({ visible: true })
    .first();
  await expect(fulfillmentButton).toBeVisible({ timeout: 20_000 });
  await fulfillmentButton.click();

  const pickupOption = page
    .getByRole('dialog')
    .getByRole('button', { name: /^pickup$/i })
    .or(page.getByRole('button', { name: /^pickup$/i }))
    .filter({ visible: true })
    .first();
  await expect(pickupOption).toBeVisible({ timeout: 20_000 });
  await pickupOption.click();

  const selectStore = page
    .getByRole('dialog')
    .getByRole('button', { name: /^select$/i })
    .or(page.getByRole('button', { name: /^select$/i }))
    .filter({ visible: true })
    .first();
  await expect(selectStore).toBeVisible({ timeout: 20_000 });
  await selectStore.click();
}

test('Verify add card modal Terraform flow', async ({ page }) => {
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

  await step('Set pickup and open checkout', async () => {
    await setPickup(page);

    const cartButton = page
      .locator('a[href*="/cart"], button:has-text("Cart"), button:has-text("Get it")')
      .or(page.getByRole('link', { name: /cart|get it/i }))
      .or(page.getByRole('button', { name: /cart|get it/i }))
      .filter({ visible: true })
      .first();
    await expect(cartButton).toBeVisible({ timeout: 30_000 });
    await cartButton.click();

    const goToCheckout = page
      .getByRole('button', { name: /go to checkout/i })
      .or(page.getByRole('link', { name: /go to checkout/i }))
      .filter({ visible: true })
      .first();
    await expect(goToCheckout).toBeVisible({ timeout: 30_000 });
    await goToCheckout.click();

    const chooseButton = page
      .locator('div.component--base-button.slot-fake-button')
      .or(page.getByRole('button', { name: /^choose$/i }))
      .filter({ visible: true })
      .first();
    await expect(chooseButton).toBeVisible({ timeout: 30_000 });
    await chooseButton.click();
  });

  await step('Open add card modal and validate iframe', async () => {
    const smsCheckbox = page
      .locator('input[type="checkbox"]')
      .filter({ visible: true })
      .first();
    const smsVisible = await smsCheckbox
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (smsVisible) await smsCheckbox.click();

    const saveMobile = page
      .getByRole('button', { name: /save mobile number|save|continue/i })
      .filter({ visible: true })
      .first();
    await expect(saveMobile).toBeVisible({ timeout: 30_000 });
    await saveMobile.click();

    const addNewCard = page
      .getByRole('button', { name: /add new card/i })
      .or(page.getByRole('link', { name: /add new card/i }))
      .filter({ visible: true })
      .first();
    await expect(addNewCard).toBeVisible({ timeout: 30_000 });
    await addNewCard.click();

    const cardIframe = page.locator('iframe[name="frame_card_details"]').first();
    await expect(cardIframe).toBeVisible({ timeout: 30_000 });

    const cardNumberInput = page.frameLocator('iframe[name="frame_card_details"]').locator('input').first();
    await expect(cardNumberInput).toBeVisible({ timeout: 30_000 });
    await cardNumberInput.type('123');
    const cardValue = await cardNumberInput.inputValue();
    expect(cardValue.length).toBeGreaterThan(0);
  });
});
