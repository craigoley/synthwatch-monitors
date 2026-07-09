import { test, expect, step, dismissInterstitials, credential, type Page } from '../../lib/flow';

/**
 * Monitor: wegmans-full-shop-flow — ★ FULL AUTHENTICATED PICKUP SHOPPING FLOW (SENSITIVE; ships DISABLED)
 *
 * Journey: login → search+add milk/eggs/bread/bananas → verify 4 in cart → checkout as PICKUP → confirm
 * pickup TIMESLOTS render + are selectable → SELECT a slot → return to cart → clear cart → logout.
 * Destined to be SCHEDULED (interval 900s, eastus2 + centralus). Built to that bar: deterministic,
 * clean teardown, hard run-cap, no production footprint. Ships enabledByDefault:false for on-demand
 * validation first.
 *
 * ★★ SELECTOR-VERIFICATION STATUS (read before trusting a red run) ★★
 * REUSED + already-live-verified (proven in shipped specs — cited inline):
 *   • login: the B2C form ids (#signInName/#password/#next) + the myaccount.wegmans.com bypass-header
 *     scoped route + b2c's PROVEN completion signal — a real token-acquisition network event
 *     (isTokenEvent) AND LOGGED_IN_AFFORDANCE_RX — from b2c-login-test.spec.ts (#52/#60). The
 *     affordance ALONE was insufficient (it matches always-present nav chrome → false-green on an
 *     aborted auth POST); requiring the token event is what makes login must-go-red.
 *   • search + first result: /shop/search?query=… + a[href*="/shop/product/"] — from search-product.spec.ts.
 *   • redaction/diag: safeLoc/safeLabel/isVisibleSafe/collectLabels + the survival-fixed emit — from
 *     b2c-login-test.spec.ts (#57/#59).
 * NET-NEW + ★ NOT YET LIVE-VERIFIED (authored resilient/structural; the wegmans.com AUTHENTICATED cart/
 * checkout/pickup/timeslot/clear-cart DOM could not be driven from the authoring session — no test creds
 * + Akamai bot-block from a non-allowlisted IP): add-to-cart, verify-cart-4, checkout-pickup,
 * timeslots-render, select-slot, return-cart, clear-cart, logout. Each is wrapped so a failing step emits
 * a STRUCTURAL diag (STEP-FAIL … DIAG) capturing the real DOM → Craig's FIRST sandbox fire verifies and
 * corrects each selector from the diag (the b2c ship-disabled-then-fix-from-diag pattern). ★ DO NOT
 * SCHEDULE until every net-new step is proven green + clean-teardown across several on-demand fires.
 *
 * ★★ CONCURRENCY (option 3 — offset cron per region; Craig's decision) ★★
 * One SHARED test account, mutated cart. Protection is TWO-PART:
 *   (a) OFFSET CRON (dashboard-owned config Craig sets in SynthWatch, NOT here): eastus2 at :00/:30,
 *       centralus at :15/:45 → the two regions never touch the account at the same time.
 *   (b) HARD IN-SPEC RUN-CAP (RUN_CAP_MS below): a run aborts to teardown well before the next tick of
 *       EITHER region, so a slow run can NEVER structurally bleed into the next same-region tick and
 *       collide on the shared account. This is the guard offset-cron alone does not provide.
 * (Regions/cron are dashboard-owned per the reconcile field-split — set them in SynthWatch, not the
 * manifest. Interval 900s + enabledByDefault:false are declared in manifest.json.)
 *
 * ★★ TIMESLOT SAFETY (Craig-confirmed) ★★ Selecting a pickup slot does NOT hold capacity until
 * ORDER PLACEMENT. So select-slot is safe to run scheduled. ★ This monitor NEVER places the order:
 * it clicks a slot to prove selectability, then returns to cart and clears it. No "Place order" /
 * "Submit order" control is ever clicked (see the guard in select-slot).
 *
 * ★ TEARDOWN IN finally: clear-cart + logout run even on mid-flow failure — a scheduled monitor must
 * never leave a full cart / live session for the next run (a dirty run poisons its own next run).
 *
 * sensitive=true: real login. redact_patterns (manifest) + the built-in denylist scrub Bearer/JWT/
 * B2C-session values; all diag is safeLoc(url host/path) + safeLabel(PII-filtered) + booleans — never
 * creds/DOM/token.
 */

// ── Config ────────────────────────────────────────────────────────────────────────────────────────
const SHOPPING_ITEMS = ['milk', 'eggs', 'bread', 'bananas'] as const;
const B2C_HOST = 'myaccount.wegmans.com';
const BYPASS_HEADER = 'x-vercel-protection-bypass';
/** Hard wall-clock cap: abort to teardown before this. Kept well under the runner's per-run budget AND
 *  the 15-min tick so a run can't bleed into the next tick (concurrency axis b). */
const RUN_CAP_MS = 200_000;
const STEP_TIMEOUT = 20_000;
const LOGGED_IN_AFFORDANCE_RX = /account|profile|orders|my wegmans|rewards|sign ?out|log ?out|hello|welcome/i;

