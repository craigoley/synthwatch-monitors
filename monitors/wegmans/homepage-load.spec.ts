import { test, expect, step, dismissInterstitials } from '../../lib/flow';

/**
 * Monitor: wegmans-homepage-load
 *
 * Journey: load wegmans.com → assert the homepage BODY content pipeline actually
 * rendered (first-party content calls returned 200 AND the body content modules
 * mounted), not merely that the persistent header shell exists.
 *
 * This is the simplest, highest-impact monitor: if wegmans.com itself is down,
 * every other journey fails too. Runs at a shorter interval than journey monitors.
 *
 * ★ WHY THESE GATES ARE STRONG (the acceptance question: "if the homepage BODY/
 *   content pipeline broke while the shared header still rendered, would this go
 *   RED?" — YES, by four independent mechanisms). This spec REPLACES two vacuous
 *   chrome gates (a /meals (&|and) recipes/i header link + a /shop/i header link)
 *   that were the SAME failure mode as the shop-flow login-on-chrome bug (#79):
 *   both old gates live in the persistent <header> (VERIFIED live 2026-07-12:
 *   "Meals & Recipes" and a[href*="/shop"]="/shop/coupons" are both inHeader:true,
 *   inMain:false), so a homepage content outage that left the header intact kept
 *   the monitor GREEN. Every gate below is instead a first-party 200 result or a
 *   <main>-scoped content module that is ABSENT when the content pipeline fails.
 *   (All four VERIFIED against the live DOM + a real passing runner trace, check
 *   223 network: /api/stores=200, images.wegmans.com/is/image/wegmanscsprod hero
 *   =200; live DOM: main .component--hero-block visible, 174 main .component--
 *   product-tile, 208 wegmanscsprod imgs in <main> / 0 in <header>.)
 */

// First-party content-image path (Adobe Scene7 CMS, "wegmanscsprod" = Wegmans Content Server prod).
// The homepage BODY's hero/promo/product imagery is served from here — ABSENT if the CMS/content
// pipeline fails. Matched on the PATH (host-agnostic) so a CDN/host move is not a false red (#93 lesson:
// never hardcode a .com-only host gate that could miss the real host).
const HERO_CMS_IMG = /\/is\/image\/wegmanscsprod\//i;

// The homepage's first-party JSON API (Next.js route on the wegmans origin). Accept *.wegmans.(com|cloud)
// so the real prod host is never missed (#93). Its 200 proves the first-party API layer is up.
function isFirstPartyStoresApi(url: string, status: number): boolean {
  if (status !== 200) return false;
  try {
    const u = new URL(url);
    return /(^|\.)wegmans\.(com|cloud)$/.test(u.hostname.toLowerCase()) && /^\/api\/stores(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

test('Wegmans: homepage loads', async ({ page }) => {
  // ARM the first-party content gates BEFORE navigating (else the responses race past us).
  // .catch(() => null) converts an absence/timeout into a hard failure at the toBeTruthy() below —
  // it does NOT swallow the failure.
  const storesResp = page
    .waitForResponse((r) => isFirstPartyStoresApi(r.url(), r.status()), { timeout: 30_000 })
    .catch(() => null);
  const heroResp = page
    .waitForResponse((r) => HERO_CMS_IMG.test(r.url()) && r.status() === 200, { timeout: 30_000 })
    .catch(() => null);

  await step('open wegmans.com', async () => {
    await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  await step('assert first-party content calls returned 200', async () => {
    // GATE 1 — first-party API layer. A homepage that renders a header shell over a dead API backend
    // never produces this 200 → null → RED. (Mirrors meals2go-homepage app-config===200 / autocomplete
    // /queries===200.)
    const stores = await storesResp;
    expect(stores, 'homepage first-party API www.wegmans.com/api/stores did not return 200 — the API backend is down (a header-only shell would hide this)').toBeTruthy();

    // GATE 2 — CMS content pipeline. The BODY's hero/promo/product imagery is served from the Scene7
    // "wegmanscsprod" path. If the content pipeline breaks, the body has no content-image URLs to fetch
    // → no such 200 → null → RED. This is the gate that specifically answers "body broke, header intact".
    const hero = await heroResp;
    expect(hero, 'homepage CMS content image (/is/image/wegmanscsprod/...) did not return 200 — the content/promo pipeline is broken even if the header rendered').toBeTruthy();
  });

  await step('assert homepage BODY content rendered', async () => {
    await dismissInterstitials(page);
    // GATE 3 — the hero MODULE mounted in <main> (NOT the header). VERIFIED: main .component--hero-block
    // is visible on a healthy homepage and lives in <main>, never <header>. Absent when the body render
    // fails, so it cannot be satisfied by the persistent header/footer shell.
    await expect(
      page.locator('main .component--hero-block').first(),
      'homepage hero block (main .component--hero-block) did not render — the body content pipeline failed (this element is in <main>, never the header shell, so it goes red where the old chrome gates stayed green)',
    ).toBeVisible({ timeout: 15_000 });

    // GATE 4 — a product/department carousel tile mounted in <main>. VERIFIED: 174 main .component--
    // product-tile on a healthy homepage, 0 in <header>. Renders from the product/content feed → absent
    // when that feed is broken.
    await expect(
      page.locator('main .component--product-tile').first(),
      'homepage product carousel tiles (main .component--product-tile) did not render — the product/content feed is broken (body-scoped; never present in the header shell)',
    ).toBeVisible({ timeout: 15_000 });
  });
});
