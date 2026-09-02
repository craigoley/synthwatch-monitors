import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-burger-bar
 *
 * Converted from Dynatrace "The Burger Bar by Wegmans Terraform(https://www.wegmansburgerbar.com)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: The Burger Bar by Wegmans homepage loads", async ({
  page,
}) => {
  await step("open https://www.wegmansburgerbar.com", async () => {
    await page.goto("https://www.wegmansburgerbar.com", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Burger Bar/i.test(title),
      `expected page title to match /Burger Bar/i, got "${title}"`,
    ).toBeTruthy();
  });
});