// ── Redaction-safe helpers (inlined; a spec cannot import another spec — lib/* won't resolve at runtime) ──
/** host + pathname only — drops query/fragment where tokens live. Safe to log. */
function safeLoc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable-url)';
  }
}
/** A B2C token-acquisition network event: the B2C token endpoint (2xx/3xx), a redirect back to a wegmans
 *  host carrying an auth code/id_token, or the SelfAsserted "confirmed" step. We only INSPECT r.url();
 *  we NEVER log its query (tokens live there). ★ Ported verbatim from b2c-login-test.spec.ts — this is
 *  the PROVEN completion signal that b2c GREENs on (#60). Login only fires this after a real, completed
 *  B2C auth; an aborted sign-in POST (trace run 925142: status -1) fires NONE → the login step REDs. */
function isTokenEvent(status: number, url: string): boolean {
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  const tokenEndpoint = /\/oauth2\/v2\.0\/token/i.test(url) && status >= 200 && status < 400;
  const codeRedirectToWegmans = /(^|\.)wegmans\.com$/.test(host) && /[?#&](code|id_token|access_token)=/.test(url);
  const b2cConfirmed = /\/api\/CombinedSigninAndSignup\/confirmed/i.test(url) && status >= 200 && status < 400;
  return tokenEndpoint || codeRedirectToWegmans || b2cConfirmed;
}
const SAFE_LABEL_ALLOWLIST = new Set([
  'account', 'my account', 'your account', 'my wegmans', 'rewards', 'sign out', 'log out', 'logout',
  'sign in', 'log in', 'orders', 'my orders', 'profile', 'cart', 'view cart', 'checkout', 'shop', 'help',
  'home', 'menu', 'search', 'store', 'stores', 'pickup', 'delivery', 'add to cart', 'remove', 'reserve',
]);
/** Redact a control label: greetings (account-name PII the runner redactor won't scrub) → ‹greeting›;
 *  known nav labels pass; anything else → ‹control›. Structural signal only. */
function safeLabel(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n || n.length > 40) return n ? '‹control›' : '';
  if (/^(hi|hello|hey|welcome|greetings|good (morning|afternoon|evening))\b/i.test(n)) return '‹greeting›';
  return SAFE_LABEL_ALLOWLIST.has(n.toLowerCase()) ? n : '‹control›';
}
type Loc = ReturnType<Page['locator']>;
async function isVisibleSafe(loc: Loc): Promise<boolean> {
  try {
    return await loc.first().isVisible({ timeout: 1000 });
  } catch {
    return false;
  }
}
async function countSafe(loc: Loc): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return -1;
  }
}
async function collectLabels(loc: Loc, scanCap: number, out: string[]): Promise<void> {
  const n = Math.min(await loc.count().catch(() => 0), scanCap);
  for (let i = 0; i < n && out.length < 10; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const label = safeLabel(await el.innerText({ timeout: 200 }).catch(() => ''));
    if (label && !out.includes(label)) out.push(label);
  }
}
const loggedInAffordance = (page: Page) =>
  page.getByRole('link', { name: LOGGED_IN_AFFORDANCE_RX }).or(page.getByRole('button', { name: LOGGED_IN_AFFORDANCE_RX }));

// ── Add-to-cart transform confirmation (this PR) ─────────────────────────────────────────────────────
// GROUND TRUTH (Craig's screenshots of the real wegmans.com/shop add-to-cart interaction — DEFINITIVE):
// add-to-cart is a SINGLE CLICK. On a PDP the "Add to Cart" button TRANSFORMS IN PLACE into a quantity
// stepper — [remove/trash] [qty e.g. "1"] [+] — and on search results the "+" circle becomes a filled
// "1". Same control, NO modal/dialog. That in-place transform IS the success confirmation. The prior
// ADD-DIAG's `dlg1` "dialog seen" reading was a FALSE POSITIVE — it misread the transformed stepper as a
// modal (there is no add-to-cart dialog). The earlier `cw0` (zero cart-writes observed at /shop/cart)
// came from the flow moving on to the cart before the write flushed server-side. So this step now: clicks
// ONCE, ARMS ON the stepper transform as the positive signal, THEN lets the cart-write settle (network
// event / badge increment) before advancing. All captured evidence is DOM structure / URL host+path /
// booleans — never creds, token, or page HTML.

/** Armed visibility probe for the post-click DOM delta — resolves true if the locator becomes visible
 *  within ms, false otherwise. NOT a hard wait: it is an awaited waitFor that returns as soon as it
 *  resolves (or times out). Used to record WHICH affordance the add-to-cart click surfaced. */
