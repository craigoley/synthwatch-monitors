import { test, expect, step, dismissInterstitials } from "../../lib/flow";

/**
 * Monitor: microsite-lake-grove-wine-spirits
 *
 * Converted from Dynatrace "Lake Grove Wine & Spirits Terraform(https://lakegrovewineandspirits.com/)" -- a simple, unauthenticated
 * homepage-load check for this externally hosted Wegmans-affiliated microsite. The
 * source TF only navigates and asserts a content_match on the page identifying text;
 * this spec reproduces that as a page-title check.
 *
 * ⚠ KNOWN RISK (observed during conversion, headless Chromium, residential IP): this origin
 * serves a Cloudflare "Attention Required" bot-challenge interstitial to the request, returning
 * an empty page title instead of the real one. This may not reproduce from a datacenter/allowlisted
 * egress or from Dynatrace's synthetic locations, but it is a real, reproducible failure mode worth
 * validating from the target egress before enabling this monitor.
 */
test("Microsite: Lake Grove Wine & Spirits homepage loads", async ({
  page,
}) => {
  await step("open https://lakegrovewineandspirits.com/", async () => {
    await page.goto("https://lakegrovewineandspirits.com/", {
      waitUntil: "domcontentloaded",
    });
    await dismissInterstitials(page);
  });

  await step("verify site identity renders", async () => {
    const title = await page.title();
    expect(
      /Lake Grove Wine\s*&\s*Spirits/i.test(title),
      `expected page title to match /Lake Grove Wine\\s*&\\s*Spirits/i, got "${title}"`,
    ).toBeTruthy();
  });
});
