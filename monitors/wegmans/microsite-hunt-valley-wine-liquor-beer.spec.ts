import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-hunt-valley-wine-liquor-beer
 *
 * Converted from Dynatrace "Hunt Valley Wine, Liquor & Beer Terraform(https://www.huntvalleywineandspirits.com/)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: Hunt Valley Wine, Liquor & Beer homepage loads", async ({
  page,
}) => {
  await step("open https://www.huntvalleywineandspirits.com/", async () => {
    await page.goto("https://www.huntvalleywineandspirits.com/", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Hunt Valley Wine,?\s*Liquor\s*&\s*Beer/i.test(title),
      `expected page title to match /Hunt Valley Wine,?\\s*Liquor\\s*&\\s*Beer/i, got "${title}"`,
    ).toBeTruthy();
  });
});
