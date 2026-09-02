import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-northside-wine-spirits
 *
 * Converted from Dynatrace "Northside Wine & Spirits Terraform(https://www.northsidewine.com/)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: Northside Wine & Spirits homepage loads", async ({ page }) => {
  await step("open https://www.northsidewine.com/", async () => {
    await page.goto("https://www.northsidewine.com/", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Northside Wine\s*&\s*Spirits/i.test(title),
      `expected page title to match /Northside Wine\\s*&\\s*Spirits/i, got "${title}"`,
    ).toBeTruthy();
  });
});