async function appearsWithin(loc: Loc, ms: number): Promise<boolean> {
  return loc
    .first()
    .waitFor({ state: 'visible', timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/** Best-effort header cart-count badge read (CASE d: did the click increment the cart?). Tries the
 *  common badge shapes, then a cart link/button aria-label "N items". Returns the integer or null when
 *  no numeric badge is found. Structural only — reads a small count string, never account data. */
async function readCartCount(page: Page): Promise<number | null> {
  const badgeSelectors = [
    '[data-testid*="cart-count" i]',
    '[data-testid*="cart" i] [class*="count" i]',
    'a[href*="/cart" i] [class*="badge" i], a[href*="/cart" i] [class*="count" i]',
    '[class*="cart" i] [class*="badge" i], [class*="cart" i] [class*="count" i]',
  ];
  for (const sel of badgeSelectors) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count().catch(() => 0)) {
      const t = (await loc.innerText({ timeout: 400 }).catch(() => '')).trim();
      const m = t.match(/\d+/);
      if (m) return parseInt(m[0], 10);
    }
  }
  const cartCtl = page.getByRole('link', { name: /cart/i }).or(page.getByRole('button', { name: /cart/i })).first();
  const al = await cartCtl.getAttribute('aria-label').catch(() => null);
  if (al) {
    const m = al.match(/(\d+)\s*(item|product)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** Capture the add-to-cart button's own state BEFORE the click (CASE 1: decoy/disabled/off-screen).
 *  Bounding-box + attributes + class list are DOM structure, not PII. Guarded; null on any failure. */
async function readAddButtonState(
  loc: Loc,
): Promise<{ dis: boolean; ariaDis: string | null; ariaHid: string | null; onScreen: boolean; box: string; cls: string } | null> {
  return loc
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      return {
        dis: el.hasAttribute('disabled') || (el as HTMLButtonElement).disabled === true,
        ariaDis: el.getAttribute('aria-disabled'),
        ariaHid: el.getAttribute('aria-hidden'),
        onScreen: r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0,
        box: `${Math.round(r.width)}x${Math.round(r.height)}`,
        cls: (el.getAttribute('class') || '').slice(0, 100),
      };
    })
    .catch(() => null);
}

/**
 * ★ STRUCTURAL, REDACTION-SAFE step-failure diagnostic (reuses the b2c OTHER-DIAG design + its
 * survival fix). Everything is structure / URL host+path / PII-filtered labels — NO page.content(),
 * no input values, no creds/token. Returns {full (for Node stdout), compact (≤195, for the persisted
 * channels: page-console.warn → trace_signals.console, and the thrown error → error_message)}.
 */
async function captureStepDiag(page: Page, stepName: string): Promise<{ full: string; compact: string }> {
  const b = (v: boolean) => (v ? '1' : '0');
  const loggedIn = await isVisibleSafe(loggedInAffordance(page));
  const signInFormPresent = await isVisibleSafe(page.locator('#signInName, #password'));
  const cartPresent = await isVisibleSafe(page.locator('[class*="cart" i], [data-testid*="cart" i]').first());
  const checkoutPresent = await isVisibleSafe(
    page.getByRole('button', { name: /checkout|proceed/i }).or(page.locator('[class*="checkout" i]')),
  );
  const fulfillmentModalPresent = await isVisibleSafe(
    page.getByText(/pickup|delivery|how (do|would) you|choose (a|your) store|shopping mode/i),
  );
  const timeslotPresent = await isVisibleSafe(
    page.locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]').or(page.getByText(/pick up (between|at)|reserve (a )?time|available times?/i)),
  );
  const itemUnavailable = await isVisibleSafe(page.getByText(/unavailable|out of stock|not available|sold out/i));
  const counts = {
    links: await countSafe(page.getByRole('link')),
    buttons: await countSafe(page.getByRole('button')),
    inputs: await countSafe(page.locator('input')),
  };
  const visibleControls: string[] = [];
  await collectLabels(page.getByRole('button'), 16, visibleControls).catch(() => {});
  await collectLabels(page.getByRole('link'), 12, visibleControls).catch(() => {});

  const full = JSON.stringify({
    step: stepName,
    finalUrl: safeLoc(page.url()),
    found: { loggedIn, signInFormPresent, cartPresent, checkoutPresent, fulfillmentModalPresent, timeslotPresent, itemUnavailable, counts, visibleControls },
  });
  const flags = `li${b(loggedIn)}sgn${b(signInFormPresent)}cart${b(cartPresent)}chk${b(checkoutPresent)}ful${b(fulfillmentModalPresent)}slot${b(timeslotPresent)}oos${b(itemUnavailable)}`;
  const ctrls = visibleControls.slice(0, 3).join(',').slice(0, 40);
  const compact = `[full-shop-flow] STEP-FAIL ${stepName} url=${safeLoc(page.url()).slice(0, 50)} f=${flags} c=[${ctrls}]`.slice(0, 195);
  return { full, compact };
}

/** Wrap a labeled step so the runner funnel shows where it broke AND a failure emits the structural diag
 *  to the persisted channels (page-console → trace_signals.console; thrown error → error_message). */
async function runStep(page: Page, name: string, body: () => Promise<void>): Promise<void> {
  return step(name, async () => {
    try {
      await body();
    } catch (err) {
      const d = await captureStepDiag(page, name).catch(() => ({ full: '', compact: '' }));
      console.log(`[full-shop-flow] STEP-FAIL ${name} DIAG ${d.full}`); // Node stdout (deep-dive)
      if (d.compact) await page.evaluate((m) => console.warn(m), d.compact).catch(() => {}); // → trace_signals.console
      throw new Error(`${d.compact || `[full-shop-flow] step "${name}" failed`} :: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

test('Wegmans: full authenticated pickup shopping flow', async ({ page }) => {
  // Creds from credential() ONLY (model-B) — check 355's UI-set login_credentials, decrypted + published by
  // the runner as SW_CRED_<ROLE> (credential('username') → SW_CRED_USERNAME; env-mapping proven exact +
  // fail-closed in b2c #64). credential() throws on unset/empty → a broken cred path REDS loudly. No env
  // fallback: the shop-flow has no green baseline to protect (never passed), so fail-closed is exactly right.
  const username = credential('username');
  const password = credential('password');
  // ★ RESOLUTION SIGNAL (value-free): reaching this line means credential() resolved BOTH (else it threw) —
  // this is the shop-flow's FIRST-EVER cred resolution. Lands in the runner container logs. NEVER the value.
  console.log('[full-shop-flow] cred-source username=credential password=credential (model-B; credential()-only)');
  const bypassToken = process.env.VERCEL_BYPASS_TOKEN;
  const startedAt = Date.now();
  const abortIfOverCap = () => {
    if (Date.now() - startedAt > RUN_CAP_MS) {
      throw new Error(`[full-shop-flow] run-cap ${Math.round(RUN_CAP_MS / 1000)}s exceeded — aborting to teardown (concurrency guard).`);
    }
  };

  // Reuse b2c: the runner injects the bypass header for www.wegmans.com but NOT myaccount.wegmans.com
  // (PROTECTED_BYPASS_HOSTS omits it) — inject it host-scoped here so the login redirect carries it.
  let bypassAppliedToB2C = false;
  await page.route(`https://${B2C_HOST}/**`, async (route) => {
    const req = route.request();
    if (bypassToken) {
      bypassAppliedToB2C = true;
      await route.continue({ headers: { ...req.headers(), [BYPASS_HEADER]: bypassToken } });
    } else {
      await route.continue();
    }
  });

  try {
    // ---- STEP: login (REUSED selectors from b2c-login-test) ----------------------------------------
    await runStep(page, 'login', async () => {
      await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      const signIn = page
        .getByRole('link', { name: /sign ?in|log ?in/i })
        .or(page.getByRole('button', { name: /sign ?in|log ?in/i }))
        .filter({ visible: true })
        .first();
      if (await signIn.isVisible({ timeout: 8000 }).catch(() => false)) await signIn.click({ timeout: 5000 });
      await dismissInterstitials(page);
      await page.locator('#signInName').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await page.locator('#signInName').first().fill(username);
      await page.locator('#password').first().fill(password);
      const submit = page
        .locator('#next, #continue')
        .or(page.getByRole('button', { name: /sign ?in|log ?in|continue|next/i }))
        .filter({ visible: true })
        .first();
      await expect(submit, 'login: B2C SelfAsserted submit button not found on the sign-in form').toBeVisible({ timeout: 10_000 });
      // ★ ROOT-CAUSE FIX (trace run 925142): the OLD login confirmed ONLY on loggedInAffordance —
      // but that regex matches always-present nav/footer chrome (account/orders/rewards…), so an
      // ABORTED sign-in POST (status -1) false-GREENed here and the flow shopped UNAUTHENTICATED,
      // reding 4 steps later at verify-cart-4 (the honest messenger). b2c-login-test GREENs on a
      // real B2C TOKEN-ACQUISITION event (isTokenEvent), NOT the DOM alone. Reuse that proven signal:
      // arm the token wait BEFORE submit (avoids the redirect race), then require BOTH the token event
      // AND the affordance — exactly b2c's COMPLETED branch. Now a failed login REDs HERE, at login.
      const tokenEvent = page
        .waitForResponse((r) => isTokenEvent(r.status(), r.url()), { timeout: 45_000 })
        .catch(() => null);
      await submit.click({ timeout: 5000 });
      const tok = await tokenEvent;
      if (!tok) {
        throw new Error(
          'login: no B2C token-acquisition event within 45s of submit — auth did NOT complete ' +
            '(aborted/blocked/creds-rejected). Login REDs here instead of silently shopping unauthenticated.',
        );
      }
      // AND the post-login DOM anchor (b2c requires BOTH — token event + affordance — for COMPLETED).
      await expect(
        loggedInAffordance(page).first(),
        'login: token acquired but no logged-in account affordance rendered (partial/aborted login)',
      ).toBeVisible({ timeout: STEP_TIMEOUT });
      if (!bypassAppliedToB2C && bypassToken) {
        // The B2C redirect never rode our route → the login likely used a cached session; not fatal.
        console.log('[full-shop-flow] note: bypass header route did not fire on B2C (cached session?).');
      }
    });

    // ---- STEP: select the McKinley store for PICKUP — GATES add-to-cart ----------------------------
    // Diagnosis (live add-milk STEP-FAIL: cart0 ful1 + a Pickup/Delivery control): wegmans.com/shop gates
    // the Add-to-Cart affordance behind a SELECTED fulfillment mode + store. Establish Pickup @ McKinley
    // once, before the add loop; the fulfillment context persists for the session.
    // ★ OBSERVED (driven live via Playwright MCP on the PUBLIC/anonymous www.wegmans.com/shop surface —
    // this REPLACES the ported meals2go store-search selectors from #67, which did not transfer: that was
    // the meals2go.com Angular app; www.wegmans.com/shop is a DIFFERENT, FULFILLMENT-FIRST flow):
    //   1. /shop/search is reachable ANONYMOUSLY (Sign In present throughout) → the picker is PRE-LOGIN;
    //      `li0` in the diag at this step is EXPECTED, not a lost session. Store context is per-browser-
    //      context and carries into the already-logged-in session, so add-to-cart later sees both.
    //   2. The header fulfillment control (button.selector-button, aria-haspopup="dialog") opens the
    //      dialog "How would you like to shop?" — buttons aria-label Pickup / Delivery / In Store.
    //   3. Pickup → dialog "Select Your Location": a "Enter City or Zip" textbox + a <ul> of store <li>s,
    //      each row = a "Select" button + a "<Name> Store Details" link (href /stores/<slug>).
    //   4. Typing McKinley's ZIP 14219 + Enter re-sorts the list so McKinley surfaces at the top —
    //      REGARDLESS of the egress IP's default geolocation (the datacenter runner will geolocate to a
    //      different default store than this authoring IP; the zip makes McKinley deterministic).
    //   5. McKinley's row is anchored on its STABLE store slug (a[href="/stores/mckinley-ny"]), then its
    //      "Select" button — a name/slug anchor, not position. Confirmation: the header fulfillment
    //      context updates to "Pickup at McKinley".
    // Name/slug-anchored + zero hard waits + armed on the real confirmation affordance. A failure still
    // emits the structural OTHER-DIAG (via runStep) so an A/B picker variant self-reveals (runbook #63).
    abortIfOverCap();
    await runStep(page, 'select-store-mckinley', async () => {
      await page.goto('https://www.wegmans.com/shop/search?query=milk', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      // Idempotent short-circuit: if the header already reads Pickup @ McKinley (e.g. a reused context),
      // the fulfillment gate is satisfied — nothing to do (its current-store row carries no Select button).
      const pickupAtMckinley = page.locator('.context-wrapper').filter({ hasText: /mckinley/i }).filter({ hasText: /pickup/i });
      if (await isVisibleSafe(pickupAtMckinley)) return;

      // (2) Open the "How would you like to shop?" fulfillment dialog if a Pickup choice isn't already
      //     showing. On a fresh context it may auto-open; otherwise the header selector button opens it.
      const pickupChoice = page
        .getByRole('dialog')
        .getByRole('button', { name: /^pickup$/i })
        .or(page.locator('[role="dialog"] button[aria-label="Pickup" i]'))
        .filter({ visible: true })
        .first();
      if (!(await isVisibleSafe(pickupChoice))) {
        const openPicker = page
          .locator('button.selector-button[aria-haspopup="dialog"]')
          .or(page.getByRole('button', { name: /^(in store|pickup|delivery)$|change store|set (your )?store|find a store/i }))
          .filter({ visible: true })
          .first();
        if (await isVisibleSafe(openPicker)) await openPicker.click({ timeout: 5000 }).catch(() => {});
        await dismissInterstitials(page);
      }
      // (3) Choose PICKUP → opens the "Select Your Location" store dialog.
      await expect(
        pickupChoice,
        'select-store-mckinley: Pickup option not found in the fulfillment dialog (picker DOM may have changed — verify from the diag).',
      ).toBeVisible({ timeout: STEP_TIMEOUT });
      await pickupChoice.click({ timeout: 5000 });
      await dismissInterstitials(page);

      // (4) Type McKinley's ZIP so the store surfaces regardless of the egress IP's default geolocation.
      const zip = page
        .getByRole('dialog')
        .locator('input[placeholder="Enter City or Zip" i]')
        .or(page.getByRole('textbox', { name: /city or zip|zip|city/i }))
        .filter({ visible: true })
        .first();
      if (await isVisibleSafe(zip)) {
        await zip.click({ timeout: 4000 }).catch(() => {});
        await zip.fill('14219').catch(() => {});
        await zip.press('Enter').catch(() => {});
      }
      // (5) Select the McKinley row — anchored on its STABLE store slug (/stores/mckinley-ny), name-based
      //     fallback. This armed anchor also proves the zip filter surfaced McKinley.
      const mckinleySelect = page
        .locator('[role="dialog"] li:has(a[href="/stores/mckinley-ny"]) button')
        .or(page.locator('[role="dialog"] li').filter({ hasText: /mckinley/i }).getByRole('button', { name: /^select$/i }))
        .filter({ visible: true })
        .first();
      await expect(
        mckinleySelect,
        'select-store-mckinley: McKinley "Select" row not found in the location dialog — verify from the diag (zip 14219 should surface it).',
      ).toBeVisible({ timeout: STEP_TIMEOUT });
      await mckinleySelect.click({ timeout: 5000 });
      await dismissInterstitials(page);

      // (6) Confirm the header fulfillment context now reads McKinley (the "Pickup at McKinley" affordance).
      const storeSet = page
        .locator('.context-wrapper')
        .filter({ hasText: /mckinley/i })
        .or(page.getByRole('button', { name: /mckinley/i }))
        .first();
      await expect(
        storeSet,
        'select-store-mckinley: no McKinley fulfillment-context confirmation after selecting — verify from the diag.',
      ).toBeVisible({ timeout: STEP_TIMEOUT });
    });

    // ---- STEP(s): search + add each item (REUSED search selectors; NET-NEW add-to-cart) ------------
    for (const item of SHOPPING_ITEMS) {
      abortIfOverCap();
      await runStep(page, `add-${item}`, async () => {
        // REUSED: direct-URL search + first product card (search-product.spec.ts).
        await page.goto(`https://www.wegmans.com/shop/search?query=${encodeURIComponent(item)}`, { waitUntil: 'domcontentloaded' });
        await dismissInterstitials(page);
        const firstProduct = page.locator('a[href*="/shop/product/"]').filter({ visible: true }).first();
        await expect(firstProduct, `add-${item}: no product result (a[href*="/shop/product/"]) for "${item}"`).toBeVisible({ timeout: STEP_TIMEOUT });
        await firstProduct.click({ timeout: 5000 }).catch(() => {});
        await dismissInterstitials(page);

        // ★ NET-NEW / UNVERIFIED: the authenticated Add-to-Cart affordance (a pickup fulfillment must be
        // set; a store/fulfillment modal may intercept). Resilient: prefer a real "Add to Cart" button;
        // if a fulfillment modal blocks it, choose PICKUP and retry. First-fire diag corrects this.
        // ★ DIAG (unchanged resolution): split so the match COUNT (CASE 1: wrong instance) can be read;
        //   `addToCart` is byte-for-byte the same locator/click as before — the diag only OBSERVES it.
        const addToCartMatches = page
          .getByRole('button', { name: /add to cart/i })
          .or(page.locator('button[class*="add" i][class*="cart" i]'));
        const addToCart = addToCartMatches.filter({ visible: true }).first();
        if (!(await isVisibleSafe(addToCart))) {
          const pickup = page.getByRole('button', { name: /pickup/i }).filter({ visible: true }).first();
          if (await isVisibleSafe(pickup)) await pickup.click({ timeout: 5000 }).catch(() => {});
          await dismissInterstitials(page);
        }
        // Skip gracefully if the item is genuinely unavailable (determinism: don't hard-depend on stock).
        const unavailable = page.getByText(/unavailable|out of stock|not available|sold out/i).first();
        if (await isVisibleSafe(unavailable)) {
          throw new Error(`add-${item}: first result is unavailable — widen the search or pick the next in-stock result (determinism gap to close on first fire).`);
        }
        await expect(addToCart, `add-${item}: Add to Cart affordance not found (NET-NEW selector — verify from diag)`).toBeVisible({ timeout: STEP_TIMEOUT });

        // ═══ ADD-TO-CART — single click, arm on the in-place stepper transform, let the write settle ═══
        // GROUND TRUTH (Craig's screenshots): ONE click commits the add and TRANSFORMS the "Add to Cart"
        // button IN PLACE into a quantity stepper ([remove/trash] [qty] [+]; on search cards the "+" becomes
        // a filled "1"). That transform IS the confirmation — there is NO modal (the old dlg1 was a false
        // read of the stepper). Success signal = the stepper appears; we THEN let the cart-write persist
        // (network event / badge increment) before advancing so verify-cart doesn't race an unflushed write.
        // (a) button state + (b) match count, BEFORE the click:
        const matchCount = await addToCartMatches.count().catch(() => -1); // (b) >1 ⇒ possible wrong instance
        const visMatchCount = await addToCartMatches.filter({ visible: true }).count().catch(() => -1);
        const btn = await readAddButtonState(addToCart); // (a) disabled/aria-*/on-screen/box/class
        const cartBefore = await readCartCount(page); // (d) cart badge before
        // Arm the cart-write network watch BEFORE the click (a working add fires one; the failing trace
        // showed ZERO). Non-GET to a wegmans/wegapi cart|basket|item|order path, status < 500. The window
        // is generous (ADD_SETTLE) so the write is caught even when it lands a beat after the transform.
        const ADD_SETTLE = 8_000;
        const cartWritePromise = page
          .waitForResponse((r) => {
            const method = r.request().method();
            if (method === 'GET' || method === 'HEAD') return false;
            const u = r.url();
            let host = '';
            try {
              host = new URL(u).host.toLowerCase();
            } catch {
              return false;
            }
            const onWegmansApi = /(^|\.)wegmans\.com$/.test(host) || /wegapi|kitting/i.test(host);
            return onWegmansApi && /\/(cart|basket|cart-items|line-?items|order|add)/i.test(u) && r.status() < 500;
          }, { timeout: ADD_SETTLE })
          .then((r) => safeLoc(r.url()))
          .catch(() => null);

        // THE CLICK — a single click commits the add and begins the in-place transform.
        await addToCart.click({ timeout: 5000 });

        // ARM ON THE TRANSFORM (the success signal): the plain "Add to Cart" button becomes a quantity
        // stepper — a remove/trash control, a quantity indicator, or a +/− increment. No hard wait —
        // appearsWithin resolves as soon as the stepper is visible (or times out at ADD_SETTLE).
        const stepper = page
          .locator('[class*="stepper" i], [class*="quantity" i], [data-testid*="quantity" i]')
          .or(page.getByRole('button', { name: /^\s*[-+]\s*$|increase|decrease|increment|decrement|quantity|remove|delete/i }))
          .or(page.getByRole('spinbutton'));
        const added = page.getByText(/added to (your )?(cart|list)|item added|in your cart|added!/i);
        const [stepperSeen, addedSeen] = await Promise.all([
          appearsWithin(stepper, ADD_SETTLE),
          appearsWithin(added, 2200),
        ]);

        // LET THE WRITE PERSIST before advancing: await the cart-write network event (primary), then read
        // the cart badge. If the transform is up but no cart-write was observed (endpoint pattern may
        // differ), give the write a short bounded settle so it flushes before we navigate to /shop/cart.
        const cartWriteLoc = await cartWritePromise; // resolved host/path or null
        if (stepperSeen && !cartWriteLoc) {
          await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
        }
        const cartAfter = await readCartCount(page); // (d) cart badge after

        // The add committed if the button TRANSFORMED (ground-truth confirmation) OR a cart-write fired OR
        // an "added" confirmation showed OR the cart badge incremented. Absent ALL ⇒ the add did not take.
        const cartIncremented = cartBefore != null && cartAfter != null && cartAfter > cartBefore;
        const addConfirmed = stepperSeen || !!cartWriteLoc || addedSeen || cartIncremented;
        const btnStr = btn
          ? `dis${btn.dis ? 1 : 0}/aDis${btn.ariaDis ?? '-'}/aHid${btn.ariaHid ?? '-'}/on${btn.onScreen ? 1 : 0}/box${btn.box}/cls[${btn.cls}]`
          : 'unread';
        // Legible transform diagnostic — emitted UNCONDITIONALLY (rides Node stdout + trace_signals.console)
        // so a future failure shows exactly what did/didn't happen: did the stepper appear? cart-write? badge?
        const addDiag =
          `[full-shop-flow] ADD ${item} match=${matchCount}(vis${visMatchCount}) ` +
          `btn={${btnStr}} transform={stepper${stepperSeen ? 1 : 0}/added${addedSeen ? 1 : 0}/` +
          `cw${cartWriteLoc ? 1 : 0}} cart=${cartBefore ?? '?'}->${cartAfter ?? '?'} confirmed=${addConfirmed ? 1 : 0}` +
          (cartWriteLoc ? ` cwLoc=${cartWriteLoc.slice(0, 40)}` : '');
        console.log(addDiag); // Node stdout (deep-dive)
        await page.evaluate((m) => console.warn(m), addDiag.slice(0, 195)).catch(() => {}); // → trace_signals.console

        if (!addConfirmed) {
          // The add did NOT take: the button never transformed into a stepper, no cart-write fired, no
          // "added" confirmation, and the cart badge did not increment. Likely the single click landed
          // before the button was interactive, or the selector matched a decoy (inspect btn/match). runStep
          // wraps this into error_message + trace_signals.
          throw new Error(
            `${addDiag} :: add-${item} did NOT confirm — the Add to Cart button did not transform into a ` +
              `quantity stepper, no cart-write fired, no "added" confirmation, and the cart did not increment. ` +
              `Check btn={…} (dis1/aHid1/on0 ⇒ not interactive) and match>1 (⇒ decoy/wrong instance).`,
          );
        }
      });
    }

    // ---- STEP: verify all 4 in cart (NET-NEW) ------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'verify-cart-4', async () => {
      await page.goto('https://www.wegmans.com/shop/cart', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      // ★ NET-NEW / UNVERIFIED: cart line-item count. PREFER a cart network anchor once the first-fire
      // diag reveals the cart API (mirror meals2go-cheese-pizza-cart's cart-items API assertion). For now,
      // a resilient DOM count of distinct line items.
      const lineItems = page.locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]').filter({ visible: true });
      await expect(lineItems.first(), 'verify-cart-4: no cart line items rendered (NET-NEW selector — verify from diag)').toBeVisible({ timeout: STEP_TIMEOUT });
      const n = await countSafe(lineItems);
      expect(n, `verify-cart-4: expected ≥4 cart line items, saw ${n} (some adds may have failed — read per-step diags)`).toBeGreaterThanOrEqual(4);
    });

    // ---- STEP: checkout as PICKUP (NET-NEW) --------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'checkout-pickup', async () => {
      await page.getByRole('button', { name: /checkout|proceed to checkout/i }).or(page.getByRole('link', { name: /checkout/i })).filter({ visible: true }).first().click({ timeout: 5000 });
      await dismissInterstitials(page);
      const pickup = page.getByRole('button', { name: /pickup/i }).or(page.getByRole('radio', { name: /pickup/i })).or(page.getByText(/pick ?up/i)).filter({ visible: true }).first();
      await expect(pickup, 'checkout-pickup: PICKUP fulfillment option not found (NET-NEW — verify from diag)').toBeVisible({ timeout: STEP_TIMEOUT });
      await pickup.click({ timeout: 5000 }).catch(() => {});
      await dismissInterstitials(page);
    });

    // ---- STEP: timeslots render + selectable (NET-NEW) --------------------------------------------
    abortIfOverCap();
    await runStep(page, 'timeslots-render', async () => {
      const slots = page.locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]').or(page.getByRole('button', { name: /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i })).filter({ visible: true });
      await expect(slots.first(), 'timeslots-render: no pickup timeslots rendered (NET-NEW — verify from diag)').toBeVisible({ timeout: STEP_TIMEOUT });
      const n = await countSafe(slots);
      expect(n, `timeslots-render: expected ≥1 selectable timeslot, saw ${n}`).toBeGreaterThanOrEqual(1);
    });

    // ---- STEP: select a slot (NET-NEW; SAFE per Craig — no hold until order placement; NEVER place order) --
    abortIfOverCap();
    await runStep(page, 'select-slot', async () => {
      const slot = page.locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]').or(page.getByRole('button', { name: /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i })).filter({ visible: true }).first();
      await slot.click({ timeout: 5000 });
      // ★ HARD SAFETY GUARD: this monitor NEVER places the order. Selecting a slot holds no capacity
      // (Craig-confirmed) — but we assert we are NOT on/allowed to click a place-order control, and we
      // never do. (The teardown below clears the cart, releasing any transient checkout state.)
      const placeOrder = page.getByRole('button', { name: /place (your )?order|submit order|pay now|complete (your )?order/i }).filter({ visible: true }).first();
      if (await isVisibleSafe(placeOrder)) {
        console.log('[full-shop-flow] note: a place-order control is present — NOT clicking it (never place the order).');
      }
    });

    // ---- STEP: return to cart (NET-NEW) -----------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'return-cart', async () => {
      await page.goto('https://www.wegmans.com/shop/cart', { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      await expect(page.locator('[class*="cart" i], [data-testid*="cart" i]').first(), 'return-cart: cart did not render').toBeVisible({ timeout: STEP_TIMEOUT });
    });
  } finally {
    // ---- TEARDOWN (always runs — a dirty run poisons its own next run). Best-effort + guarded so it
    //      never throws; clear-cart THEN logout. No lock to release (option 3). --------------------------
    await clearCart(page).catch(() => {});
    await logout(page).catch(() => {});
  }
});

