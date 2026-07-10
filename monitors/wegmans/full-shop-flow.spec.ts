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
 *  the 15-min tick so a run can't bleed into the next tick (concurrency axis b).
 *  ★ TEMPORARY / DIAGNOSTIC (measurement pass): raised 200_000 → 600_000 so a legitimately-long authenticated
 *  flow runs to its natural end and the trace is NOT truncated while we map where time goes. TUNE BACK to a
 *  production budget once the real completion time is measured. NOTE: the BINDING truncation is RUNNER-SIDE —
 *  runner/index.ts MAX_FLOW_MS = 180_000 kills the browser run first; that must be raised too (companion
 *  runner change) or this spec cap has no effect. */
const RUN_CAP_MS = 600_000;
const STEP_TIMEOUT = 20_000;
// ★ POST-LOGIN READINESS BUDGET (trace 935622: token event fired + redirect completed + "Hello, <name>"
//   present 3x in the OTHER-DIAG snapshot ⇒ login MATERIALLY SUCCEEDED, yet the login STEP red because the
//   greeting had not rendered within STEP_TIMEOUT=20s). The consumer post-login redirect (B2C → id_token →
//   www.wegmans.com header re-hydrate) can take far longer than 20s headless from datacenter egress (Craig:
//   "the page needs ~a minute to fully load after login"). The token-acquisition event (45s wait above) is
//   the auth-completion proof; THIS is only how long we allow the signed-in HEADER to paint afterward. It
//   does NOT weaken the success check (#79): we still REQUIRE the real "Hello," greeting — we just stop
//   asserting before a slow-but-successful login has had time to render it. Bounded well under the runner's
//   MAX_FLOW_MS=180s whole-flow cap. */
const LOGIN_READY_MS = 60_000;
// ★ CART PAGE URL — the real cart route is /cart, NOT /shop/cart. Hands-on recon (live logged-in session,
//   2026-07-10): a hard GET to https://www.wegmans.com/shop/cart returns a 231-byte JSON SHELL
//   ({"lvl0Categories":[]…}) with ZERO buttons — the shop SPA does not mount a cart route there, so nothing
//   renders (no header, no meatball, no line items). https://www.wegmans.com/cart renders the full cart app
//   (297 buttons, the "cart actions" ⋮ menu, the line items, the "View N selected items in my Cart" badge).
//   This single wrong URL is the root cause the clear-cart ⋮ menu was "0-for-3": baseline-clear-cart (and
//   teardown) navigated to the dead /shop/cart shell, so getByRole('button', {name:/cart actions/i}) found
//   nothing, "Empty My Cart" rendered 0x, and the step STEP-FAILed (trace 935767). The header cart LINK's
//   own href is "/cart". Used by verify-cart-4, return-cart, and clearCart (baseline + teardown). */
const CART_URL = 'https://www.wegmans.com/cart';
// ★ SPEC-OWNED per-action / per-navigation ceilings. The runner applies check.timeout_ms as the page
//   DEFAULT (runner/index.ts page.setDefaultTimeout) — a PER-ACTION bound, NOT a whole-flow one. A mis-set
//   check.timeout_ms (the 30000000ms=500min incident) made every UNBOUNDED action inherit a 500-min
//   ceiling, so one stuck action (an actionability wait / boundingBox / goto) hung ~334s of the flow
//   budget instead of failing fast. We OVERRIDE that default here so the flow is bounded REGARDLESS of
//   check.timeout_ms: fast fail + runStep names the step. Explicit per-call timeouts (RUNG_CLICK_TIMEOUT,
//   STEP_TIMEOUT, the 45s login token wait) still win — these are only the floor for calls that pass none.
const ACTION_TIMEOUT = 20_000;
const NAV_TIMEOUT = 30_000;

// ── DIAGNOSTIC TELEMETRY (measurement pass) — per-step timing accumulator, reset per run at test start.
//    Module-scoped so the shared runStep() can push to it; the test reads it for the FLOW-SUMMARY line. ──
const stepTimings: Array<{ name: string; ms: number; failed: boolean }> = [];
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

// ── Add-to-cart — CLICK-STRATEGY LADDER with full telemetry (this PR) ─────────────────────────────────
// GROUND TRUTH (Craig confirms add-to-cart works MANUALLY on the real wegmans.com/shop buy-box button):
// this is a PLAYWRIGHT SCRIPTING problem — the flow clicks the CORRECT button (the MAIN buy-box
// `component--add-to-cart-or-order-button-view` control, DISTINCT from a recommended item's
// `component--add-to-cart-mini-form` "add to list" mini button) but the React onClick does not fire, so
// nothing commits (stepper0/cw0 across every prior fire; wrong-button, wrong-page, coordinate-fidelity,
// overlay-interception, JS errors, login/store all RULED OUT). Success signal (Craig's screenshots): the
// "Add to Cart" button TRANSFORMS IN PLACE into a quantity stepper ([remove/trash] [qty] [+]); a
// first-party cart-WRITE (POST/PUT to a cart/basket/item/order path) is the transform-independent commit.
// Highest-probability cause: React HYDRATION TIMING — the click lands after the button paints but before
// React wires onClick. Rather than guess ONE click method, addToCartLadder tries a LADDER of strategies
// (hydrate+locator → precise-center → raw-pointer → dispatch-events → force), STOPS at the first that
// commits (records which), and on TOTAL failure emits the full per-rung telemetry — reactHandler/hydration
// state, click result, transform, cart-write — so the fire is maximally diagnostic. All evidence is DOM
// structure / URL host+path / booleans — never creds, token, or page HTML.

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
    // ★ FALSE-NEGATIVE FIX: the real cart-link aria-label is "View 13 selected items in my Cart" — a word
    // ("selected") sits between the number and "items", so the old /(\d+)\s*(item|product)/ never matched and
    // returned null (cart=?). Allow an optional intervening word and plural item/product.
    const m = al.match(/(\d+)\s+(?:\w+\s+)?(?:items?|products?)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** Capture the add-to-cart button's own state BEFORE the click (CASE 1: decoy/disabled/off-screen).
 *  Bounding-box + attributes + class list are DOM structure, not PII. Guarded; null on any failure. */
async function readAddButtonState(
  loc: Loc,
): Promise<{ dis: boolean; ariaDis: string | null; ariaHid: string | null; onScreen: boolean; box: string; cls: string; aria: string } | null> {
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
        // The matched button's aria-label — DISPOSITIVE for the #925854 bug (the loose selector caught a
        // recommended item's "Add …Shrimp Skewers… to LIST" mini-button). Surfacing it proves the selector
        // now targets the CURRENT product + "to cart". Product name is public catalog text, not PII.
        aria: (el.getAttribute('aria-label') || '').slice(0, 70),
      };
    })
    .catch(() => null);
}

/** ★ REACT-HANDLER / HYDRATION PROBE. Walks the element + up to 6 ancestors for React's internal props
 *  bag (`__reactProps$…` on React 17+, `__reactEventHandlers$…` on 16) and reports whether it carries a
 *  click-family handler (onClick/onPointerDown/onMouseDown). Directly tests the TOP hypothesis: if no
 *  handler is attached, the button painted but React has not wired onClick yet (hydration timing) → a
 *  click cannot commit. Structure only — never reads prop VALUES / PII. Null-safe (returns handler:false). */
async function readReactHandler(loc: Loc): Promise<{ handler: boolean; where: string; on: string }> {
  return loc
    .first()
    .evaluate((el) => {
      let cur: Element | null = el as Element;
      let depth = 0;
      while (cur && depth < 6) {
        const key = Object.keys(cur).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
        if (key) {
          const props = (cur as unknown as Record<string, any>)[key];
          if (props) {
            const on = ['onClick', 'onClickCapture', 'onPointerDown', 'onMouseDown'].filter((h) => typeof props[h] === 'function');
            if (on.length) return { handler: true, where: `d${depth}`, on: on.join('+').slice(0, 40) };
          }
        }
        cur = cur.parentElement;
        depth++;
      }
      return { handler: false, where: 'none', on: '' };
    })
    .catch(() => ({ handler: false, where: 'err', on: '' }));
}

/** Armed hydration wait: poll (bounded, NOT a fixed sleep) until the button gains a React click handler,
 *  then return. Resolves early the instant the handler is detected; otherwise returns after ms. No-op if
 *  the element handle can't be taken. This is the "give hydration time, then re-check" step. */
