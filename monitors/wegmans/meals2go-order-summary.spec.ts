import {
  test,
  expect,
  step,
  credential,
  dismissInterstitials,
} from "../../lib/flow";

/**
 * Monitor: meals2go-order-summary
 *
 * Journey (converted from Dynatrace "Meals2go Order Summary (Terraform)"):
 * meals2go.com -> sign in via the hamburger menu -> start a CARRYOUT order -> search the
 * "Latta Road, Rochester" store -> select it -> add an item is NOT required by the source TF
 * (it goes straight from store-select to Cart/Checkout, implying an item is already present from
 * an earlier step in that TF's shared fixture) -> Cart -> Checkout -> fulfillment confirmation ->
 * open "Add a Payment Method" -> open "+Add credit card" -> close the card modal -> close the
 * order-summary panel -> sign out.
 *
 * This is the first AUTHENTICATED meals2go.com monitor; it reuses the address-search and
 * virtualized-store-list locator strategy proven live in meals2go-cheese-pizza-cart.spec.ts
 * (Google address autocomplete -> app-wegmans-store list filtered via input#store-search-input),
 * but the sign-in, checkout, and payment-method surfaces have NOT been recon'd against production
 * (no test credentials available to this conversion). Ships enabledByDefault: false pending a
 * verified run from an allowlisted egress with real credentials.
 */
