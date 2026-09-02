import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-amherst-wine-liquor
 *
 * Converted from Dynatrace "Amherst St Wine & Liquor Terraform(http://www.amherstwineandliquor.com/)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: Amherst St Wine & Liquor homepage loads", async ({ page }) => {
  await step("open http://www.amherstwineandliquor.com/", async () => {
    await page.goto("http://www.amherstwineandliquor.com/", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Amherst St\.?\s*Wine\s*&\s*Liquor/i.test(title),
      `expected page title to match /Amherst St\\.?\\s*Wine\\s*&\\s*Liquor/i, got "${title}"`,
    ).toBeTruthy();
  });
});
