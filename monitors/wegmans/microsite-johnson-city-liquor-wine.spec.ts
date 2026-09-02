import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-johnson-city-liquor-wine
 *
 * Converted from Dynatrace "Johnson City Liquor and Wine Terraform(https://www.jcwineandspirits.com/)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: Johnson City Liquor and Wine homepage loads", async ({
  page,
}) => {
  await step("open https://www.jcwineandspirits.com/", async () => {
    await page.goto("https://www.jcwineandspirits.com/", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Johnson City Liquor and Wine/i.test(title),
      `expected page title to match /Johnson City Liquor and Wine/i, got "${title}"`,
    ).toBeTruthy();
  });
});