async function waitForReactHandler(page: Page, loc: Loc, ms: number): Promise<void> {
  const handle = await loc.first().elementHandle().catch(() => null);
  if (!handle) return;
  await page
    .waitForFunction(
      (el: Element) => {
        let cur: Element | null = el;
        let depth = 0;
        while (cur && depth < 6) {
          const key = Object.keys(cur).find((k) => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
          if (key) {
            const props = (cur as unknown as Record<string, any>)[key];
            if (props && (typeof props.onClick === 'function' || typeof props.onPointerDown === 'function' || typeof props.onMouseDown === 'function')) return true;
          }
          cur = cur.parentElement;
          depth++;
        }
        return false;
      },
      handle,
      { timeout: ms, polling: 150 },
    )
    .catch(() => {});
  await handle.dispose().catch(() => {});
}

/** Which add-to-cart container the matched button belongs to — the DEFINITIVE recon (b) confirmation that
 *  the ladder acts on the MAIN buy-box button (`component--add-to-cart-or-order-button-view`) and NOT a
 *  recommended-item "add to list" mini control (`component--add-to-cart-mini-form`). Structural only. */
async function readAddContainer(loc: Loc): Promise<string> {
  return loc
    .first()
    .evaluate((el) => {
      if (el.closest('.component--add-to-cart-or-order-button-view')) return 'buy-box';
      if (el.closest('.component--add-to-cart-mini-form')) return 'mini-form';
      const near = el.closest('[class*="add-to-cart" i]') as HTMLElement | null;
      return 'other[' + (near?.getAttribute('class') || '').slice(0, 40) + ']';
    })
    .catch(() => 'unread');
}

/** True if a response is a wegmans/wegapi cart-WRITE (non-GET to a cart/basket/item/order/add path,
 *  status < 500) — the DEFINITIVE commit signal, independent of the UI transform. */
function isCartWrite(method: string, url: string, status: number): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  // ★ FALSE-NEGATIVE FIX: the REAL production cart-write is a PUT to
  // api.digitaldevelopment.wegmans.CLOUD/commerce/cart/carts/lineitems/quantity (200) — "digitaldevelopment"
  // is the Wegmans Digital team's PRODUCTION APIM host, NOT a dev env. The old gate matched only
  // *.wegmans.COM, so it REJECTED the real successful cart-write and logged cartWrite=n. Accept *.wegmans.cloud
  // too (still scoped to wegmans commerce hosts + the cart path — never analytics/3rd-party).
  const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
  return onWegmansApi && /\/(cart|basket|cart-items|line-?items|order|add)/i.test(url) && status < 500;
}

/** ★ FULFILLMENT-CONTEXT WRITE — a first-party set-store / commit-fulfillment network WRITE (non-GET to a
 *  wegmans.com store/fulfillment/pickup/context/session endpoint). This is the signal the session BOUND the
 *  pickup-at-McKinley choice server-side. Trace 927288 showed the session only GETs store data
 *  (/api/stores/store-number/84, an instore/108 default) and NEVER fires this write — so add-to-cart later
 *  finds no pickup-at-84 cart context and no-ops. Keyed on method + host + path, never the body. */
function isFulfillmentWrite(method: string, url: string, status: number): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  const onWegmansApi = /(^|\.)wegmans\.com$/.test(host) || /wegapi|kitting/i.test(host);
  return onWegmansApi && /\/(store|stores|fulfil|pickup|context|session|shopping-?mode|order|cart|basket)/i.test(url) && status < 500;
}

/** ★ FULFILLMENT-STATE probe (structural, redaction-safe): best-effort dump of the app's ACTIVE store +
 *  fulfillment MODE + whether a cart exists, read from client storage (localStorage / sessionStorage /
 *  cookies — Wegmans persists the active store/fulfillment there). We scan only keys matching store/
 *  fulfillment/cart and EXTRACT a store NUMBER (2-4 digits), a mode word (pickup/instore/delivery), and a
 *  cart-exists boolean — NEVER returning a raw value, token, or account data. Used to CONFIRM the session
 *  bound to pickup@McKinley(84) before shopping (the add-to-cart precondition). */
async function readFulfillmentState(page: Page): Promise<{ store: string; mode: string; cart: string; src: string }> {
  return page
    .evaluate(() => {
      const out = { store: 'none', mode: 'none', cart: 'none', src: 'none' };
      const modeOf = (s: string) =>
        /pickup/i.test(s) ? 'pickup' : /delivery/i.test(s) ? 'delivery' : /in-?store/i.test(s) ? 'instore' : '';
      const scan = (blob: string, src: string) => {
        if (out.mode === 'none') {
          const m = modeOf(blob);
          if (m) { out.mode = m; out.src = src; }
        }
        if (out.store === 'none') {
          const sm = /store[^0-9]{0,20}(\d{2,4})/i.exec(blob) || /(\d{2,4})[^0-9]{0,20}mckinley/i.exec(blob);
          if (sm) { out.store = sm[1]; out.src = src; }
          else if (/mckinley/i.test(blob)) { out.store = 'mckinley'; out.src = src; }
        }
        if (out.cart === 'none' && /(cart|basket)[^a-z]{0,12}(id|number|items?|guid)/i.test(blob)) out.cart = 'exists';
      };
      const scanStore = (store: Storage, src: string) => {
        try {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i) || '';
            if (/store|fulfil|pickup|cart|shop|context|mode/i.test(k)) scan(k + ':' + (store.getItem(k) || ''), src);
          }
        } catch {
          /* storage access can throw in some contexts */
        }
      };
      scanStore(localStorage, 'ls');
      scanStore(sessionStorage, 'ss');
      try {
        scan(document.cookie, 'cookie');
      } catch {
        /* cookie access can throw */
      }
      return out;
    })
    .catch(() => ({ store: 'none', mode: 'none', cart: 'none', src: 'none' }));
}

/** ★ ADD-TO-CART CLICK-STRATEGY LADDER (this PR). Craig confirms add-to-cart works MANUALLY on the buy-box
 *  button, so this is a Playwright scripting problem: the correct button is clicked but its React onClick
 *  doesn't fire. Instead of guessing one method, try a LADDER — first-commit-wins, full telemetry on
 *  failure — while capturing the reactHandler/hydration state and a definitive cart-write signal.
 *
 *  PRE-CLICK (once): button state/box/aria + which container + reactHandler + page readiness + cart badge.
 *  CART-WRITE LISTENER (attached BEFORE the first rung): records every cart-write and the rung it fired on.
 *  RUNGS (each: attempt → armed wait ≤ARM_MS for the stepper transform OR a cart-write → commit/record | next):
 *    1 hydrate+locator  – bounded readiness settle, re-check handler, normal actionability locator click.
 *    2 precise-center   – locator click at the BUTTON's geometric center (not a child svg/span).
 *    3 raw-pointer      – page.mouse pointerdown→up at the bbox center (a genuine trusted pointer).
 *    4 dispatch-events  – page.evaluate dispatch pointerdown/mousedown/mouseup/click + el.click().
 *    5 force            – locator click {force:true}, last resort (skips actionability).
 *  If reactHandler is not yet wired at a rung, an ARMED hydration wait precedes it (the hydration case may
 *  just need time). SUCCESS = the first rung whose stepper transform appears OR whose cart-write fires;
 *  the ladder stops there. Throws (with the full ladder map) ONLY if EVERY rung fails, so the fire is
 *  maximally diagnostic. All telemetry is DOM structure / URL host+path / booleans — never creds/token/PII. */
