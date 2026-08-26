import {
  test,
  expect,
  step,
  credential,
  dismissInterstitials,
  type Page,
} from "../../lib/flow";

async function applyWegmansHeaders(page: Page): Promise<void> {
  const bypassToken = process.env.VERCEL_BYPASS_TOKEN;
  const cf1 = process.env.CF1;
  const routeHosts = [
    "https://www.wegmans.com/**",
    "https://myaccount.wegmans.com/**",
  ];

  if (!bypassToken && !cf1) return;

  for (const routeHost of routeHosts) {
    await page.route(routeHost, async (route) => {
      const headers = route.request().headers();
      if (bypassToken) headers["x-vercel-protection-bypass"] = bypassToken;
      if (bypassToken) headers["x-vercel-set-bypass-cookie"] = "true";
      if (cf1) headers.cf1 = cf1;
      await route.continue({ headers });
    });
  }
}

async function login(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  const signIn = page
    .getByRole("link", { name: /sign ?in|log ?in|register/i })
    .or(page.getByRole("button", { name: /sign ?in|log ?in|register/i }))
    .filter({ visible: true })
    .first();
  await signIn.click();

  await page.waitForURL(/myaccount\.wegmans\.com/, { timeout: 20_000 });
  await page.waitForLoadState("domcontentloaded");

  const usernameInput = page.locator("#signInName");
  const passwordInput = page.locator("#password");
  await expect(usernameInput).toBeVisible({ timeout: 15_000 });
  await expect(passwordInput).toBeVisible({ timeout: 15_000 });
  await usernameInput.type(username, { delay: 50 });
  await passwordInput.type(password, { delay: 50 });

  const tokenEvent = page
    .waitForResponse(
      (r) =>
        /\/oauth2\/v2\.0\/token/i.test(r.url()) &&
        r.status() >= 200 &&
        r.status() < 400,
      { timeout: 45_000 },
    )
    .catch(() => null);
  await page.locator("#next").click();
  expect(await tokenEvent).toBeTruthy();

  await expect(
    page
      .getByRole("link", {
        name: /hello|account|my wegmans|rewards|sign ?out|log ?out/i,
      })
      .or(
        page.getByRole("button", {
          name: /hello|account|my wegmans|rewards|sign ?out|log ?out/i,
        }),
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

async function setPickup(page: Page): Promise<void> {
  const fulfillmentButton = page
    .locator('button.selector-button[aria-haspopup="dialog"]')
    .or(
      page.getByRole("button", {
        name: /in store|pickup|delivery|change store|set store/i,
      }),
    )
    .filter({ visible: true })
    .first();
  await expect(fulfillmentButton).toBeVisible({ timeout: 20_000 });
  await fulfillmentButton.click();

  const pickupOption = page
    .getByRole("dialog")
    .getByRole("button", { name: /^pickup$/i })
    .or(page.getByRole("button", { name: /^pickup$/i }))
    .filter({ visible: true })
    .first();
  await expect(pickupOption).toBeVisible({ timeout: 20_000 });
  await pickupOption.click();

  const selectStore = page
    .getByRole("dialog")
    .getByRole("button", { name: /^select$/i })
    .or(page.getByRole("button", { name: /^select$/i }))
    .filter({ visible: true })
    .first();
  await expect(selectStore).toBeVisible({ timeout: 20_000 });
  await selectStore.click();
}

test("Wine, Beer & Spirits DOB-gated checkout Terraform flow", async ({
  page,
}) => {
  const username = credential("username");
  const password = credential("password");
  const baseUrl = process.env.BASE_URL ?? "https://www.wegmans.com";

  await applyWegmansHeaders(page);
  await page.route("**/monitoring?*", (route) => route.abort());

  await step("Navigate to homepage and sign in", async () => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await dismissInterstitials(page);
    await login(page, username, password);
  });

  await step("Set pickup fulfillment", async () => {
    await setPickup(page);
  });

  await step("Browse Wine, Beer & Spirits > New York", async () => {
    // The "Wine, Beer & Spirits" link only renders inside a collapsed departments
    // menu (verified live: present in the DOM but not visible without opening that
    // menu first). Per the skill's direct-URL-navigation principle, navigate
    // straight to the stable category URL instead of driving the menu open.
    await page.goto(`${baseUrl}/shop/categories/2957056`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText(/wine,? beer & spirits/i).first()).toBeVisible({
      timeout: 30_000,
    });

    const newYorkCategory = page
      .locator('a[href="/shop/categories/2957592"]')
      .or(page.getByRole("link", { name: /^new york$/i }))
      .filter({ visible: true })
      .first();
    await expect(newYorkCategory).toBeVisible({ timeout: 30_000 });
    await newYorkCategory.click();
    await page.waitForLoadState("domcontentloaded");
  });

  await step("Add a product to cart", async () => {
    const addButton = page
      .getByRole("button", { name: /add\b.*\bto (cart|list)\b|^add$|^\+$/i })
      .or(page.locator('button[class*="add-button" i]'))
      .filter({ visible: true })
      .first();
    await expect(addButton).toBeVisible({ timeout: 30_000 });

    const cartWrite = page.waitForResponse(
      (r) => {
        const method = r.request().method();
        if (method === "GET" || method === "HEAD") return false;
        try {
          const host = new URL(r.url()).hostname.toLowerCase();
          const onApi =
            /(^|\.)wegmans\.(com|cloud)$/.test(host) ||
            /azure-api\.net$/.test(host);
          return (
            onApi &&
            /\/(cart|list|shopping-?list|cart-items)/i.test(r.url()) &&
            r.status() < 500
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    await addButton.click();
    await cartWrite;
  });

  await step("Go to checkout", async () => {
    const cartButton = page
      .locator(
        'a[href*="/cart"], button:has-text("Cart"), button:has-text("Get it")',
      )
      .or(page.getByRole("link", { name: /cart|get it/i }))
      .or(page.getByRole("button", { name: /cart|get it/i }))
      .filter({ visible: true })
      .first();
    await expect(cartButton).toBeVisible({ timeout: 30_000 });
    await cartButton.click();

    const checkoutLink = page
      .locator('a[href="/checkout"]')
      .or(page.getByRole("link", { name: /go to checkout/i }))
      .or(page.getByRole("button", { name: /go to checkout/i }))
      .filter({ visible: true })
      .first();
    await expect(checkoutLink).toBeVisible({ timeout: 30_000 });
    await checkoutLink.click();
  });

  await step("Enter date of birth for the age-verification gate", async () => {
    const dobInput = page
      .locator('input[placeholder*="MM" i][type="text"]')
      .first();
    await expect(dobInput).toBeVisible({ timeout: 30_000 });
    await dobInput.click();
    await dobInput.type("02051984", { delay: 75 });

    const dobValue = await dobInput.inputValue();
    expect(dobValue.length).toBeGreaterThan(0);

    const continueButton = page
      .getByRole("button", { name: /^continue$/i })
      .filter({ visible: true })
      .first();
    await expect(continueButton).toBeVisible({ timeout: 15_000 });
    await continueButton.click();
  });

  await step("Return home and empty the cart", async () => {
    const homeLink = page.locator('img[alt="Wegmans"]').first();
    await expect(homeLink).toBeVisible({ timeout: 30_000 });
    await homeLink.click();
    await page.waitForLoadState("domcontentloaded");

    const cartButton = page
      .locator(
        'a[href*="/cart"], button:has-text("Cart"), button:has-text("Get it")',
      )
      .or(page.getByRole("link", { name: /cart|get it/i }))
      .or(page.getByRole("button", { name: /cart|get it/i }))
      .filter({ visible: true })
      .first();
    await expect(cartButton).toBeVisible({ timeout: 30_000 });
    await cartButton.click();

    const emptyCart = page
      .getByRole("button", { name: /empty my cart/i })
      .or(page.getByRole("link", { name: /empty my cart/i }))
      .filter({ visible: true })
      .first();
    await expect(emptyCart).toBeVisible({ timeout: 30_000 });
    await emptyCart.click();

    const confirmDelete = page
      .getByRole("button", { name: /yes,?\s*delete items/i })
      .filter({ visible: true })
      .first();
    await expect(confirmDelete).toBeVisible({ timeout: 15_000 });
    await confirmDelete.click();
  });
});
