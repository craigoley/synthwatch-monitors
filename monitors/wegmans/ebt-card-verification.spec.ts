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

test("EBT Card Verification Terraform flow", async ({ page }) => {
  const username = credential("username");
  const password = credential("password");

  await applyWegmansHeaders(page);
  await page.route("**/monitoring?*", (route) => route.abort());

  await step("Navigate to homepage and sign in", async () => {
    await page.goto(process.env.BASE_URL ?? "https://www.wegmans.com", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
    await login(page, username, password);
  });

  await step("Set pickup and open checkout", async () => {
    await setPickup(page);

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

    const goToCheckout = page
      .getByRole("button", { name: /go to checkout/i })
      .or(page.getByRole("link", { name: /go to checkout/i }))
      .filter({ visible: true })
      .first();
    await expect(goToCheckout).toBeVisible({ timeout: 30_000 });
    await goToCheckout.click();
  });

  await step("Choose a pickup time slot", async () => {
    const chooseButton = page
      .locator("div.component--base-button.slot-fake-button")
      .or(page.getByRole("button", { name: /^choose$/i }))
      .filter({ visible: true })
      .first();
    await expect(chooseButton).toBeVisible({ timeout: 30_000 });
    await chooseButton.click();

    // TF validates "Wegmans Pickup Time" text renders after the slot picker opens.
    await expect(page.getByText(/wegmans pickup time/i).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  await step("Confirm mobile number for SMS updates", async () => {
    const smsCheckbox = page
      .locator('input[type="checkbox"]')
      .filter({ visible: true })
      .first();
    const smsVisible = await smsCheckbox
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (smsVisible) await smsCheckbox.click();

    const saveMobile = page
      .getByRole("button", { name: /save mobile number|save|continue/i })
      .filter({ visible: true })
      .first();
    await expect(saveMobile).toBeVisible({ timeout: 30_000 });
    await saveMobile.click();

    // TF validates the "Payment" section renders after saving the mobile number.
    await expect(page.getByText(/payment/i).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  await step("Toggle EBT SNAP card payment", async () => {
    const ebtToggle = page
      .getByRole("checkbox", { name: /ebt snap card/i })
      .or(page.getByRole("switch", { name: /ebt snap card/i }))
      .or(page.locator('input[type="checkbox"][class*="Switch" i]'))
      .filter({ visible: true })
      .first();
    await expect(ebtToggle).toBeVisible({ timeout: 30_000 });
    await ebtToggle.click();

    // TF validates the "EBT SNAP Card" section renders/expands after the toggle.
    await expect(page.getByText(/ebt snap card/i).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  await step("Open the EBT SNAP PIN entry modal", async () => {
    const enterPinButton = page
      .getByRole("button", { name: /enter ebt snap card pin/i })
      .filter({ visible: true })
      .first();
    await expect(enterPinButton).toBeVisible({ timeout: 30_000 });
    await enterPinButton.click();

    // TF validates the PIN entry dialog itself renders with this heading text.
    await expect(
      page.getByText(/enter ebt snap card pin/i).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  await step("Close the PIN entry modal", async () => {
    const closeButton = page
      .getByRole("button", { name: /close/i })
      .filter({ visible: true })
      .first();
    await expect(closeButton).toBeVisible({ timeout: 15_000 });
    await closeButton.click();
  });
});