async function addToCartLadder(page: Page, item: string, addToCart: Loc, addToCartMatches: Loc): Promise<void> {
  const RUNG_CLICK_TIMEOUT = 2200;
  const ARM_MS = 1800;
  const HYDRATE_MS = 1500;

  // ── PRE-CLICK TELEMETRY (once, before the ladder) ──
  const matchCount = await addToCartMatches.count().catch(() => -1);
  const visMatchCount = await addToCartMatches.filter({ visible: true }).count().catch(() => -1);
  const btn = await readAddButtonState(addToCart); // disabled/aria-*/on-screen/box/class
  const container = await readAddContainer(addToCart); // recon (b): buy-box vs mini-form
  const rh0 = await readReactHandler(addToCart); // ★ hydration hypothesis, at start
  const readyState = await page.evaluate(() => document.readyState).catch(() => '?');
  const netIdle = await page.waitForLoadState('networkidle', { timeout: HYDRATE_MS }).then(() => true).catch(() => false);
  const cartBefore = await readCartCount(page);

  // ── CART-WRITE LISTENER (attach BEFORE the first click strategy) — the transform-independent commit ──
  const cartWrites: { rung: number; loc: string }[] = [];
  let currentRung = 0;
  const onResponse = (resp: any) => {
    try {
      if (isCartWrite(resp.request().method(), resp.url(), resp.status())) {
        cartWrites.push({ rung: currentRung, loc: safeLoc(resp.url()) });
      }
    } catch {
      /* never let telemetry break the flow */
    }
  };
  page.on('response', onResponse);

  // The in-place stepper transform is the UI success signal (same locator the prior single-click armed on).
  const stepper = page
    .locator('[class*="stepper" i], [class*="quantity" i], [data-testid*="quantity" i]')
    .or(page.getByRole('button', { name: /^\s*[-+]\s*$|increase|decrease|increment|decrement|quantity|remove|delete/i }))
    .or(page.getByRole('spinbutton'));

  type Rung = { name: string; run: () => Promise<void> };
  const rungs: Rung[] = [
    {
      name: 'hydrate+locator',
      run: async () => {
        await page.waitForLoadState('networkidle', { timeout: HYDRATE_MS }).catch(() => {});
        await addToCart.first().scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await addToCart.first().click({ timeout: RUNG_CLICK_TIMEOUT });
      },
    },
    {
      name: 'precise-center',
      run: async () => {
        const box = await addToCart.first().boundingBox();
        if (!box) throw new Error('precise-center: no bounding box');
        await addToCart.first().click({ position: { x: box.width / 2, y: box.height / 2 }, timeout: RUNG_CLICK_TIMEOUT });
      },
    },
    {
      name: 'raw-pointer',
      run: async () => {
        const box = await addToCart.first().boundingBox();
        if (!box) throw new Error('raw-pointer: no bounding box');
        await addToCart.first().scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      },
    },
    {
      name: 'dispatch-events',
      run: async () => {
        await addToCart.first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          const opts: any = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          (el as HTMLElement).click();
        });
      },
    },
    {
      name: 'force',
      run: async () => {
        await addToCart.first().click({ force: true, timeout: RUNG_CLICK_TIMEOUT });
      },
    },
  ];

  const rungLines: string[] = [];
  let committedRung = 0;
  let committedVia = '';
  for (let i = 0; i < rungs.length; i++) {
    currentRung = i + 1;
    // Re-check the handler at THIS rung; if still unwired, do an ARMED hydration wait (the top hypothesis
    // is the click lands before React wires onClick — give it bounded time, then re-check) and click.
    let rh = await readReactHandler(addToCart);
    if (!rh.handler) {
      await waitForReactHandler(page, addToCart, HYDRATE_MS);
      rh = await readReactHandler(addToCart);
    }
    const writesBefore = cartWrites.length;
    let clicked = 'ok';
    try {
      await rungs[i].run();
    } catch (e) {
      clicked = 'err:' + (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 110);
    }
    // Armed wait ≤ARM_MS for EITHER success signal (no hard sleep): the stepper transform (appearsWithin
    // resolves the instant it is visible) OR a cart-write recorded by the listener during this window.
    const stepperSeen = await appearsWithin(stepper, ARM_MS);
    const cartWriteSeen = cartWrites.length > writesBefore;
    const cartNow = await readCartCount(page);
    rungLines.push(
      `rung=${i + 1} strategy=${rungs[i].name} reactHandler=${rh.handler ? 'y' : 'n'}(${rh.where}${rh.on ? ':' + rh.on : ''}) ` +
        `clicked=${clicked} transform=${stepperSeen ? 'y' : 'n'} cartWrite=${cartWriteSeen ? 'y' : 'n'} cart=${cartBefore ?? '?'}->${cartNow ?? '?'}`,
    );
    if (stepperSeen || cartWriteSeen) {
      committedRung = i + 1;
      committedVia = rungs[i].name;
      break;
    }
  }

  page.off('response', onResponse);

  const cartAfter = await readCartCount(page);
  const btnStr = btn
    ? `dis${btn.dis ? 1 : 0}/aDis${btn.ariaDis ?? '-'}/aHid${btn.ariaHid ?? '-'}/on${btn.onScreen ? 1 : 0}/box${btn.box}/aria[${btn.aria}]`
    : 'unread';
  const summary =
    `ATC-RESULT ${item} committed=${committedRung ? 'rung' + committedRung : 'NONE'} via=${committedVia || '-'} ` +
    `cartWrites=${cartWrites.length} reactHandlerAtStart=${rh0.handler ? 'y' : 'n'} container=${container} ` +
    `match=${matchCount}(vis${visMatchCount}) ready=${readyState}/netIdle${netIdle ? 'y' : 'n'} cart=${cartBefore ?? '?'}->${cartAfter ?? '?'}`;

  // Emit EVERY rung line + the summary to BOTH Node stdout (deep-dive) and trace_signals.console.
  for (const line of rungLines) {
    const l = `[full-shop-flow] ATC-LADDER ${item} ${line}`;
    console.log(l);
    await page.evaluate((m) => console.warn(m), l.slice(0, 195)).catch(() => {});
  }
  console.log(`[full-shop-flow] ${summary}`);
  await page.evaluate((m) => console.warn(m), summary.slice(0, 195)).catch(() => {});

  if (!committedRung) {
    throw new Error(
      `[full-shop-flow] ${summary} :: btn={${btnStr}} :: RUNGS=[ ${rungLines.join(' | ')} ] :: ` +
        `add-${item} did NOT commit on ANY of ${rungs.length} click strategies — no stepper transform and no ` +
        `cart-write fired across the whole ladder. reactHandler=n throughout ⇒ HYDRATION (onClick never wired; ` +
        `needs a different readiness gate). reactHandler=y with zero cart-writes ⇒ NO standard click triggers the ` +
        `handler (rules out the click-method family — redirect the investigation).`,
    );
  }
}

/** Best-effort neutralize the bottom-right "How can we help?"/emplifi chat bubble (and similar floating
 *  widgets) that overlay the PDP and swallow the add-to-cart click. The vendored dismissInterstitials
 *  covers cookie/consent/close banners but NOT this chat widget. TWO-PART, both non-fatal:
 *   (1) click an explicit close/minimize affordance if the widget exposes one (CONSERVATIVE: never a
 *       control that could OPEN the chat);
 *   (2) then HIDE any residual fixed-position emplifi/chat launcher via a scoped style injection — the
 *       collapsed launcher ("How can we help?", bot.emplifi.io) often carries NO close control, so hiding
 *       it (display:none + pointer-events:none) is what actually removes the overlay from the hit-test
 *       so it can never intercept the click. Scoped to emplifi + explicit chat-launcher hooks so it can
 *       never touch the product buy-box. Never throws. */