/** Teardown — clear every cart line item (NET-NEW / UNVERIFIED). Best-effort loop with a cap so it can
 *  never hang; tries per-item Remove, then a bulk "clear/empty cart" affordance. Verify from first-fire
 *  diag: a scheduled monitor MUST end with an empty cart. */
async function clearCart(page: Page): Promise<void> {
  await step('clear-cart (teardown)', async () => {
    await page.goto('https://www.wegmans.com/shop/cart', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await dismissInterstitials(page);
    for (let i = 0; i < 12; i++) {
      const remove = page.getByRole('button', { name: /^remove$|remove item|delete item/i }).filter({ visible: true }).first();
      if (!(await remove.isVisible({ timeout: 1500 }).catch(() => false))) break;
      await remove.click({ timeout: 4000 }).catch(() => {});
      await dismissInterstitials(page);
    }
    const bulkClear = page.getByRole('button', { name: /clear cart|empty cart|remove all/i }).filter({ visible: true }).first();
    if (await bulkClear.isVisible({ timeout: 1500 }).catch(() => false)) await bulkClear.click({ timeout: 4000 }).catch(() => {});
    // Assert empty so a red teardown is VISIBLE (a dirty cart must not pass silently).
    const remaining = page.locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]').filter({ visible: true });
    const left = await countSafe(remaining);
    if (left > 0) {
      const d = await captureStepDiag(page, 'clear-cart').catch(() => ({ full: '', compact: '' }));
      console.log(`[full-shop-flow] STEP-FAIL clear-cart DIAG ${d.full}`);
      if (d.compact) await page.evaluate((m) => console.warn(m), d.compact).catch(() => {});
      throw new Error(`${d.compact} :: clear-cart: ${left} item(s) remain — teardown incomplete (NET-NEW selector; fix from diag BEFORE scheduling).`);
    }
  });
}

