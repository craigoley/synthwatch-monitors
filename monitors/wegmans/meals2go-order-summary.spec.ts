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
 * meals2go.com -> sign in via the header's direct Sign In button -> start a CARRYOUT order -> search the
 * "Latta Road, Rochester" store -> select it -> add a cheese pizza to the cart (the TF's own
 * shared fixture apparently pre-seeded the cart before this flow ran; a real monitoring run with a
 * fresh/empty cart proved that assumption wrong -- see the "add a cheese pizza to cart" step below)
 * -> Cart -> Checkout -> fulfillment confirmation -> open "Add a Payment Method" -> open
 * "+Add credit card" -> close the card modal -> close the order-summary panel -> sign out.
 *
 * This is the first AUTHENTICATED meals2go.com monitor; it reuses the address-search and
 * virtualized-store-list locator strategy, AND the add-to-cart locator/verification strategy,
 * proven live in meals2go-cheese-pizza-cart.spec.ts (Google address autocomplete ->
 * app-wegmans-store list filtered via input#store-search-input; thin-crust cheese pizza tile ->
 * cart-items POST verification), but the checkout and payment-method surfaces have NOT been
 * recon'd against production (no test credentials available to this conversion). Ships
 * enabledByDefault: false pending a verified run from an allowlisted egress with real credentials.
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

  // ★ The account hamburger's ID is page-scoped, e.g. `landing-page-header-hamburger-menu`,
  // `main-header-hamburger-menu`, `search-page-header-hamburger-menu` (confirmed live by
  // decompiling the production Angular bundle). A prior fix used a generic
  // `.hamburger-icon, .hamburger-icon-container` class selector `.or()`-ed with
  // `getByRole('button', { name: /menu/i })` as a fallback -- but that fallback ALSO matches
  // the unrelated food-category "Menu" toggle button in the top-left of the header (its
  // accessible name is literally "Menu"), and since that button appears earlier in DOM order,
  // `.first()` picked it instead of the real account hamburger, silently navigating the page to
  // /browse-menu. Scoping to the `*-header-hamburger-menu` id suffix (a real Angular button id,
  // not a role heuristic) avoids that ambiguity entirely.
  const hamburgerMenu = () =>
    page
      .locator('[id$="header-hamburger-menu" i]')
      .filter({ visible: true })
      .first();

  // The panel is closed via its own dedicated close button (`#hamburger-menu-close-button`),
  // NOT by re-clicking the hamburger toggle: once open, the panel (`app-right-pane`) overlays
  // and intercepts pointer events on the underlying header button, so a second click on
  // `hamburgerMenu()` just hangs waiting for the obscured element to become clickable
  // (reproduced live).
  const closeHamburgerMenu = () => page.locator("#hamburger-menu-close-button");

  await step("sign in via the header sign-in button", async () => {
    // The landing page itself also exposes a directly-visible, unambiguous "Sign in" button
    // (class `greeting-sign-in`, confirmed live) that's simpler than opening the hamburger panel
    // for the initial sign-in -- keep using it for this step.
    const signInLink = page
      .locator(".greeting-sign-in")
      .or(page.getByRole("button", { name: /^sign in$/i }))
      .or(page.getByRole("link", { name: /^sign in$/i }))
      .filter({ visible: true })
      .first();
    await expect(signInLink, 'STEP: "Sign In" button not visible.').toBeVisible(
      { timeout: 20_000 },
    );
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

    // Post-login, the account hamburger panel should offer Sign Out instead of Sign In
    // (confirmed live in the decompiled bundle: the panel template swaps a "Sign In" button
    // for a "Sign Out" button based on `userHasValidB2CSession`).
    await page.waitForURL(/meals2go\.com/, { timeout: 45_000 });
    await hamburgerMenu().click();
    await expect(
      page
        .getByRole("link", { name: /sign out/i })
        .or(page.getByRole("button", { name: /sign out/i }))
        .filter({ visible: true })
        .first(),
      "STEP: sign-out affordance did not appear after login.",
    ).toBeVisible({ timeout: 45_000 });
    // Close the panel back out.
    await closeHamburgerMenu().click();
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

  await step("add a cheese pizza to cart", async () => {
    // ★ Real monitoring run proved the TF's implicit assumption wrong: a fresh/empty cart does
    // NOT expose "Checkout" / "My Cart" text when the cart icon is opened (STEP: "Checkout" text
    // missing from cart panel). An item must actually be added first. Reuses the exact tile
    // selection + add-to-cart + cart-items API verification strategy proven live in
    // meals2go-cheese-pizza-cart.spec.ts (same site, same DOM structure, different store).
    await dismissInterstitials(page);

    const pizzaCategory = page
      .getByRole("tab", { name: /pizza/i })
      .or(page.getByRole("link", { name: /^pizza$/i }))
      .or(page.getByRole("button", { name: /^pizza$/i }))
      .first();
    await expect(pizzaCategory, "STEP: Pizza category not found.").toBeVisible({
      timeout: 20_000,
    });
    await pizzaCategory.click({ timeout: 5_000 });
    await dismissInterstitials(page);

    // The cheese pizza lives under the "Thin Crust Pizza" sub-cuisine tab; the default
    // "Pizza Promos" tab only has disabled promo banners (see the STRUCTURAL discriminator note
    // in meals2go-cheese-pizza-cart.spec.ts for why plain-text matching on a promo tile is unsafe).
    const thinCrustTab = page
      .locator("button#cuisine-thin-crust-pizza")
      .or(page.getByRole("tab", { name: /thin crust pizza/i }))
      .or(page.getByRole("button", { name: /thin crust pizza/i }))
      .filter({ visible: true })
      .first();
    try {
      if (await thinCrustTab.isVisible({ timeout: 8_000 }))
        await thinCrustTab.click({ timeout: 5_000 });
    } catch {
      /* menu may be restructured -- the cheese match below still tries */
    }
    await dismissInterstitials(page);

    // Only match a real, clickable product tile (menu-card-link, not disabled) -- NOT any
    // element whose accessible name/text contains "cheese", which can also match a disabled
    // promo banner (see meals2go-cheese-pizza-cart.spec.ts for the exact incident this avoids).
    const cheesePizza = page
      .locator(
        "button.menu-card-link:not([disabled]), a.menu-card-link:not([disabled])",
      )
      .filter({ hasText: /cheese/i })
      .first();
    await expect(
      cheesePizza,
      "STEP: no clickable cheese pizza tile under the thin-crust listing.",
    ).toBeVisible({ timeout: 20_000 });
    await cheesePizza.click({ timeout: 5_000 });
    await dismissInterstitials(page);

    const addToCart = page
      .locator("app-pop-open-pane button.cart-button, button.cart-button")
      .or(page.getByRole("button", { name: /add to cart/i }))
      .first();
    await expect(
      addToCart,
      "STEP: add-to-cart button did not render in the detail pane.",
    ).toBeVisible({ timeout: 15_000 });

    // Verify the mutation via the cart-items API response, not a DOM toast/badge (unreliable
    // headless). Arm the wait BEFORE the click.
    const addResp = await (async () => {
      const promise = page
        .waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            /\/cart-items(\?|$)/.test(r.url()),
          { timeout: 60_000 },
        )
        .catch(() => null);
      await addToCart.click({ timeout: 5_000 });
      return promise;
    })();
    expect(
      addResp,
      "STEP: no cart-items POST was observed after clicking add-to-cart.",
    ).toBeTruthy();
    const status = addResp!.status();
    expect(
      status,
      `STEP: cart-items responded HTTP ${status}, expected 200.`,
    ).toBe(200);
  });

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

  // ★ A live run showed a generic `app-modal-message` (`role="dialog"`, `.weg-modal-container`)
  // still `class="visible"` after the step above, intercepting pointer events on the hamburger
  // panel's Sign Out button for the full 30s timeout even though Playwright reported the button
  // itself "visible, enabled and stable" -- i.e. some dialog the ".close-button"/
  // ".close-button-container" locators above didn't match was still open. `app-modal-message` is
  // a shared, generic message-dialog wrapper (confirmed live by decompiling the production
  // Angular bundle) reused across the checkout/payment surfaces for various confirmations, so its
  // exact copy/buttons vary by cart and payment-method state and can't be enumerated in advance
  // without live credentials. Defensively close ANY such dialog that's still open before
  // attempting to open the hamburger panel, rather than trying to name every possible instance.
  await step("dismiss any lingering checkout dialog", async () => {
    // ★ A second live run showed this step ITSELF hang for the full 30s on
    // `dismissButton.click()`, even though `waitFor({state:"visible"})` had just confirmed the
    // button visible. `state: "visible"` only checks the element is rendered/non-zero-size --
    // Playwright's plain `.click()` additionally waits for the target to "receive events" (not
    // covered by another element), and it's exactly that second check hanging -- the same
    // pointer-interception failure mode this step was added to work around, just one layer
    // deeper (a stacked dialog, or the dialog's own close icon sitting under a sibling
    // overlay/backdrop). This step is best-effort cleanup, not a correctness assertion, so bypass
    // the interception check entirely with `force: true` and a short per-attempt timeout, and try
    // more than once in case dialogs are stacked. Every action here is try/caught so this step
    // can never itself hang or fail the run -- worst case it's a no-op and the "sign out" step's
    // own generous timeouts are left to do the real work.
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.keyboard.press("Escape").catch(() => {});

      const openDialog = page
        .getByRole("dialog")
        .filter({ visible: true })
        .first();
      const dialogVisible = await openDialog
        .waitFor({ state: "visible", timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (!dialogVisible) return;

      const dismissButton = openDialog
        .getByRole("button", {
          name: /^(close|cancel|ok|got it|continue|dismiss)$/i,
        })
        .or(openDialog.locator(".close-button, .close-button-container"))
        .filter({ visible: true })
        .first();
      const dismissVisible = await dismissButton
        .waitFor({ state: "visible", timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (dismissVisible) {
        await dismissButton
          .click({ force: true, timeout: 5_000 })
          .catch(() => {});
      }
    }
  });

  await step("sign out", async () => {
    // Open the account hamburger panel (the real trigger, confirmed live -- see the
    // `hamburgerMenu` note above) rather than looking for a bare "Sign Out" role match: the
    // Sign Out button only exists inside this panel, per the decompiled bundle
    // (`signOutClickEvent` is only wired on the hamburger-menu template).
    // ★ Two live runs have now shown a leftover checkout dialog intercept pointer events on this
    // panel/button even after the resolved locator is reported "visible, enabled and stable" --
    // and the "dismiss any lingering checkout dialog" step above is only best-effort (it never
    // throws). Rather than risk a third 30s hang on the same root cause, force these three
    // clicks: the locators above are already scoped tightly enough (page-scoped hamburger id,
    // role + name-filtered sign-out controls) that `force: true` -- which only skips the
    // "receives pointer events" actionability check, not locator resolution -- can't misfire onto
    // an unrelated element; it just stops an intercepting overlay from blocking the click
    // forever.
    await hamburgerMenu().click({ force: true, timeout: 10_000 });

    const signOutLink = page
      .getByRole("link", { name: /sign out/i })
      .or(page.getByRole("button", { name: /sign out/i }))
      .filter({ visible: true })
      .first();
    await expect(signOutLink, "STEP: sign-out link not visible.").toBeVisible({
      timeout: 20_000,
    });
    await signOutLink.click({ force: true, timeout: 10_000 });

    // Sign out is confirmed via a modal dialog ("Are you sure you want to sign out?" with
    // Cancel / Sign out actions), confirmed live in the decompiled bundle.
    const confirmSignOut = page
      .getByRole("button", { name: /sign out/i })
      .filter({ visible: true })
      .first();
    const confirmVisible = await confirmSignOut
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmVisible)
      await confirmSignOut.click({ force: true, timeout: 10_000 });

    // Post-sign-out, the landing page's greeting reverts to a "Sign in" BUTTON (not a link --
    // matches the same `.greeting-sign-in` element used to start this flow).
    await expect(
      page
        .locator(".greeting-sign-in")
        .or(page.getByRole("button", { name: /^sign in$/i }))
        .or(page.getByRole("link", { name: /sign in|register/i }))
        .filter({ visible: true })
        .first(),
      "STEP: sign-in affordance did not reappear after sign out.",
    ).toBeVisible({ timeout: 20_000 });
  });
});