async function dismissChatWidget(page: Page): Promise<void> {
  const closer = page
    .getByRole('button', { name: /close chat|minimize chat|close (the )?chat|hide chat|close help/i })
    .or(page.locator('button[aria-label*="close chat" i], [class*="emplifi" i] button[aria-label*="close" i]'))
    .filter({ visible: true })
    .first();
  if (await closer.isVisible({ timeout: 800 }).catch(() => false)) {
    await closer.click({ timeout: 1500 }).catch(() => {});
  }
  await page
    .evaluate(() => {
      const id = 'sw-hide-chat-overlays';
      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent =
        '[class*="emplifi" i],[id*="emplifi" i],iframe[src*="emplifi" i],' +
        '[class*="chat-launcher" i],[class*="chat-widget" i],[id*="chat-widget" i],' +
        '[aria-label*="how can we help" i]{display:none !important;pointer-events:none !important;}';
      document.head.appendChild(style);
    })
    .catch(() => {});
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
    const t0 = Date.now(); // ★ per-step timing (measurement pass)
    try {
      await body();
      const ms = Date.now() - t0;
      stepTimings.push({ name, ms, failed: false });
      console.log(`[full-shop-flow] STEP-TIMING ${name} ${ms}ms`);
    } catch (err) {
      const ms = Date.now() - t0;
      stepTimings.push({ name, ms, failed: true });
      console.log(`[full-shop-flow] STEP-TIMING ${name} ${ms}ms FAILED`);
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

  // ★ BOUNDED WAITS (hang fix) — override the per-action ceiling INHERITED from the runner's
  //   page.setDefaultTimeout(check.timeout_ms). This makes the flow fail FAST + NAMED regardless of how
  //   check.timeout_ms is set (the 500-min misconfig hung one unbounded action ~334s). Set here, before
  //   any action, so it governs the whole flow; explicit per-call timeouts still take precedence.
  page.setDefaultTimeout(ACTION_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  // ── DIAGNOSTIC TELEMETRY (measurement pass) ──────────────────────────────────────────────────────
  // Reset the per-run step-timing accumulator, and attach a BROAD cart/order/basket/item API listener so we
  // capture the REAL cart-write endpoint (earlier filters may have MISSED it — capture broadly). Emits one
  // CART-API line per matching call + counts non-GET writes. Structural only (method/status/host+path).
  stepTimings.length = 0;
  const cartApiCalls: Array<{ method: string; status: number; path: string }> = [];
  let cartWriteCount = 0;
  page.on('response', (resp) => {
    try {
      const method = resp.request().method();
      const url = resp.url();
      let host = '';
      try {
        host = new URL(url).host.toLowerCase();
      } catch {
        return;
      }
      const onWegmans = /(^|\.)wegmans\.com$/.test(host) || /wegapi|kitting/i.test(host);
      if (!onWegmans || !/\/(cart|basket|order|line-?items?|cart-items|checkout|add)/i.test(url)) return;
      const status = resp.status();
      cartApiCalls.push({ method, status, path: safeLoc(url) });
      if (method !== 'GET' && method !== 'HEAD' && status < 500) cartWriteCount++;
      console.log(`[full-shop-flow] CART-API ${method} ${status} ${safeLoc(url)}`);
    } catch {
      /* telemetry never breaks the flow */
    }
  });

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
      // ★ ROOT-CAUSE FIX (Bug B, trace 928339): the OLD confirmation armed on loggedInAffordance, whose RX
      // (/account|profile|orders|my wegmans|rewards|…/) matches ALWAYS-PRESENT header/footer nav chrome that
      // is visible even LOGGED OUT — so it false-GREENed (li1) on a page STILL showing "Sign in", and the
      // flow shopped UNAUTHENTICATED (the root of the whole add-to-cart saga: no session → add no-ops).
      // Craig's telltale of REAL success: the header greeting changes "Sign in" → "Hello, <name>". Arm on
      // THAT — the greeting /hello,/i appearing — so login FAILS LOUDLY here (li0) when it doesn't complete,
      // instead of silently passing. (Kept the token-event requirement above; this replaces the loose DOM
      // anchor with the definitive one.)
      const helloGreeting = page
        .getByRole('link', { name: /hello,/i })
        .or(page.getByRole('button', { name: /hello,/i }))
        .or(page.getByText(/hello,/i))
        .filter({ visible: true })
        .first();
      // Wait up to LOGIN_READY_MS (not STEP_TIMEOUT) for the greeting to PAINT: the token event above already
      // proved auth completed; a slow post-login redirect/hydrate must not red a login that succeeded (935622).
      const helloSeen = await appearsWithin(helloGreeting, LOGIN_READY_MS);
      // LOGIN-STATE telemetry: WHY a login outcome happened. signin=present + hello=absent ⇒ login did NOT
      // complete (page stuck at Sign in). Structural booleans only — never the account name/value.
      const signInStill = await isVisibleSafe(
        page.getByRole('link', { name: /^\s*(sign ?in|log ?in)\s*$/i }).or(page.getByRole('button', { name: /^\s*(sign ?in|log ?in)\s*$/i })),
      );
      console.log(`[full-shop-flow] LOGIN-STATE signin=${signInStill ? 'present' : 'absent'} hello=${helloSeen ? 'present' : 'absent'}`);
      expect(
        helloSeen,
        `login: the logged-in header greeting ("Hello, <name>") did NOT appear within ${Math.round(LOGIN_READY_MS / 1000)}s ` +
          `(LOGIN-STATE signin=${signInStill ? 'present' : 'absent'} hello=absent) — login did NOT complete. Reds HERE at ` +
          `the login step (li0), not silently shopping unauthenticated. (Bug A: the B2C submit likely did not finish — ` +
          `the consumer B2C flow is multi-step email→Next→password→Sign in; debug the submit from here.)`,
      ).toBeTruthy();
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

      // ★ ARM on the set-store / commit-fulfillment WRITE (before any picker action fires it). Trace 927288
      // showed the current flow (open → Pickup → zip → Select) only GETs store data and NEVER writes the
      // fulfillment context — so the session stays at its default (instore/108), add-to-cart finds no
      // pickup-at-84 cart context, and silently no-ops. We add the missing COMMIT below and confirm THIS
      // write fires (or the app state reflects pickup@84) before shopping. Armed early so it catches the
      // write whether the Select click or the commit action fires it.
      const setStoreWrite = page
        .waitForResponse((r) => isFulfillmentWrite(r.request().method(), r.url(), r.status()), { timeout: STEP_TIMEOUT })
        .then(() => true)
        .catch(() => false);

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

      // (6) ★ COMMIT the fulfillment choice SERVER-SIDE. Clicking "Select" updates the picker UI/header but
      //     (per trace 927288) does NOT bind the session — a real user commits via a "Start Shopping / Shop
      //     this store / Continue" action, which fires the set-store write. Do that (guarded; the button may
      //     not exist if Select itself commits — then the arm still catches its write).
      const commit = page
        .locator('[role="dialog"]')
        .getByRole('button', { name: /start shopping|shop this store|shop now|continue shopping|continue|confirm|shop store|done|save/i })
        .or(page.locator('[role="dialog"] button[type="submit"]'))
        .filter({ visible: true })
        .first();
      if (await isVisibleSafe(commit)) await commit.click({ timeout: 5000 }).catch(() => {});
      await dismissInterstitials(page);

      // (7) Confirm the header fulfillment context now reads McKinley (UI check — necessary, not sufficient).
      const storeSet = page
        .locator('.context-wrapper')
        .filter({ hasText: /mckinley/i })
        .or(page.getByRole('button', { name: /mckinley/i }))
        .first();
      await expect(
        storeSet,
        'select-store-mckinley: no McKinley fulfillment-context confirmation after selecting — verify from the diag.',
      ).toBeVisible({ timeout: STEP_TIMEOUT });

      // (8) ★ SERVER-BOUND GATE — the actual add-to-cart precondition. The UI header (7) is not enough; the
      //     SESSION must be bound to pickup@McKinley(84). Confirm via EITHER the set-store WRITE having fired
      //     (armed above) OR the app state reflecting pickup mode at store 84/McKinley. Emit FULFILLMENT-STATE
      //     either way so the fire is self-diagnosing (structural: store number + mode + cart + source only).
      const setStoreSeen = await setStoreWrite;
      const fs = await readFulfillmentState(page);
      console.log(
        `[full-shop-flow] FULFILLMENT-STATE store=${fs.store} mode=${fs.mode} cart=${fs.cart} src=${fs.src} setStoreWrite=${setStoreSeen ? 'y' : 'n'}`,
      );
      const boundByState = fs.mode === 'pickup' && (fs.store === '84' || /mckinley/i.test(fs.store));
      expect(
        setStoreSeen || boundByState,
        `select-store-mckinley: fulfillment context NOT bound server-side — UI shows McKinley but no set-store ` +
          `write fired and app state is not pickup@84 (store=${fs.store} mode=${fs.mode} setStoreWrite=${setStoreSeen ? 'y' : 'n'}). ` +
          `add-to-cart would no-op for lack of a cart context; fix the commit action from the FULFILLMENT-STATE diag.`,
      ).toBeTruthy();
    });

    // ★ STORE-STATE @before-add (measurement): which store/mode is the session ACTUALLY bound to right
    //    before the first add — surfaces the 108/48/84 mess. (The store step already logged FULFILLMENT-STATE
    //    @after-store-selection.) Structural: store number + mode + bound boolean only.
    {
      const sb = await readFulfillmentState(page).catch(() => ({ store: '?', mode: '?', cart: '?', src: '?' }));
      const bound = sb.mode === 'pickup' && (sb.store === '84' || /mckinley/i.test(sb.store)) ? 'y' : 'n';
      console.log(`[full-shop-flow] STORE-STATE @before-add store=${sb.store} mode=${sb.mode} bound=${bound}`);
    }

    // ---- STEP: BASELINE CLEAR — start from a known-EMPTY cart (determinism) ------------------------
    // The cart is server-side + per-account, so it PERSISTS across runs. A previous run whose end-of-flow
    // teardown was bypassed (e.g. a mid-flow hang killed the run before `finally`) leaves residue that
    // otherwise ACCUMULATES (the 17-item pile-up) and skews verify-cart-4. Clear to empty FIRST and verify
    // the badge → 0 (clearCart throws STEP-FAIL 'baseline-clear-cart' with the residual count if it can't),
    // so every run starts deterministic regardless of prior state — and the accumulation cannot recur even
    // if this run's own teardown is later skipped. Runs AFTER store-binding (the cart is fulfillment-scoped).
    abortIfOverCap();
    await clearCart(page, 'baseline-clear-cart');

    // ---- STEP(s): search + add each item (REUSED search selectors; NET-NEW add-to-cart) ------------
    for (const item of SHOPPING_ITEMS) {
      abortIfOverCap();
      await runStep(page, `add-${item}`, async () => {
        // ★ SEARCH-NAV (REVERTED from direct-URL pin). Trace 933812 (search-nav) committed 3 products
        // (milk+eggs+bread, cart 0→2→3) maintaining the established store/Pickup context across adds; the
        // pinned direct-URL nav (trace 934518) REGRESSED to 1 product — per-product /shop/product/ nav
        // disrupted the store/session context between adds (a changestore PUT + repeated service_options
        // POSTs), and eggs failed without the add-ladder even firing. So SEARCH + select-from-results
        // (in-context) for ALL 4 items — NOT direct product-URL nav. The add still commits on the PDP
        // (its LARGE buy-box "Add to Cart" transforms to a stepper; the /shop/search "+" is a no-op).
        await page.goto(`https://www.wegmans.com/shop/search?query=${encodeURIComponent(item)}`, { waitUntil: 'domcontentloaded' });
        await dismissInterstitials(page);

        // ★ RESULT SELECTION. Most items: the first visible product card is correct. BANANAS is the one
        // exception — trace 933812: a BOOSTED/promoted 92928-Sweet-Cherries hijacked the first-result
        // position for the "bananas" query, so a raw .first() added CHERRIES. selectBananaResult() picks
        // the result that is an ACTUAL banana (product 92685 "Bananas, Sold by the Each", by id/name) and
        // REJECTS boosted / banana-FLAVORED look-alikes (Sweet Cherries, Banana Pudding, Banana Pepper, …).
        // Still a SEARCH-result click (in-context), never direct product-URL nav.
        const firstProduct =
          item === 'bananas'
            ? await selectBananaResult(page)
            : page.locator('a[href*="/shop/product/"]').filter({ visible: true }).first();
        await expect(firstProduct, `add-${item}: no product result (a[href*="/shop/product/"]) for "${item}"`).toBeVisible({ timeout: STEP_TIMEOUT });

        // The add MUST commit on the PDP, not the search "+". Capture the href, click the tile, and if we
        // did NOT land on /shop/product/, navigate to the captured href (same-context — store/fulfillment
        // persists). Then HARD-ASSERT the PDP URL before hunting for "Add to Cart".
        const productHref = (await firstProduct.getAttribute('href').catch(() => null)) ?? '';
        await firstProduct.click({ timeout: 5000 }).catch(() => {});
        const onPdp = await page.waitForURL(/\/shop\/product\//, { timeout: 8000 }).then(() => true).catch(() => false);
        if (!onPdp && productHref) {
          await page.goto(new URL(productHref, 'https://www.wegmans.com').toString(), { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        await dismissInterstitials(page);
        await expect(
          page,
          `add-${item}: did not reach a product detail page (/shop/product/…) — the search tile click did not ` +
            `navigate and the direct product-URL fallback failed; the add must run on the PDP, never the search "+".`,
        ).toHaveURL(/\/shop\/product\//, { timeout: STEP_TIMEOUT });

        // ★ BANANAS VERIFY: confirm the landed PDP is the ACTUAL banana (id 92685 or a name that STARTS
        // with "Bananas") BEFORE the add commits — rejects a cherries/flavored hijack that slipped through.
        if (item === 'bananas') {
          const slug = page.url().split('/shop/product/')[1] ?? '';
          const landedIsBanana = /^92685-/.test(slug) || /^\d+-Bananas\b/i.test(slug);
          expect(
            landedIsBanana,
            `add-bananas: landed PDP "${slug}" is not an actual banana (expected 92685 / a "Bananas…" ` +
              `product) — a boosted/flavored result hijacked the search; re-recon banana selection.`,
          ).toBeTruthy();
        }

        // ★ ROOT-CAUSE FIX (trace 925854 DOM — DISPOSITIVE): the OLD selector — getByRole(name:/add to
        // cart/i).or(button[class*=add][class*=cart]) with .first() — matched the WRONG control. On the
        // milk PDP it caught a RECOMMENDED item's compact mini-button:
        //   <div class="component--add-to-cart-mini-form add-to-cart">
        //     <button class="default-add-button …" aria-label="Add 1 ea of Wegmans Gold Pan Garlic Herb
        //                                                       Shrimp Skewers … to list"> …
        // — a DIFFERENT product AND a DIFFERENT action ("to LIST", a wishlist add, not the cart), sitting
        // in DOM BEFORE the main buy-box button, so .first() grabbed it → real click, but zero cart-write,
        // cart0 forever. Every prior fix (PDP nav, real-pointer click) was interacting with this wrong
        // button. Target the MAIN buy-box "Add to Cart" precisely, via two DOM-verified discriminators:
        //   (1) ACTION = "to cart": the main button's accessible name carries "…to cart" — its real
        //       dynamic aria-label is "Add <qty> ea of <CURRENT PRODUCT> to Cart" (or the literal "Add to
        //       Cart" text). Requiring "to cart" REJECTS every "…to list" control by construction.
        //   (2) NOT the recommended-item mini control: exclude `.component--add-to-cart-mini-form button`
        //       (the compact wishlist add), so a recommendation with its own quick-add can't be picked.
        // Note the old generic `button[class*=add][class*=cart]` branch is REMOVED — `.component--add-to
        // -cart-mini-form` carries `add-to-cart` in its class and was exactly what let the mini-button in.
        const notRecommendedMiniForm = page.locator('button:not(.component--add-to-cart-mini-form button)');
        const addToCartMatches = page
          .getByRole('button', { name: /add\b.*\bto cart\b/i })
          .or(page.locator('button[aria-label*="to cart" i]'))
          .and(notRecommendedMiniForm);
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

        // ── CLICK-FIDELITY PREP ── dismiss any floating "How can we help?"/emplifi chat widget that can
        // overlay the button + swallow the click (the vendored dismissInterstitials does not cover it),
        // then let the PDP settle (bounded, signal-based) so React has a chance to wire the add handler.
        await dismissChatWidget(page);
        await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});

        // ═══ ADD-TO-CART — CLICK-STRATEGY LADDER (first-commit-wins; full telemetry on total failure) ═══
        // Craig confirms the add works MANUALLY on this buy-box button → a scripting problem (correct
        // button clicked, React onClick doesn't fire; top hypothesis = hydration timing). addToCartLadder
        // runs hydrate+locator → precise-center → raw-pointer → dispatch-events → force, stopping at the
        // first rung whose stepper transform appears OR whose cart-write fires, capturing the
        // reactHandler/hydration state + a transform-independent cart-write signal for EACH rung. On
        // success it records which strategy committed; on total failure it throws with the full ladder map
        // (every rung's reactHandler / click / transform / cartWrite) — a maximally diagnostic fire either
        // way. runStep wraps a throw into error_message + trace_signals.
        const cwBefore = cartWriteCount; // ★ CART-STATE: per-item cart-write delta (measurement)
        await addToCartLadder(page, item, addToCart, addToCartMatches);
        // ★ CART-STATE after this add: does the UI transform correspond to a REAL cart entry (count badge +
        //    a cart-write network call), or is the UI optimistic while the cart stays empty? Structural only.
        const countBadge = await readCartCount(page).catch(() => null);
        const transformSeen = await isVisibleSafe(
          page
            .locator('[class*="stepper" i], [class*="quantity" i], [data-testid*="quantity" i]')
            .or(page.getByRole('button', { name: /^\s*[-+]\s*$|remove|delete|increment|decrement/i })),
        );
        console.log(
          `[full-shop-flow] CART-STATE after=${item} countBadge=${countBadge ?? '?'} cartWrite=${cartWriteCount > cwBefore ? 'y' : 'n'} transform=${transformSeen ? 'y' : 'n'}`,
        );
      });
    }

    // ---- STEP: verify all 4 in cart (NET-NEW) ------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'verify-cart-4', async () => {
      await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      // ★ NET-NEW / UNVERIFIED: cart line-item count. PREFER a cart network anchor once the first-fire
      // diag reveals the cart API (mirror meals2go-cheese-pizza-cart's cart-items API assertion). For now,
      // a resilient DOM count of distinct line items.
      const lineItems = page.locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]').filter({ visible: true });
      await expect(lineItems.first(), 'verify-cart-4: no cart line items rendered (NET-NEW selector — verify from diag)').toBeVisible({ timeout: STEP_TIMEOUT });
      const n = await countSafe(lineItems);
      expect(n, `verify-cart-4: expected ≥4 cart line items, saw ${n} (some adds may have failed — read per-step diags)`).toBeGreaterThanOrEqual(4);
      // ★ INVARIANT (Craig): the cart MUST be ≤ 4 here. >4 means baseline-clear-cart did NOT empty the
      // previous session's leftover items (they accumulated) — the exact failure this PR fixes. Prefer the
      // header BADGE (server truth) over the DOM line-item count (which can over-count sticky/duplicate rows);
      // fall back to n only when the badge is absent. Fail LOUD rather than pass a cart polluted with residue.
      const cartBadge = await readCartCount(page);
      const cartCount = cartBadge ?? n;
      expect(
        cartCount,
        `verify-cart-4: cart has ${cartCount} item(s) (>4) — baseline clear-cart did not empty leftover items; clearing failed`,
      ).toBeLessThanOrEqual(4);
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
      await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });
      await dismissInterstitials(page);
      await expect(page.locator('[class*="cart" i], [data-testid*="cart" i]').first(), 'return-cart: cart did not render').toBeVisible({ timeout: STEP_TIMEOUT });
    });
  } finally {
    // ---- TEARDOWN (always runs — a dirty run poisons its own next run). Best-effort + guarded so it
    //      never throws; clear-cart THEN logout. No lock to release (option 3). --------------------------
    await clearCart(page).catch(() => {});
    await logout(page).catch(() => {});

    // ★ FLOW-SUMMARY (measurement) — the whole run in one line for the trace: total duration, per-step
    //    durations, final cart count, cart-writes + cart-API calls seen, final store/mode, and which step
    //    failed (if any). This is the map that picks the next fix. Structural only; best-effort (never throws).
    try {
      const totalMs = Date.now() - startedAt;
      const finalCart = await readCartCount(page).catch(() => null);
      const fsEnd = await readFulfillmentState(page).catch(() => ({ store: '?', mode: '?', cart: '?', src: '?' }));
      const failed = stepTimings.filter((s) => s.failed).map((s) => s.name).join(',') || 'none';
      const steps = stepTimings.map((s) => `${s.name}=${s.ms}${s.failed ? '!' : ''}`).join(' ');
      console.log(
        `[full-shop-flow] FLOW-SUMMARY totalMs=${totalMs} finalCart=${finalCart ?? '?'} cartWrites=${cartWriteCount} ` +
          `cartApis=${cartApiCalls.length} store=${fsEnd.store} mode=${fsEnd.mode} failedStep=${failed} steps=[${steps}]`,
      );
    } catch {
      /* summary is best-effort telemetry — never mask the real outcome */
    }
  }
});

