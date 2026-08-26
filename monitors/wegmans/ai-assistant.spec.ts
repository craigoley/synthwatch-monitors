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

test("AI Assistant Terraform flow", async ({ page }) => {
  const username = credential("username");
  const password = credential("password");

  await applyWegmansHeaders(page);
  await page.route("**/monitoring?*", (route) => route.abort());

  await step("Navigate to homepage", async () => {
    await page.goto(process.env.BASE_URL ?? "https://www.wegmans.com", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await login(page, username, password);

  await step("Open the AI chat assistant", async () => {
    const chatToggle = page
      .locator("button.component--ai-chat-toggle-button")
      .first();
    await expect(chatToggle).toBeVisible({ timeout: 30_000 });
    await chatToggle.click();
  });

  await step("Select a suggested prompt", async () => {
    const suggestion = page
      .locator("button.component--ai-chat-suggestion-card")
      .first();
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await suggestion.click();
  });

  await step("Verify AI response feedback controls appear", async () => {
    // TF validates the "Provide positive feedback" affordance on the AI
    // response -- this only renders once the assistant returns a real reply.
    const feedbackButton = page
      .locator('button[aria-label="Provide positive feedback"]')
      .first();
    await expect(feedbackButton).toBeVisible({ timeout: 45_000 });
  });
});