test("Meals2Go: signed-in carryout order summary + payment method", async ({
  page,
}) => {
  const username = credential("username");
  const password = credential("password");

  await step("open meals2go.com landing", async () => {
    await page.goto("https://www.meals2go.com", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("sign in via the hamburger menu", async () => {
    const hamburger = page
      .locator(".hamburger-icon, .hamburger-icon-container")
      .or(page.getByRole("button", { name: /menu/i }))
      .filter({ visible: true })
      .first();
    await expect(
      hamburger,
      "STEP: hamburger menu icon not visible.",
    ).toBeVisible({ timeout: 20_000 });
    await hamburger.click();

    const signInLink = page
      .getByRole("link", { name: /sign in|register/i })
      .or(page.getByRole("button", { name: /sign in|register/i }))
      .filter({ visible: true })
      .first();
    await expect(
      signInLink,
      'STEP: "Sign In / Register" menu item not visible.',
    ).toBeVisible({ timeout: 15_000 });
    await signInLink.click();

    const usernameInput = page.locator(".mdc-text-field__input").nth(0);
    const passwordInput = page.locator(".mdc-text-field__input").nth(1);
    await expect(
      usernameInput,
      "STEP: username field not visible.",
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      passwordInput,
      "STEP: password field not visible.",
    ).toBeVisible({ timeout: 20_000 });
    await usernameInput.type(username, { delay: 50 });
    await passwordInput.type(password, { delay: 50 });
    await passwordInput.press("Enter");

    // Post-login, the hamburger menu should offer Sign Out instead of Sign In.
    await hamburger.click();
    await expect(
      page
        .getByRole("link", { name: /sign out/i })
        .or(page.getByRole("button", { name: /sign out/i }))
        .first(),
      "STEP: sign-out affordance did not appear after login.",
    ).toBeVisible({ timeout: 45_000 });
    // Close the menu back out.
    await hamburger.click();
  });

  await step(
    "start a carryout order at the Latta Road / Rochester store",
    async () => {
      const startOrder = page
        .locator("button#landing-page-start-order-button")
        .or(page.getByRole("button", { name: /start an order/i }))
        .filter({ visible: true })
        .first();
      const startVisible = await startOrder
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (startVisible) await startOrder.click();
      await dismissInterstitials(page);

      const carryout = page
        .locator("#fulfillment-confirmation-confirm-button-carryout")
        .or(page.getByRole("button", { name: "Carryout" }))
        .first();
      await expect(carryout, "STEP: Carryout option not visible.").toBeVisible({
        timeout: 20_000,
      });
      await carryout.click();

      const searchInput = page
        .locator("#store-search-input")
        .or(page.getByRole("textbox"))
        .first();
      await expect(
        searchInput,
        "STEP: store/address search input not visible.",
      ).toBeVisible({ timeout: 15_000 });
      await searchInput.click();
      await searchInput.fill("Latta Road,Rochester");

      const addressResult = page
        .locator("button.google-result")
        .filter({ hasText: /rochester,?\s*ny/i })
        .or(page.locator("button.google-result").first())
        .first();
      await expect(
        addressResult,
        'STEP: no "Rochester, NY" address result to pick.',
      ).toBeVisible({ timeout: 15_000 });
      await addressResult.click();

      const lattaStore = page
        .locator("app-wegmans-store")
        .filter({ hasText: /latta road/i })
        .locator("button.wegmans-store-container")
        .first();
      await expect(
        lattaStore,
        "STEP: Latta Road store row not found after address search.",
      ).toBeVisible({
        timeout: 15_000,
      });
      await lattaStore.click();
      await dismissInterstitials(page);
    },
  );

  await step("open cart and go to checkout", async () => {
    const cartIcon = page
      .locator(".cart-icon")
      .or(page.getByRole("button", { name: /cart/i }))
      .filter({ visible: true })
      .first();
    await expect(cartIcon, "STEP: cart icon not visible.").toBeVisible({
      timeout: 20_000,
    });
    await cartIcon.click();

    // TF validates "Checkout", "My Cart", and "Remove" all render in the cart panel.
    await expect(
      page.getByText(/checkout/i).first(),
      'STEP: "Checkout" text missing from cart panel.',
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText(/my cart/i).first(),
      'STEP: "My Cart" text missing from cart panel.',
    ).toBeVisible({
      timeout: 20_000,
    });

    const checkoutButton = page
      .locator(".checkout-button")
      .or(page.getByRole("button", { name: /checkout/i }))
      .filter({ visible: true })
      .first();
    await expect(
      checkoutButton,
      "STEP: Checkout button not visible.",
    ).toBeVisible({ timeout: 20_000 });
    await checkoutButton.click();
  });

  await step("confirm fulfillment and reach order summary", async () => {
    const confirmButton = page
      .locator("#fulfillment-confirmation-confirm-button")
      .or(page.getByRole("button", { name: /confirm/i }))
      .filter({ visible: true })
      .first();
    await expect(
      confirmButton,
      "STEP: fulfillment confirmation button not visible.",
    ).toBeVisible({
      timeout: 30_000,
    });
    await confirmButton.click();

    // TF validates the order-summary surface: Total, Add a Payment Method, Carryout details, Place
    // order all render.
    await expect(
      page.getByText(/^total/i).first(),
      'STEP: "Total" not visible on order summary.',
    ).toBeVisible({
      timeout: 40_000,
    });
    await expect(
      page.getByText(/add a payment method/i).first(),
      'STEP: "Add a Payment Method" not visible on order summary.',
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/place order/i).first(),
      'STEP: "Place order" not visible on order summary.',
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  await step("open the add-payment-method modal", async () => {
    const addPayment = page
      .locator(".wallet-add-button")
      .or(page.getByText(/add a payment method/i))
      .filter({ visible: true })
      .first();
    await addPayment.click();

    await expect(
      page.getByText(/add credit card/i).first(),
      'STEP: "Add credit card" option not visible after opening payment methods.',
    ).toBeVisible({ timeout: 20_000 });
  });

  await step("close the payment and order-summary modals", async () => {
    const closeButton = page
      .locator(".close-button")
      .filter({ visible: true })
      .first();
    const closeVisible = await closeButton
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (closeVisible) await closeButton.click();

    const closeSummary = page
      .locator(".close-button-container")
      .filter({ visible: true })
      .first();
    const summaryVisible = await closeSummary
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (summaryVisible) await closeSummary.click();
  });

  await step("sign out", async () => {
    const hamburger = page
      .locator(".hamburger-icon, .hamburger-icon-container")
      .or(page.getByRole("button", { name: /menu/i }))
      .filter({ visible: true })
      .first();
    await hamburger.click();

    const signOutLink = page
      .getByRole("link", { name: /sign out/i })
      .or(page.getByRole("button", { name: /sign out/i }))
      .filter({ visible: true })
      .first();
    await expect(signOutLink, "STEP: sign-out link not visible.").toBeVisible({
      timeout: 20_000,
    });
    await signOutLink.click();

    const confirmSignOut = page
      .getByRole("button", { name: /sign out/i })
      .filter({ visible: true })
      .first();
    const confirmVisible = await confirmSignOut
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmVisible) await confirmSignOut.click();

    await expect(
      page.getByRole("link", { name: /sign in|register/i }).first(),
      "STEP: sign-in affordance did not reappear after sign out.",
    ).toBeVisible({ timeout: 20_000 });
  });
});