/** ★ BANANAS result-selection guard. The "bananas" query returns BOOSTED/merchandised results — trace
 *  933812 saw 92928-Sweet-Cherries hijack the FIRST position, so a raw .first() added cherries. Return the
 *  search-result anchor that is an ACTUAL banana: prefer the exact product 92685 ("Bananas, Sold by the
 *  Each"), else the first result whose product NAME (slug after the id, or link text) STARTS with "Bananas"
 *  (the produce item) — while REJECTING flavored/merchandised look-alikes (Sweet Cherries, Banana Pudding,
 *  Banana Pepper, banana bread/chips/muffins, …). Throws LOUD if no banana is present — a silent .first()
 *  would add the wrong item (the original bug). Still returns a RESULT anchor to click (in-context nav). */
async function selectBananaResult(page: Page): Promise<Loc> {
  const anchors = page.locator('a[href*="/shop/product/"]').filter({ visible: true });
  // Primary: the exact banana product id 92685 — deterministic, immune to boost/reorder.
  const byId = page.locator('a[href*="/shop/product/92685-"]').filter({ visible: true }).first();
  if (await byId.isVisible({ timeout: STEP_TIMEOUT }).catch(() => false)) return byId;
  // Fallback: first result whose product NAME begins with "Bananas" (produce), excluding look-alikes.
  const REJECT = /cherr|pudding|pepper|chip|bread|muffin|candle|flavor|split|foster|nut|puff|milk|smoothie/i;
  const n = await anchors.count();
  for (let i = 0; i < n; i++) {
    const a = anchors.nth(i);
    const href = (await a.getAttribute('href').catch(() => '')) ?? '';
    const name = ((await a.textContent().catch(() => '')) ?? '').trim();
    const slug = href.split('/shop/product/')[1] ?? '';
    const nameIsBanana = /^\d+-Bananas\b/i.test(slug) || /^Bananas\b/i.test(name);
    if (nameIsBanana && !REJECT.test(`${slug} ${name}`)) return a;
  }
  throw new Error(
    'add-bananas: no actual banana in the search results (product 92685 / a "Bananas…" result absent — ' +
      'only boosted/merchandised look-alikes like Sweet Cherries). Search boost changed; re-recon banana selection.',
  );
}

