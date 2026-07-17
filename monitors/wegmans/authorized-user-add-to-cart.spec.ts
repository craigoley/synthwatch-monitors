import { test, expect, step, credential, dismissInterstitials } from '../../lib/flow';

test('Authorized user add to cart and empty', async ({ page }) => {
  const bypassToken = process.env.VERCEL_BYPASS_TOKEN;

  // Host-scoped bypass header for B2C only (avoid leaking the token to 3p subresources).
  if (bypassToken) {
    await page.route('https://myaccount.wegmans.com/**', async (route) => {
      const req = route.request();
      await route.continue({
        headers: { ...req.headers(), 'x-vercel-protection-bypass': bypassToken },
      });
    });
  }

  // Block monitoring endpoint to match TF config
  await page.route('**/monitoring?*', (route) => route.abort());

  // credential() is FAIL-CLOSED: throws if SW_CRED_<ROLE> is unset/empty
  const username = credential('username');
  const password = credential('password');

  await step('Navigate to the site', async () => {
    await page.goto(process.env.BASE_URL ?? 'https://www.wegmans.com');
    await dismissInterstitials(page);
  });

  await step('Sign in with credentials', async () => {
    const signIn = page
      .getByRole('link', { name: /sign ?in|log ?in/i })
      .or(page.getByRole('button', { name: /sign ?in|log ?in/i }))
      .filter({ visible: true })
      .first();
    await signIn.click();

    // Wait for the B2C login page to fully load
    await page.waitForURL(/myaccount\.wegmans\.com/, { timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded');

    // B2C form uses Azure AD B2C default ids
    const usernameInput = page.locator('#signInName');
    await expect(usernameInput).toBeVisible({ timeout: 15_000 });
    await usernameInput.click();
    await usernameInput.type(username, { delay: 50 });

    const passwordInput = page.locator('#password');
    await expect(passwordInput).toBeVisible({ timeout: 15_000 });
    await passwordInput.click();
    await passwordInput.type(password, { delay: 50 });

    // Ensure form has registered the input values before submitting
    const uVal = await usernameInput.inputValue();
    expect(uVal.length).toBeGreaterThan(0);
    const pVal = await passwordInput.inputValue();
    expect(pVal.length).toBeGreaterThan(0);

    // Arm a real auth-success signal BEFORE submit (avoid redirect race): B2C token-acquisition.
    const tokenEvent = page
      .waitForResponse(
        (r) => /\/oauth2\/v2\.0\/token/i.test(r.url()) && r.status() >= 200 && r.status() < 400,
        { timeout: 45_000 },
      )
      .catch(() => null);

    await page.locator('#next').click();

    expect(
      await tokenEvent,
      'login: no B2C token-acquisition event within 45s of submit — auth did not complete',
    ).not.toBeNull();

    // Wait for redirect back to main site and greeting to appear (60s ceiling — free unless hit)
    await expect(
      page.getByRole('link', { name: /account|hello|welcome|my wegmans|sign ?out/i })
        .or(page.getByRole('button', { name: /account|hello|welcome|my wegmans|sign ?out/i }))
        .first(),
    ).toBeVisible({ timeout: 60_000 });
  });

  await step('Search for product', async () => {
    const query = '35 pack water';
    await page.goto(
      `${process.env.BASE_URL ?? 'https://www.wegmans.com'}/shop/search?query=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded' },
    );
    const addToCartButton = page
      .getByRole('button', { name: /add\b.*\bto cart\b/i })
      .or(page.locator('button[aria-label*="to cart" i]'))
      .filter({ visible: true })
      .first();
    await expect(addToCartButton).toBeVisible({ timeout: 30_000 });
  });

  await step('Add item to cart', async () => {
    const addToCartButton = page
      .getByRole('button', { name: /add\b.*\bto cart\b/i })
      .or(page.locator('button[aria-label*="to cart" i]'))
      .filter({ visible: true })
      .first();

    const cartWrite = page.waitForResponse(
      (r) => {
        const m = r.request().method();
        if (m === 'GET' || m === 'HEAD') return false;
        try {
          const host = new URL(r.url()).hostname.toLowerCase();
          const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
          return onWegmansApi && /\/(cart|basket|cart-items|line-?items|order|add)/i.test(r.url()) && r.status() < 500;
        } catch {
          return false;
        }
      },
      { timeout: 20_000 },
    );

    await addToCartButton.click();
    await cartWrite;
  });

  await step('Open cart and verify item', async () => {
    await page.goto((process.env.BASE_URL ?? 'https://www.wegmans.com') + '/cart', {
      waitUntil: 'domcontentloaded',
    });

    // "My Cart is empty" must NOT appear — its absence proves we have items
    await expect(
      page.getByText(/my cart is empty/i),
      'cart: page shows "My Cart is empty" after add-to-cart — item was not added',
    ).not.toBeVisible({ timeout: 30_000 });
  });

  await step('Empty the cart', async () => {
    // "Empty My Cart" appears as a toolbar action on /cart — may be link, button, or clickable text
    const emptyCart = page
      .getByRole('link', { name: /empty my cart/i })
      .or(page.getByRole('button', { name: /empty my cart/i }))
      .or(page.getByText(/empty my cart/i))
      .filter({ visible: true })
      .first();
    await expect(emptyCart, 'cart: "Empty My Cart" action not visible on the cart page').toBeVisible({ timeout: 30_000 });
    await emptyCart.click();

    // The site may show a confirm dialog OR empty immediately — handle both
    const confirmButton = page
      .getByRole('button', { name: /yes,?\s*delete items|confirm/i })
      .filter({ visible: true })
      .first();
    const emptyState = page.getByText(/my cart is empty/i);

    const confirmAppeared = await confirmButton
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (confirmAppeared) {
      await confirmButton.click();
    }

    // Assert the cart is empty
    await expect(
      emptyState,
      'cart: "My Cart is empty" did not appear after emptying the cart',
    ).toBeVisible({ timeout: 30_000 });
  });
});