/** Teardown — logout (REUSE loggedInAffordance to open the account menu, then Sign Out). Best-effort. */
async function logout(page: Page): Promise<void> {
  await step('logout (teardown)', async () => {
    const menu = loggedInAffordance(page).filter({ visible: true }).first();
    if (await menu.isVisible({ timeout: 2000 }).catch(() => false)) await menu.click({ timeout: 4000 }).catch(() => {});
    const signOut = page.getByRole('link', { name: /sign ?out|log ?out/i }).or(page.getByRole('button', { name: /sign ?out|log ?out/i })).or(page.getByRole('menuitem', { name: /sign ?out|log ?out/i })).filter({ visible: true }).first();
    if (await signOut.isVisible({ timeout: 3000 }).catch(() => false)) await signOut.click({ timeout: 4000 }).catch(() => {});
    // Confirm signed out: the sign-IN affordance returns (best-effort; a stuck session is flagged, not thrown).
    const signInBack = page.getByRole('link', { name: /sign ?in|log ?in/i }).or(page.getByRole('button', { name: /sign ?in|log ?in/i })).first();
    if (!(await signInBack.isVisible({ timeout: 4000 }).catch(() => false))) {
      console.log('[full-shop-flow] note: could not confirm logout (sign-in affordance not visible) — verify the logout selector from the first-fire diag.');
    }
  });
}