/** Best-effort residual cart count for clearCart's empty-verify. Prefers the header cart BADGE (server
 *  truth via readCartCount); if there's no numeric badge, treats a rendered empty-cart state ("your cart is
 *  empty" / "start shopping") as 0, else falls back to the count of VISIBLE cart line items. Returns -1 when
 *  the state is genuinely UNKNOWN (no badge, no empty-state, no line items) — the caller MUST NOT treat -1
 *  as empty. This is the fix for the old false-pass: a missing/unnumbered badge used to read as 0 and let a
 *  broken clear look successful. */
async function cartResidual(page: Page): Promise<number> {
  const badge = await readCartCount(page); // header badge = server truth (or null when absent/unnumbered)
  if (badge !== null) return badge;
  const emptyState = await page
    .getByText(/your cart is empty|cart is empty|no items in your cart|start shopping|cart is currently empty/i)
    .filter({ visible: true })
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (emptyState) return 0;
  const lineItems = await countSafe(
    page.locator('[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]').filter({ visible: true }),
  );
  if (lineItems > 0) return lineItems; // definitely non-empty
  return -1; // UNKNOWN — no positive empty signal; never reported as empty
}

/** Best-effort dismiss the /cart cookie-consent banner ("Our website uses cookies… [Close]") that sits
 *  at the BOTTOM of the cart page and can intercept the ⋮ meatball click OR overlay the "Delete Items"
 *  confirm dialog. SCOPED to a cookie/consent container so it can NEVER dismiss the confirm modal itself
 *  (a generic page-wide "close" could). Prefers "Close" (the banner's actual control), then accept/got-it.
 *  Bounded, optional (no-op if absent), never throws. Returns a status the clear-cart telemetry logs:
 *  'absent' (no banner), 'dismissed' (banner present + close clicked), 'present' (present but no closer). */
async function dismissCookieBanner(page: Page): Promise<'absent' | 'dismissed' | 'present'> {
  const banner = page
    .locator('[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [aria-label*="cookie" i]')
    .filter({ visible: true })
    .first();
  if (!(await banner.isVisible({ timeout: 800 }).catch(() => false))) return 'absent';
  const btn = banner
    .getByRole('button', { name: /close|accept( all)?( cookies)?|got it|^ok$|i (agree|accept)|dismiss/i })
    .or(banner.getByRole('link', { name: /close|accept|got it|dismiss/i }))
    .filter({ visible: true })
    .first();
  const clicked = await btn.click({ timeout: 1500 }).then(() => true).catch(() => false);
  return clicked ? 'dismissed' : 'present';
}

/** ★ CLEAR-CART PER-SUBSTEP TELEMETRY (this PR). Emit one `CLEAR-STEP <label> <sub> <result> <detail>`
 *  line to BOTH Node stdout (runner container logs — the deep-dive channel) AND the page console →
 *  trace_signals.console, so the breadcrumb SURVIVES into the persisted failure trace (compact ≤195, the
 *  redaction-safe channel). `label` tags baseline-clear vs teardown. Returns the compact line so clearCart
 *  can accumulate a breadcrumb for the CLEAR-SUMMARY line + the thrown error_message. Structural only —
 *  URL host+path / counts / booleans, never creds/token/DOM/PII. Never throws. */
