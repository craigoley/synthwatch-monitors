import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-aa-wines-spirits
 *
 * Converted from Dynatrace "A&A Wines & Spirits Terraform(http://aandawineandspirits.com)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: A&A Wines & Spirits homepage loads", async ({ page }) => {
  await step("open http://aandawineandspirits.com", async () => {
    await page.goto("http://aandawineandspirits.com", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /A&A Wine\s*&\s*Spirits/i.test(title),
      `expected page title to match /A&A Wine\\s*&\\s*Spirits/i, got "${title}"`,
    ).toBeTruthy();
  });
});
