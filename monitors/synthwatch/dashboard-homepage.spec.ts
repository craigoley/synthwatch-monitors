import { test, expect, step } from '../../lib/flow';

/**
 * Monitor: synthwatch-self-homepage  (TEMPLATE / example — demonstrates the STRONG pattern)
 *
 * Loads the SynthWatch dashboard and asserts the monitor grid actually WORKS — not merely
 * that the page shell rendered. This file is the copy-paste starting point for new monitors,
 * so it deliberately models the pattern the fleet uses: a first-party API RESULT (200) +
 * a rendered-DATA assertion, never a page-shell/heading/URL match that is true on an error page.
 *
 * ★ WHY THE OLD VERSION WAS WEAK (2026-07-12 Fleet Assertion Audit): it asserted only a
 *   `urlPattern` (true for ANY page on the host, incl. an error deploy) + a `getByRole('heading',
 *   {name:/monitors/i})`. Both are present regardless of whether the data layer works — so the
 *   dashboard could render with ZERO monitors, or over a dead SynthWatch API, and stay GREEN
 *   (100% pass / 30d, never exercised a failure — the shop-flow's exact profile). The grid is
 *   rendered client-side from synthwatch-api.azurewebsites.net/api/checks (VERIFIED live network
 *   2026-07-12); each monitor is a card linking to /checks/<id> (VERIFIED live: 37 such cards in
 *   <main>). The gates below cannot be satisfied by a shell over a dead API.
 *
 * To add a new monitor: copy this file, write the journey as named steps with resilient locators,
 * and — critically — assert a first-party API 200 and/or a data artifact that is ABSENT when the
 * feature is broken (not chrome, not a URL match, not an always-present heading).
 */

// The dashboard's grid data source (Next/Vercel client fetch → the SynthWatch API). Match the exact
// PATH host-agnostically (never a hardcoded host that a domain move could silently miss — the #93 lesson);
// its 200 proves the data layer that populates the grid is alive.
function isChecksApi(url: string, status: number): boolean {
  if (status !== 200) return false;
  try {
    return new URL(url).pathname === '/api/checks';
  } catch {
    return false;
  }
}

test('SynthWatch dashboard loads', async ({ page }) => {
  // ARM the grid's data-source gate BEFORE navigating (else the fetch races past us). .catch(() => null)
  // converts an absence/timeout into a hard failure at toBeTruthy() below — it does NOT swallow it.
  const checksResp = page
    .waitForResponse((r) => isChecksApi(r.url(), r.status()), { timeout: 30_000 })
    .catch(() => null);

  await step('open the dashboard', async () => {
    await page.goto('https://synthwatch-dashboard.vercel.app', { waitUntil: 'domcontentloaded' });
  });

  await step('assert the grid data source returned 200', async () => {
    // GATE 1 — first-party API result. A dashboard shell rendered over a dead SynthWatch API never
    // produces this 200 → null → RED. (Mirrors meals2go-homepage app-config===200 / autocomplete
    // /queries===200.)
    const checks = await checksResp;
    expect(
      checks,
      'SynthWatch dashboard: GET /api/checks did not return 200 — the data layer that renders the monitor grid is down (a page shell / "Monitors" heading would hide this).',
    ).toBeTruthy();
  });

  await step('assert the monitor grid rendered rows', async () => {
    // GATE 2 — rendered DATA. Each monitor is a card linking to /checks/<id> in <main>. A dead/empty
    // data layer renders ZERO cards even though the shell + "Monitors" heading are present. Asserting
    // the grid has rows (count > 0) + the first card is visible is the signal that CANNOT be true when
    // the fleet view is broken. Count (not an exact number) keeps it robust to fleet-size changes.
    const cards = page.locator('main a[href*="/checks/"]');
    // Wait for the grid to PAINT its first card (a CEILING — free unless hit) BEFORE counting. This is the
    // load-bearing red-on-empty gate: a genuinely empty grid (dead data layer) never paints a card, so this
    // times out at 15s → throws → RED. It also fixes a paint-race that produced 4 spurious "0 rows" reds
    // (2026-07-12, verified: /api/checks returned 200 with data — checks 4 + 33 were green — but the client
    // had not yet rendered the /checks/<id> cards when the OLD code read count() the instant the 200 landed).
    await expect(
      cards.first(),
      'SynthWatch dashboard: the monitor grid rendered 0 rows — /api/checks returned no monitors or the client failed to render them (the shell + heading still render, so a vacuous check would stay green here).',
    ).toBeVisible({ timeout: 15_000 });
    // With the grid painted, the count is now stable — assert ≥1 row (documents the "grid has rows" intent;
    // guaranteed once the first card is visible, so this is belt-and-suspenders, not the race-prone gate).
    const n = await cards.count();
    expect(n, `SynthWatch dashboard: expected ≥1 monitor card, counted ${n}.`).toBeGreaterThan(0);

    // Supplementary (NOT load-bearing): the Monitors view heading. Kept as a shell signal, but it can
    // no longer carry a pass on its own — GATE 1 + GATE 2 above are the functional gates.
    await expect(
      page.getByRole('heading', { name: /monitors/i }).first(),
      'SynthWatch dashboard: the "Monitors" heading did not render — the app shell failed to load.',
    ).toBeVisible({ timeout: 15_000 });
  });
});