async function clearStep(page: Page, label: string, sub: string, result: string, detail = ''): Promise<string> {
  const line = `[full-shop-flow] CLEAR-STEP ${label} ${sub} ${result}${detail ? ' ' + detail : ''}`;
  console.log(line);
  const compact = line.slice(0, 195);
  await page.evaluate((m) => console.warn(m), compact).catch(() => {});
  return compact;
}

/** True if a response is a wegmans cart-CLEAR/empty/delete WRITE — the transform-independent proof the
 *  "Yes, delete items" confirm actually reached the server. Reuses the isCartWrite gate (non-GET to a
 *  *.wegmans.(com|cloud)/wegapi cart/basket/lineitems path, status<500) and ALSO accepts an explicit
 *  DELETE method or an empty/clear path segment (an "Empty My Cart" bulk clear is typically a DELETE to
 *  the cart/lineitems collection or a POST to a clear/empty endpoint). Host+path/method only. */
function isCartClearWrite(method: string, url: string, status: number): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  if (isCartWrite(method, url, status)) return true;
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
  return onWegmansApi && /\/(cart|basket|line-?items?)/i.test(url) && (method === 'DELETE' || /empty|clear|delete/i.test(url)) && status < 500;
}

/** ★ ROBUST-CLICK LADDER for a React control that ACCEPTS a click but whose onClick does not fire on a plain
 *  locator.click() — the SAME click-strategy ladder addToCartLadder uses (hydrate+locator → precise-center →
 *  raw-pointer → dispatch-events → force), generalized to any trigger + caller-supplied success probe.
 *  Clicks `trigger`, then after each strategy gives `opened` an ARMED visibility wait (≤armMs, no hard sleep);
 *  STOPS and returns the strategy name the instant `opened` becomes visible, or null if none opened it. This
 *  is what OPENS the cart's ⋮ meatball menu: trace 935321 shows the menu items (Print/Share/Empty My Cart)
 *  render 0x — the dropdown never opened for the runner's plain click, so "Empty My Cart" was never clickable
 *  (identical click-lands-but-handler-doesn't-fire bug as add-to-cart). Structural/booleans only; never
 *  throws (a strategy that throws — not actionable / no bbox — just falls through to the next). */
async function robustClickToOpen(page: Page, trigger: Loc, opened: Loc, armMs = 1800): Promise<string | null> {
  const RUNG_CLICK_TIMEOUT = 2200;
  const t = trigger.first();
  const strategies: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'hydrate+locator',
      run: async () => {
        await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
        await t.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await t.click({ timeout: RUNG_CLICK_TIMEOUT });
      },
    },
    {
      name: 'precise-center',
      run: async () => {
        const box = await t.boundingBox();
        if (!box) throw new Error('precise-center: no bounding box');
        await t.click({ position: { x: box.width / 2, y: box.height / 2 }, timeout: RUNG_CLICK_TIMEOUT });
      },
    },
    {
      name: 'raw-pointer',
      run: async () => {
        const box = await t.boundingBox();
        if (!box) throw new Error('raw-pointer: no bounding box');
        await t.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.up();
      },
    },
    {
      name: 'dispatch-events',
      run: async () => {
        await t.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const opts: any = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          (el as HTMLElement).click();
        });
      },
    },
    {
      name: 'force',
      run: async () => {
        await t.click({ force: true, timeout: RUNG_CLICK_TIMEOUT });
      },
    },
  ];
  for (const s of strategies) {
    try {
      await s.run();
    } catch {
      /* strategy threw (not actionable / no bbox) — fall through to the next rung */
    }
    if (await appearsWithin(opened, armMs)) return s.name;
  }
  return null;
}

/** Teardown / baseline — clear the cart via the cart page's NATIVE "Empty My Cart" BULK action (⋮ menu),
 *  NOT a per-item Remove loop. Recon (trace 934649 + Craig's cart-page screenshot): the prior per-item
 *  remove loop fired ZERO removal requests — its /^remove$/ button selector never matched the real cart's
 *  remove control, so nothing cleared and the previous session's items PERSISTED and accumulated (cart hit 5
 *  → verify-cart-4 failed). The /cart page has a MEATBALL menu (⋮, top-right of "My Cart") that opens a
 *  dropdown (Print / Share / Add to Saved Lists / Empty My Cart); "Empty My Cart" (trash icon) is a SINGLE
 *  bulk clear — one action, exactly how a user empties the cart. Flow: dismiss cookie banner → open ⋮
 *  ROBUSTLY → VERIFY the menu opened ("Empty My Cart" visible) → click "Empty My Cart" → confirm "Yes,
 *  delete items" → VERIFY the cart is DURABLY 0 (server truth via readCartCount / cartResidual). One retry,
 *  then a loud STEP-FAIL with the residual count — NEVER a silent pass.
 *
 *  ★ TRUE ROOT CAUSE (hands-on recon, live logged-in cart, 2026-07-10 — corrects the earlier trace-935321
 *  "React onClick doesn't fire" INFERENCE): the ⋮ menu was "0-for-3" because this function navigated to
 *  https://www.wegmans.com/shop/cart, which is NOT the cart route — a hard GET there returns a 231-byte JSON
 *  SHELL with ZERO buttons (the SPA mounts no cart there). The real cart is /cart (see CART_URL); on /cart a
 *  PLAIN click opens the ⋮ menu instantly and "Empty My Cart" is a clean role=menuitem, the "Delete Items"
 *  dialog's primary is "Yes, delete items" — all matching the selectors below. So the menu selectors, the
 *  menu-open probe, and the confirm were correct all along; they simply never ran against a rendered page.
 *  The robustClickToOpen ladder below is now belt-and-suspenders (its first plain-click rung already opens
 *  the menu) — kept to absorb any headless pointer/focus quirk, but the URL fix (CART_URL) is what matters. */
