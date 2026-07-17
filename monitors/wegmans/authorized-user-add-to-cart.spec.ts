import { test, expect, credential } from "../../lib/flow";

test.describe("Authorized User Add to Cart", () => {
  test.beforeEach(async ({ page }) => {
    await page.setExtraHTTPHeaders({
      "x-vercel-protection-bypass":
        process.env.VERCEL_PROTECTION_BYPASS ?? "",
      "x-vercel-set-bypass-cookie": "true",
      cf1: process.env.CF1 ?? "",
    });

    // Block monitoring endpoint to match TF config
    await page.route("**/monitoring?*", (route) => route.abort());
  });

  test("adds item to cart and empties the list", async ({ page }) => {
    // credential() is FAIL-CLOSED: throws if SW_CRED_<ROLE> is unset/empty
    const username = credential("username");
    const password = credential("password");

    await test.step("Navigate to the site", async () => {
      await page.goto(
        process.env.BASE_URL ?? "https://www.wegmans.com",
      );
    });

    await test.step("Sign in with credentials", async () => {
      await page.locator('[class="tw:ml-2"]').first().click();

      // Wait for the B2C login page to fully load
      await page.waitForURL(/myaccount\.wegmans\.com/, { timeout: 15_000 });
      await page.waitForLoadState("domcontentloaded");

      // B2C form uses Azure AD B2C default ids
      const usernameInput = page.locator("#signInName");
      await expect(usernameInput).toBeVisible({ timeout: 15_000 });
      await usernameInput.click();
      await usernameInput.type(username, { delay: 50 });

      const passwordInput = page.locator("#password");
      await expect(passwordInput).toBeVisible({ timeout: 15_000 });
      await passwordInput.click();
      await passwordInput.type(password, { delay: 50 });

      // Ensure form has registered the input values before submitting
      const uVal = await usernameInput.inputValue();
      expect(uVal.length).toBeGreaterThan(0);
      const pVal = await passwordInput.inputValue();
      expect(pVal.length).toBeGreaterThan(0);

      await page.locator("#next").click();

      // Wait for redirect back to main site and greeting to appear (60s ceiling — free unless hit)
      await expect(
        page.getByRole("link", { name: /account|hello|welcome|my wegmans|sign ?out/i })
          .or(page.getByRole("button", { name: /account|hello|welcome|my wegmans|sign ?out/i })),
      ).toBeVisible({ timeout: 60_000 });
    });

    await test.step("Search for product", async () => {
      const searchInput = page.locator('[class="aa-Input"]').first();
      await searchInput.fill("35 pack water");
      await searchInput.press("Enter");

      // Wait for search results page to load
      await page.waitForURL(/search/, { timeout: 15_000 });

      // Wait for add-to-cart button to appear in search results
      const addToCartButton = page
        .locator('[class*="default-add-button"]')
        .first();
      await expect(addToCartButton).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Add item to cart", async () => {
      const addToCartButton = page
        .locator('[class*="default-add-button"]')
        .first();

      await addToCartButton.click();

      // Wait for the list icon to update with "selected item" text
      await expect(
        page.getByRole("link", { name: /selected item/i }),
      ).toBeVisible({ timeout: 15_000 });
    });

    await test.step("Open list and verify item", async () => {
      // Navigate directly to the list page to ensure a fresh data fetch
      await page.goto(
        (process.env.BASE_URL ?? "https://www.wegmans.com") + "/my-list",
      );
      await page.waitForLoadState("domcontentloaded");
    });

    await test.step("Empty the list", async () => {
      // Wait for "Empty My List" button to be available (means items have loaded)
      const emptyListButton = page.getByRole("button", {
        name: /empty my list/i,
      });
      await expect(emptyListButton).toBeVisible({ timeout: 30_000 });
      await emptyListButton.click();

      // Confirm deletion
      const confirmButton = page.getByRole("button", { name: "Confirm" });
      await expect(confirmButton).toBeVisible({ timeout: 15_000 });
      await confirmButton.click();

      await page.waitForLoadState("domcontentloaded");
    });
  });
});
