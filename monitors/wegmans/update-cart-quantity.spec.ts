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
  await step("Sign in with credentials", async () => {
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
  });
}

async function signOut(page: Page): Promise<void> {
  await step("Sign out", async () => {
    const greeting = page
      .getByRole("button", { name: /hello|account|my wegmans|rewards/i })
      .or(page.getByRole("link", { name: /hello|account|my wegmans|rewards/i }))
      .filter({ visible: true })
      .first();
    await greeting.click();

    const signOutControl = page
      .getByRole("button", { name: /sign ?out|log ?out/i })
      .or(page.getByRole("link", { name: /sign ?out|log ?out/i }))
      .filter({ visible: true })
      .first();
    await signOutControl.click();

    await expect(
      page
        .getByRole("link", { name: /sign ?in|log ?in|register/i })
        .or(page.getByRole("button", { name: /sign ?in|log ?in|register/i }))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });
}

// NOTE: the source Dynatrace resource is titled "Update Cart Quantity
// (Increment & Decrement)" but its actual clickpath events only add an item
// to the list and then empty the list -- there is no stepper
// increment/decrement interaction captured anywhere in the TF definition.
// This spec faithfully reproduces the clickpath as authored (add + empty),
// not the resource's aspirational name.
test("Update Cart Quantity Terraform flow (add + empty list)", async ({
  page,
}) => {
  const username = credential("username");
  const password = credential("password");
  const baseUrl = process.env.BASE_URL ?? "https://www.wegmans.com";

  await applyWegmansHeaders(page);
  await page.route("**/monitoring?*", (route) => route.abort());

  await step("Navigate to homepage", async () => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await dismissInterstitials(page);
  });

  await login(page, username, password);

  await step("Search for a2 Milk", async () => {
    // Per skill guidance: navigate directly to search results rather than
    // typing into autocomplete + Enter (which can submit a highlighted
    // suggestion instead of the typed query).
    await page.goto(
      `${baseUrl}/shop/search?query=${encodeURIComponent("a2 milk")}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
  });

  await step("Add a2 Milk to My List", async () => {
    const addButton = page
      .getByRole("button", { name: /add.*a2 milk|add\b.*\bto (cart|list)\b/i })
      .or(page.locator('button[class*="default-add-button" i]'))
      .filter({ visible: true })
      .first();
    await expect(addButton).toBeVisible({ timeout: 30_000 });

    const listWrite = page.waitForResponse(
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
    await listWrite;
  });

  await step("Open My List", async () => {
    await page.goto(`${baseUrl}/my-list`, { waitUntil: "domcontentloaded" });
    await expect(
      page
        .getByRole("link", { name: /empty my list/i })
        .or(page.getByRole("button", { name: /empty my list/i }))
        .or(page.getByText(/empty my list/i))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  await step("Empty the list", async () => {
    const emptyList = page
      .getByRole("link", { name: /empty my list/i })
      .or(page.getByRole("button", { name: /empty my list/i }))
      .or(page.getByText(/empty my list/i))
      .filter({ visible: true })
      .first();
    await emptyList.click();

    const confirmButton = page
      .getByRole("button", { name: /yes,?\s*delete items|confirm/i })
      .filter({ visible: true })
      .first();
    const confirmAppeared = await confirmButton
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmAppeared) await confirmButton.click();

    await expect(
      page
        .getByText(/your list is empty/i)
        .or(page.getByText(/get it \(0\)/i))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  await signOut(page);
});
