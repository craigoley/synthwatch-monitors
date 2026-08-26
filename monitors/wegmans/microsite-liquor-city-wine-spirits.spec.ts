import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-liquor-city-wine-spirits
 *
 * Converted from Dynatrace "Liquor City Wine & Spirits Terraform(https://liquorcitywineandspirits.com/)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 */
test("Microsite: Liquor City Wine & Spirits homepage loads", async ({
  page,
}) => {
  await step("open https://liquorcitywineandspirits.com/", async () => {
    await page.goto("https://liquorcitywineandspirits.com/", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Liquor City Wine\s*&\s*Spirits/i.test(title),
      `expected page title to match /Liquor City Wine\\s*&\\s*Spirits/i, got "${title}"`,
    ).toBeTruthy();
  });
});
