import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-century-liquor-wines
 *
 * Converted from Dynatrace "Century Liquor & Wines Terraform(http://www.centuryliquorandwines.com/)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: Century Liquor & Wines homepage loads", async ({ page }) => {
  await step("open http://www.centuryliquorandwines.com/", async () => {
    await page.goto("http://www.centuryliquorandwines.com/", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Century/i.test(title),
      `expected page title to match /Century/i, got "${title}"`,
    ).toBeTruthy();
  });
});