async function clearCart(page: Page, label = 'clear-cart (teardown)'): Promise<void> {
  await step(label, async () => {
    // A native window.confirm (if Wegmans uses one instead of an in-page modal) would BLOCK the run — accept
    // it. An in-page role=dialog is handled by clicking its confirm button below. Registered once; removed in
    // finally so we don't stack handlers or leak across the retry.
    page.on('dialog', (d) => {
      void d.accept().catch(() => {});
    });
    // ★ DELETE-FIRED LISTENER (this PR) — the transform-independent proof the confirm reached the server.
    //   Records every wegmans cart-CLEAR/empty/delete WRITE (method/status/path) so a fire can distinguish
    //   "confirm never fired a request" (client-side break: menu/empty/dialog/confirm) from "delete fired
    //   but the count stayed >0" (server did not persist). Structural only; never breaks the flow.
    const clearWrites: Array<{ method: string; status: number; path: string }> = [];
    const onClearResp = (resp: any) => {
      try {
        const m = resp.request().method();
        if (isCartClearWrite(m, resp.url(), resp.status())) {
          clearWrites.push({ method: m, status: resp.status(), path: safeLoc(resp.url()) });
        }
      } catch {
        /* telemetry never breaks the flow */
      }
    };
    page.on('response', onClearResp);
    try {
      const MAX_ATTEMPTS = 2; // first attempt + one retry
      let remaining = -1;
      let initialCount = -1; // the N to clear (from the first attempt) — for CLEAR-SUMMARY
      let failedAt = 'unknown'; // the last sub-step that did not reach OK — for CLEAR-SUMMARY + the throw
      const crumbs: string[] = []; // accumulate the CLEAR-STEP lines → thrown error_message carries the breadcrumb
      const crumb = async (sub: string, result: string, detail = '') => {
        crumbs.push(await clearStep(page, label, sub, result, detail));
      };
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const tag = `attempt=${attempt + 1}`;

        // ── SUB-STEP 1: NAV — navigate to the cart page + log the URL we actually landed on ──────────────
        failedAt = 'NAV';
        const navOk = await page.goto(CART_URL, { waitUntil: 'domcontentloaded' }).then(() => true).catch(() => false);
        await dismissInterstitials(page);
        const landedUrl = safeLoc(page.url());
        const cartAppUp = await isVisibleSafe(page.locator('[class*="cart" i], [data-testid*="cart" i]').first());
        await crumb('NAV', navOk && cartAppUp ? 'OK' : 'FAIL', `${tag} url=${landedUrl} goto=${navOk ? 'y' : 'n'} cartApp=${cartAppUp ? 'y' : 'n'}`);

        // ── SUB-STEP 3 (read early): INITIAL-COUNT — the N to clear (server-truth badge). Already-empty short-circuits.
        const before = await cartResidual(page);
        if (attempt === 0) initialCount = before;
        await crumb('INITIAL-COUNT', before < 0 ? 'FAIL' : 'OK', `${tag} cart=${before}`);
        if (before === 0) {
          failedAt = 'none';
          await crumb('SUMMARY', 'OK', `${tag} already-empty initial=${initialCount} final=0`);
          return;
        }

        // ── SUB-STEP 2: COOKIE-BANNER — present? dismissed? (can intercept the ⋮ click / overlay the dialog) ──
        failedAt = 'COOKIE-BANNER';
        const cookie = await dismissCookieBanner(page);
        await crumb('COOKIE-BANNER', 'OK', `${tag} state=${cookie}`);

        // The "Empty My Cart" dropdown item — the SUCCESS PROBE for "the menu opened" AND the click target.
        // Trace 935321: when the menu is CLOSED this renders 0x, so its visibility is the reliable menu-open
        // signal (the menu items only exist inside the OPEN dropdown).
        const emptyItem = page
          .getByRole('menuitem', { name: /empty (my )?cart/i })
          .or(page.getByRole('button', { name: /empty (my )?cart/i }))
          .or(page.getByRole('link', { name: /empty (my )?cart/i }))
          .or(page.getByText(/empty my cart/i))
          .filter({ visible: true })
          .first();

        // ── SUB-STEP 4: MEATBALL-FOUND — is the ⋮ "cart actions" button located + visible? ────────────────
        failedAt = 'MEATBALL-FOUND';
        const meatball = page
          .getByRole('button', { name: /more options|more actions|cart actions|cart options|^more$|^options$|^actions$|^menu$/i })
          .or(page.locator('button[aria-haspopup="menu"], button[aria-haspopup="true"]').filter({ visible: true }))
          .or(page.getByRole('button', { name: /⋮|kebab|ellipsis/i }))
          .filter({ visible: true })
          .first();
        const meatballCount = await countSafe(meatball);
        const meatballVisible = await isVisibleSafe(meatball);
        await crumb('MEATBALL-FOUND', meatballVisible ? 'OK' : 'FAIL', `${tag} vis=${meatballVisible ? 'y' : 'n'} count=${meatballCount}`);

        // ── SUB-STEP 5: MEATBALL-CLICKED / MENU-OPEN — open the ⋮ menu ROBUSTLY, then VERIFY it opened. The old
        //    code did a single plain click then BLINDLY clicked "Empty My Cart"; robustClickToOpen tries the
        //    click-strategy ladder, treating "Empty My Cart" becoming visible as the open signal, up to 3 tries.
        failedAt = 'MENU-OPEN';
        let openedVia: string | null = null;
        for (let openTry = 0; openTry < 3 && openedVia === null; openTry++) {
          if (!(await meatball.isVisible({ timeout: 4000 }).catch(() => false))) {
            await dismissInterstitials(page); // meatball not found this round — clear overlays, re-probe
            await dismissCookieBanner(page);
            continue;
          }
          openedVia = await robustClickToOpen(page, meatball, emptyItem, 1800);
        }
        const menuOpen = openedVia !== null && (await isVisibleSafe(emptyItem));
        await crumb('MENU-OPEN', menuOpen ? 'OK' : 'FAIL', `${tag} menuOpen=${menuOpen ? 'y' : 'n'} via=${openedVia ?? 'NONE'}`);

        if (menuOpen) {
          // ── SUB-STEP 6: EMPTY-CLICKED — click "Empty My Cart" (the trash-icon dropdown item). ───────────
          failedAt = 'EMPTY-CLICKED';
          const emptyClicked = await emptyItem.click({ timeout: 4000 }).then(() => true).catch(() => false);
          await dismissInterstitials(page);
          await crumb('EMPTY-CLICKED', emptyClicked ? 'OK' : 'FAIL', `${tag} clicked=${emptyClicked ? 'y' : 'n'}`);

          // ── SUB-STEP 7: DIALOG-APPEARED — did the "Delete Items" confirm dialog render? Live screenshots:
          //    title "Delete Items", PRIMARY button EXACTLY "Yes, delete items" (red), secondary "Cancel".
          failedAt = 'DIALOG-APPEARED';
          const dialog = page.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true }).last();
          const confirmBtn = dialog
            .getByRole('button', { name: /yes,?\s*delete items/i })
            .or(page.getByRole('button', { name: /yes,?\s*delete items/i }))
            .filter({ visible: true })
            .first();
          const confirmShown = await confirmBtn
            .waitFor({ state: 'visible', timeout: 6000 })
            .then(() => true)
            .catch(() => false);
          const dialogVisible = await isVisibleSafe(dialog);
          // Cookie banner can overlay the modal: dismiss COOKIES ONLY (scoped — never the confirm modal).
          await dismissCookieBanner(page);
          await crumb('DIALOG-APPEARED', confirmShown ? 'OK' : 'FAIL', `${tag} dialog=${dialogVisible ? 'y' : 'n'} confirmBtn=${confirmShown ? 'y' : 'n'}`);

          if (confirmShown) {
            // ── SUB-STEP 8: CONFIRM-CLICKED — click "Yes, delete items". ─────────────────────────────────
            failedAt = 'CONFIRM-CLICKED';
            const writesBeforeConfirm = clearWrites.length;
            const confirmClicked = await confirmBtn.click({ timeout: 4000 }).then(() => true).catch(() => false);
            await dismissInterstitials(page);
            await crumb('CONFIRM-CLICKED', confirmClicked ? 'OK' : 'FAIL', `${tag} clicked=${confirmClicked ? 'y' : 'n'}`);

            // ── SUB-STEP 9: DELETE-FIRED — did a cart-clear/delete NETWORK write fire after the confirm? ──
            //    Give the request a bounded window to land (no hard sleep) then read what the listener saw.
            failedAt = 'DELETE-FIRED';
            await page.waitForResponse((r) => isCartClearWrite(r.request().method(), r.url(), r.status()), { timeout: 6000 }).catch(() => null);
            const fired = clearWrites.slice(writesBeforeConfirm);
            const lastWrite = fired[fired.length - 1];
            await crumb(
              'DELETE-FIRED',
              fired.length ? 'OK' : 'FAIL',
              `${tag} writes=${fired.length}${lastWrite ? ` last=${lastWrite.method}:${lastWrite.status}:${lastWrite.path}` : ''}`,
            );
          }
        }

        // ── SUB-STEP 10: FINAL-COUNT / VERIFY — FRESH nav + cart BADGE (server truth), not optimistic DOM. ──
        failedAt = 'FINAL-COUNT';
        await page.goto(CART_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await dismissInterstitials(page);
        remaining = await cartResidual(page);
        await crumb('FINAL-COUNT', remaining === 0 ? 'OK' : 'FAIL', `${tag} before=${before} remaining=${remaining}`);
        if (remaining === 0) {
          failedAt = 'none';
          await crumb('SUMMARY', 'OK', `${tag} initial=${initialCount} final=0`);
          return; // durably empty
        }
      }
      // Still non-empty (or unknown) after the retry → loud STEP-FAIL. The CLEAR-SUMMARY names the exact
      // failing sub-step; the breadcrumb (every CLEAR-STEP line) is folded into the thrown error_message so
      // the persisted failure trace pinpoints WHERE the clear broke (nav / cookie / meatball / menu-open /
      // empty-click / dialog / confirm / delete-fired / final-count) with initial=N final=M — no more guessing.
      const summary = await clearStep(page, label, 'SUMMARY', 'FAIL', `failedAt=${failedAt} initial=${initialCount} final=${remaining} attempts=${MAX_ATTEMPTS}`);
      const d = await captureStepDiag(page, label).catch(() => ({ full: '', compact: '' }));
      console.log(`[full-shop-flow] STEP-FAIL ${label} DIAG ${d.full}`);
      if (d.compact) await page.evaluate((m) => console.warn(m), d.compact).catch(() => {});
      throw new Error(
        `${d.compact} :: ${summary} :: BREADCRUMB=[ ${crumbs.join(' | ')} ] :: ${label}: cart NOT empty ` +
          `(residual=${remaining}) after ${MAX_ATTEMPTS} "Empty My Cart" attempts — failing sub-step: ${failedAt}.`,
      );
    } finally {
      page.off('response', onClearResp);
      page.removeAllListeners('dialog');
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
