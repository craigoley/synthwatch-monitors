import { test, expect } from "@playwright/test";

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

      // Wait for the login form inputs to be ready
      const usernameInput = page
        .locator('[class="mdc-text-field__input"]')
        .first();
      await expect(usernameInput).toBeVisible({ timeout: 15_000 });

      // B2C Material Design form needs real keystrokes to register values
      await usernameInput.click();
      await usernameInput.type(process.env.MONITOR_USERNAME ?? "", {
        delay: 50,
      });

      const passwordInput = page
        .locator('[class="mdc-text-field__input"]')
        .nth(1);
      await expect(passwordInput).toBeVisible({ timeout: 15_000 });
      await passwordInput.click();
      await passwordInput.type(process.env.MONITOR_PASSWORD ?? "", {
        delay: 50,
      });

      // Ensure form has registered the input values before submitting
      await expect(usernameInput).not.toHaveValue("");
      await expect(passwordInput).not.toHaveValue("");

      await page.locator("#next").click();

      // Wait for redirect back to main site and greeting to appear
      await expect(
        page.locator('[class*="header-desktop-sign-in-greeting-button"]'),
      ).toBeVisible({ timeout: 30_000 });
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
      // Note: button may be aria-disabled initially until items load
      const emptyListButton = page.getByRole("button", {
        name: /empty my list/i,
      });
      await expect(emptyListButton).toBeVisible({ timeout: 30_000 });
      await expect(emptyListButton).toBeEnabled({ timeout: 30_000 });
      await emptyListButton.click();

      // Confirm deletion
      const confirmButton = page.getByRole("button", { name: "Confirm" });
      await expect(confirmButton).toBeVisible({ timeout: 15_000 });
      await confirmButton.click();

      await page.waitForLoadState("domcontentloaded");
    });
  });
});
