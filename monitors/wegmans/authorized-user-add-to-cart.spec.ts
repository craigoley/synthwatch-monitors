import { test, expect, credential } from "../../lib/flow";

test.describe("Authorized User Add to Cart", () => {
  test.beforeEach(async ({ page }) => {
    const bypassToken = process.env.VERCEL_BYPASS_TOKEN;

    // Host-scoped bypass header for B2C only (avoid leaking the token to 3p subresources).
    if (bypassToken) {
      await page.route("https://myaccount.wegmans.com/**", async (route) => {
        const req = route.request();
        await route.continue({
          headers: { ...req.headers(), "x-vercel-protection-bypass": bypassToken },
        });
      });
    }

    // Block monitoring endpoint to match TF config
    await page.route("**/monitoring?*", (route) => route.abort());
  });

  test("adds item to cart and empties the list", async ({ page }) => {
    // credential() is FAIL-CLOSED: throws if SW_CRED_<ROLE> is unset/empty
    const username = credential("username");
    const password = credential("password");

    await test.step("Navigate to the site", async () => {
      await page.goto(process.env.BASE_URL ?? "https://www.wegmans.com");
      await dismissInterstitials(page);
    });

    await test.step("Sign in with credentials", async () => {
      const signIn = page
        .getByRole("link", { name: /sign ?in|log ?in/i })
        .or(page.getByRole("button", { name: /sign ?in|log ?in/i }))
        .filter({ visible: true })
        .first();
      await signIn.click();

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

      // Arm a real auth-success signal BEFORE submit (avoid redirect race): B2C token-acquisition.
      const tokenEvent = page
        .waitForResponse(
          (r) => /\/oauth2\/v2\.0\/token/i.test(r.url()) && r.status() >= 200 && r.status() < 400,
          { timeout: 45_000 },
        )
        .catch(() => null);

      await page.locator("#next").click();

      expect(
        await tokenEvent,
        "login: no B2C token-acquisition event within 45s of submit — auth did not complete",
      ).not.toBeNull();

      // Wait for redirect back to main site and greeting to appear (60s ceiling — free unless hit)
      await expect(
        page.getByRole("link", { name: /account|hello|welcome|my wegmans|sign ?out/i })
          .or(page.getByRole("button", { name: /account|hello|welcome|my wegmans|sign ?out/i })),
      ).toBeVisible({ timeout: 60_000 });
    });

    await test.step("Search for product", async () => {
      const query = "35 pack water";
      await page.goto(
        `${process.env.BASE_URL ?? "https://www.wegmans.com"}/shop/search?query=${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded" },
      );
      // Wait for an actual "Add … to Cart" control (avoid matching "…to list" mini-buttons).
      const addToCartButton = page
        .getByRole("button", { name: /add\b.*\bto cart\b/i })
        .or(page.locator('button[aria-label*="to cart" i]'))
        .filter({ visible: true })
        .first();
      await expect(addToCartButton).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Add item to cart", async () => {
      const addToCartButton = page
        .getByRole("button", { name: /add\b.*\bto cart\b/i })
        .or(page.locator('button[aria-label*="to cart" i]'))
        .filter({ visible: true })
        .first();

      const cartWrite = page.waitForResponse(
        (r) => {
          const m = r.request().method();
          if (m === "GET" || m === "HEAD") return false;
          try {
            const host = new URL(r.url()).hostname.toLowerCase();
            return (
              /(^|\.)wegmans\.(com|cloud)$/.test(host) &&
              /\/(cart|basket|cart-items|line-?items|order|add)/i.test(r.url()) &&
              r.status() >= 200 && r.status() < 400
            );
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
      );

      await addToCartButton.click();
      await cartWrite;
    });

    await test.step("Open cart and verify item", async () => {
      await page.goto((process.env.BASE_URL ?? "https://www.wegmans.com") + "/cart", {
        waitUntil: "domcontentloaded",
      });

      const lineItems = page
        .locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]')
        .filter({ visible: true });
      await expect(
        lineItems.first(),
        "cart: no visible cart line items rendered on /cart after add-to-cart",
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Empty the cart", async () => {
      const meatball = page
        .getByRole("button", { name: /more options|more actions|cart actions|cart options|^more$|^options$|^actions$|^menu$/i })
        .or(page.locator('button[aria-haspopup="menu"], button[aria-haspopup="true"]').filter({ visible: true }))
        .filter({ visible: true })
        .first();
      await expect(meatball, 'cart: could not find the cart actions (⋮) button to empty the cart').toBeVisible({ timeout: 30_000 });
      await meatball.click();

      const emptyCart = page
        .getByRole("menuitem", { name: /empty (my )?cart/i })
        .or(page.getByRole("button", { name: /empty (my )?cart/i }))
        .filter({ visible: true })
        .first();
      await expect(emptyCart, 'cart: "Empty My Cart" action did not become visible after opening the cart menu').toBeVisible({ timeout: 15_000 });
      await emptyCart.click();

      const confirm = page
        .getByRole("button", { name: /yes,?\s*delete items/i })
        .or(page.getByRole("button", { name: /confirm/i }))
        .filter({ visible: true })
        .first();
      await expect(confirm, 'cart: empty-cart confirm button did not appear').toBeVisible({ timeout: 15_000 });
      await confirm.click();

      const lineItems = page
        .locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]')
        .filter({ visible: true });
      await expect(lineItems.first(), 'cart: a cart line item is still visible after emptying the cart').not.toBeVisible({ timeout: 30_000 });
    });
  });
});
