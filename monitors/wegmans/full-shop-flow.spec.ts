import { test, expect, step, dismissInterstitials, credential, type Page } from '../../lib/flow';

/**
 * Monitor: wegmans-full-shop-flow — ★ FULL AUTHENTICATED PICKUP SHOPPING FLOW (SENSITIVE; ships DISABLED)
 *
 * Journey: login → search+add milk/eggs/bread/bananas → verify 4 in cart → checkout as PICKUP → confirm
 * pickup TIMESLOTS render + are selectable → SELECT a slot → clear cart → logout.
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
 * ★ LIVE-VERIFIED IN PRODUCTION (2026-07): this flow is ENABLED + scheduled (30-min) and passes end-to-end
 * — every step's selector is confirmed by passing runs (checkout-pickup / timeslots-render / select-slot:
 * 30/30 green over 7d; verify-cart-4 counts exactly the 4 added items, agreeing with the server badge;
 * add-to-cart commits via the DOM-verified buy-box ladder). Each step is still wrapped so a failure emits a
 * STRUCTURAL diag (STEP-FAIL … DIAG) capturing the real DOM — the forensic that pinpointed e.g. the seasonal
 * "Red, White & Blue" bread hijack (#100) and the transient Product-API fetch failure behind it. (Authored
 * resilient/structural because the authoring session could not drive the authenticated DOM — no test creds
 * + Akamai bot-block from a non-allowlisted IP; that gap is closed by the passing production runs.)
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
/** Hard wall-clock cap: abort to teardown before this, so a run can't bleed into the next tick
 *  (concurrency axis b). ★ PERMANENT + JUSTIFIED — do NOT lower. This authenticated multi-product cart is
 *  the fleet's longest flow; its real distribution is p50 247s / p95 317s / p99 450s / max 613s (cost recon
 *  2026-07-12), so 600s is sized to clear the LEGITIMATE tail — a lower cap would false-red a genuine
 *  slow-but-successful run. It is deliberately coherent with the runner's whole-flow budget
 *  (runner/index.ts MAX_FLOW_MS = 600_000, the BINDING limit — this spec cap aborts to teardown just under
 *  it) and stays under the 660s ACA replicaTimeout (infra/main.bicep) so the run finalizes rather than
 *  being pod-killed. This is a per-FLOW cap; per-ACTION bounds are ACTION_TIMEOUT/NAV_TIMEOUT/STEP_TIMEOUT
 *  below. */
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
//   own href is "/cart". Used by verify-cart-4 and clearCart (baseline + teardown). */
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

/** A CART LINE-ITEM ROW, by EXACT class token — not a substring. CSS `.component--cart-item` matches an
 *  element whose class LIST contains that token, so `component--cart-item-list`, `cart-item-count`,
 *  `cart-item-content-wrapper` and `component--cart-item-quantity-selector` are all structurally excluded:
 *  they are different tokens, not the row. That is why no `:not(…)` chain is needed here.
 *
 *  ★ Replaces `li[class*="item" i]`, which matched ANY nav <li> carrying the Tailwind class
 *  `tw:items-center` — "items-center" contains "item". `<li class="list-element tw:py-1 tw:md:py-0
 *  tw:flex tw:items-center">` appeared 288× in the 2026-07-30 failing trace, so every header/nav list
 *  item counted as a cart row (the confidently-wrong count this PR removes).
 *
 *  ★ Fails in the SAFE direction: if Wegmans renames the row token this matches nothing, the count reads
 *  0, and the caller's `≥4` assertion reds loudly. A substring selector fails the other way — it keeps
 *  matching something and keeps reporting a number that means nothing.
 *
 *  ★ NOTE: cartResidual carries its own, deliberately LOOSER row expression (landed in #118). That is not
 *  duplication to unify: there, a row count only ever reports NON-emptiness, so looseness costs extra
 *  clearing work and can never manufacture a false "empty". Here the count feeds an assertion, so
 *  precision is the requirement. Different jobs, different selectors — left as landed. */
const CART_ROW_SEL = '.component--cart-item, [data-testid="cart-item"]';

/** The cart control's own count, from its aria-label: "View 13 selected items in my Cart" — a word
 *  ("selected") sits between the number and "items", so an optional intervening word is allowed. */
const CART_ARIA_COUNT_RX = /(\d+)\s+(?:\w+\s+)?(?:items?|products?)/i;

/** How long to wait for the cart control to be ATTACHED before reading its aria-label. Bounded; a miss
 *  is not fatal, it just means the primary signal is unavailable and we fall to the last resort. */
const CART_CTL_TIMEOUT_MS = 2_000;

/** LAST-RESORT badge shapes, used only when the semantic aria-label is unavailable. Every arm excludes
 *  `cart-item*` on BOTH the container and the counted element, because the old
 *  `[class*="cart" i] [class*="count" i]` matched `cart-item-count` — the PER-ROW QUANTITY STEPPER —
 *  nested inside `component--cart-item-list`. That is how a page could report a line item's quantity as
 *  if it were the cart's item count. */
const CART_BADGE_FALLBACK_SELECTORS = [
  '[data-testid*="cart-count" i]:not([data-testid*="cart-item" i])',
  '[data-testid*="cart" i]:not([data-testid*="cart-item" i]) [class*="count" i]:not([class*="cart-item" i])',
  'a[href*="/cart" i] [class*="badge" i]:not([class*="cart-item" i]), a[href*="/cart" i] [class*="count" i]:not([class*="cart-item" i])',
  '[class*="cart" i]:not([class*="cart-item" i]) [class*="badge" i]:not([class*="cart-item" i]), [class*="cart" i]:not([class*="cart-item" i]) [class*="count" i]:not([class*="cart-item" i])',
];

/**
 * The cart's item count, or null when we could not obtain one. Structural only — reads a small count
 * string, never account data.
 *
 * ★ PRECEDENCE INVERTED (2026-07-30). This used to try four loose class-substring selectors FIRST and
 *   consult the aria-label LAST, so a match on `cart-item-count` (a per-row quantity stepper) pre-empted
 *   the correct answer and was returned as the cart's count. Through the whole 2026-07-29/30 incident the
 *   aria-label was RIGHT — it progressed 0→1→2→3→4 and never read the wrong value — while the count the
 *   monitor asserted on was wrong for 34 consecutive runs. So the aria-label is now the PRIMARY signal:
 *   it is semantic, explicitly numeric, and states what it counts. The class-substring shapes are the
 *   last resort, and are scoped away from per-row controls.
 *
 * ★ NULL IS NOT ZERO. A caller must be able to tell "no count available" from "a real count of 0", so
 *   the ONLY path that may report 0 is the primary semantic signal, which says 0 because the control
 *   says 0. A 0 arriving from a LAST-RESORT selector is returned as null (UNKNOWN) — an unhydrated or
 *   mis-targeted element reading `0` is precisely the confident lie this function used to tell. A
 *   NON-ZERO fallback value is still returned: over-reporting is recoverable, under-reporting is what
 *   let a dirty cart look clean (the same asymmetry cartResidual uses).
 *
 * ★ Every current caller already handles null: the ladder's three sites log `?? '?'`, verify-cart-4 does
 *   `cartBadge ?? n`, cartResidual checks `!== null && > 0`, and clearCart's BADGE-HINT logs `?? '?'`.
 *   Audited 2026-07-30 — no caller treats null as a number. Keep it that way.
 */
async function readCartCount(page: Page): Promise<number | null> {
  // ── PRIMARY: the cart control's own aria-label ────────────────────────────────────────────────────
  const cartCtl = page.getByRole('link', { name: /cart/i }).or(page.getByRole('button', { name: /cart/i })).first();
  // Bounded wait so we do not read the attribute before the control exists. A timeout is not fatal.
  await cartCtl.waitFor({ state: 'attached', timeout: CART_CTL_TIMEOUT_MS }).catch(() => {});
  const al = await cartCtl.getAttribute('aria-label').catch(() => null);
  const primary = al ? CART_ARIA_COUNT_RX.exec(al) : null;
  if (primary) return parseInt(primary[1], 10); // the control's own number — 0 included, it means 0

  // ── LAST RESORT: class-substring badge shapes, scoped away from per-row controls ──────────────────
  for (const sel of CART_BADGE_FALLBACK_SELECTORS) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count().catch(() => 0)) {
      const t = (await loc.innerText({ timeout: 400 }).catch(() => '')).trim();
      const m = /\d+/.exec(t);
      if (m) {
        const v = parseInt(m[0], 10);
        return v > 0 ? v : null; // ★ a 0 from here is UNKNOWN, never "the cart is empty"
      }
    }
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
    host = new URL(url).hostname.toLowerCase();
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

/**
 * A wegmans cart READ — a completed `GET …/commerce/cart/carts…` (2xx).
 *
 * ★ Deliberately separate from isCartWrite, because the two answer different questions and the failure of
 *   2026-07-31 was conflating them. The add's WRITE is a POST that usually aborts (status -1), so its
 *   response never arrives and carries no body. The cart page's READ completes — it is the only response
 *   in this flow that reliably delivers the cart document, so it is the one identity is asserted against.
 *
 * Scoped to GET + a wegmans commerce host + the carts path, and requires a real 2xx: a -1/0 (aborted) or
 * an error status must NOT be read as a cart, or we would parse a body that is not there.
 */
function isCartRead(method: string, url: string, status: number): boolean {
  if (method !== 'GET') return false;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
  return onWegmansApi && /\/commerce\/cart\/carts/i.test(url) && status >= 200 && status < 300;
}

/**
 * The SKU set in a wegmans cart API response body, or null if this body is not a cart.
 *
 * ★ OBSERVED SHAPE (recon, runs 1093506 / 1096363): a `POST
 *   api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/lineitems` returns the WHOLE cart —
 *   `{ StoreKey, customerID, customerEmail, cartData: [ { cartID, cartVersion, lineItems: [ { sku,
 *   quantity, … } ] } ] }`. So the add mutation's own response is the server's record of cart contents,
 *   exactly as meals2go-cheese-pizza-cart uses its cart-items POST response.
 *
 * ★ Keyed on the BODY, not on a URL pattern: any cart-write response that parses to cartData[].lineItems
 *   is a cart, so an APIM path change cannot silently stop this working. Returns null (not []) when the
 *   body is not a cart, so "not a cart response" stays distinguishable from "a cart with no items".
 */
function cartSkusFromBody(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const cartData = (body as { cartData?: unknown }).cartData;
  if (!Array.isArray(cartData) || cartData.length === 0) return null;
  const lineItems = (cartData[0] as { lineItems?: unknown } | null)?.lineItems;
  if (!Array.isArray(lineItems)) return null;
  const skus: string[] = [];
  for (const it of lineItems) {
    const sku = it && typeof it === 'object' ? (it as { sku?: unknown }).sku : undefined;
    if (typeof sku === 'string' && sku.length > 0) skus.push(sku);
    else if (typeof sku === 'number' && Number.isFinite(sku)) skus.push(String(sku));
  }
  return skus;
}

/** What the cart read actually did — the three distinguishable outcomes behind "serverCartSkus is null". */
export interface CartReadOutcome {
  /** A GET …/commerce/cart/carts 2xx was matched by waitForResponse. */
  readMatched: boolean;
  /** First line of the error `.json()` threw, or null if it did not throw. */
  parseError: string | null;
  /** Top-level keys of the parsed body, or null if we never got to parse one. */
  bodyKeys: string[] | null;
}

/**
 * Why no server cart state is available — as one of THREE distinct findings, each naming a different
 * next action: chase the REQUEST, chase the TRANSPORT, or chase the CONTRACT.
 *
 * ★ THE BUG THIS REPLACES: all three collapsed into one message that ASSERTED the third — "The API
 *   response shape may have changed" — while the evidence that would have settled it was discarded by a
 *   bare `catch {}`. Run 1146366 was diagnosed by downloading an 8 MB trace to establish something the
 *   run already knew and had thrown away. Fourth appearance of the swallowed-error class (#127, #130,
 *   the clear-cart clicks, this).
 *
 * ★★ NEVER ASSERT A SHAPE CHANGE WITHOUT HAVING SEEN THE SHAPE. The shape-change branch is the ONLY one
 *   that may say so, and it prints the top-level keys it saw as the evidence. Keys are NAMES, never
 *   values — this string reaches runs.error_message.
 */
export function noCartStateReason(o: CartReadOutcome): string {
  if (!o.readMatched) {
    return (
      `no cart read matched — no GET …/commerce/cart/carts returned 2xx within the step budget, so the ` +
      `REQUEST is what to look at (did it fire at all? different host/path? aborted at status -1 the way ` +
      `the add POSTs do?)`
    );
  }
  if (o.parseError !== null) {
    return (
      `read matched but the body did not parse: ${o.parseError}. The request is fine; the TRANSPORT or ` +
      `the read is not (body consumed by a navigation, non-JSON payload, truncated response)`
    );
  }
  return (
    `body parsed but carried no cartData[].lineItems — top-level keys were ` +
    `[${(o.bodyKeys ?? []).join(', ')}]. THIS is the shape-change case, and those keys are the evidence ` +
    `for it`
  );
}

/** The SKU a product-detail URL identifies: `/shop/product/92685-Bananas-Sold-by` → `"92685"`.
 *  ★ Confirmed against the cart API in the recon: the PDP slug's leading number IS the cart lineItem
 *  sku (55066 milk / 46155 eggs / 60715 bread / 92685 bananas). This is how a run learns what it added
 *  WITHOUT a hardcoded SKU list — a catalog change moves the monitor's expectation with it instead of
 *  manufacturing a failure. */
function skuFromProductUrl(url: string): string | null {
  const m = /\/shop\/product\/(\d+)/.exec(url);
  return m ? m[1] : null;
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
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // ★ FALSE-NEGATIVE FIX (mirrors isCartWrite #81): the REAL production fulfillment write is a POST to
  // api.digitaldevelopment.wegmans.CLOUD/commerce/instacart/fulfillment/service_options/pickup (200) —
  // "digitaldevelopment" is the Wegmans Digital team's PRODUCTION APIM host, NOT a dev env. The old gate
  // matched only *.wegmans.COM, so it REJECTED the real successful set-store write and logged setStoreWrite=n
  // (a false negative). Accept *.wegmans.cloud too (still scoped to wegmans commerce hosts + a fulfillment/
  // store path — never analytics/3rd-party). host uses .hostname (drops any :port that breaks the $ anchor).
  const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
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
        // (Removed a `waitForLoadState('networkidle')` settle here: Wegmans keeps persistent
        // astutebot/emplifi/LaunchDarkly sockets open so the page NEVER goes idle → it paid the full
        // HYDRATE_MS every run for nothing. The real hydration gate is waitForReactHandler above; the
        // click below auto-waits for actionability; the add is asserted by the stepper/cart-write commit.)
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
    `match=${matchCount}(vis${visMatchCount}) ready=${readyState} cart=${cartBefore ?? '?'}->${cartAfter ?? '?'}`;

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
  // ★★ THE SAME ANCHORS GATE 1 ASSERTS ON — not a substring match on "cart".
  //    It was `[class*="cart" i], [data-testid*="cart" i]` + .first() + no visible filter, which
  //    (a) matches ANY element whose class merely CONTAINS "cart" — cart-item-count, add-to-cart-button,
  //        a cart-shaped icon wrapper — and (b) `.first()` then pins whichever of those is first in DOM
  //        order, visible or not. OBSERVED 2026-08-05 run 1146366: the diag reported `cart0`
  //        (cartPresent:false) on a run where GATE 1 — using the scoped anchors below — PASSED. A
  //        diagnostic that contradicts the assertion it sits next to sends the reader hunting a render
  //        failure that did not happen.
  //    ★ THIRD APPEARANCE of the loose-selector trap in this fleet: the Meals2Go promo hijack (#129,
  //      an aria-label containing "cheese" won `.first()`), the `li[class*="item" i]` cart-row count
  //      (`tw:items-center` contains "item", 288 false rows), and now this. The pattern each time is a
  //      SUBSTRING match plus `.first()` with nothing pinning WHICH element is meant. Reuse the anchor
  //      the assertion uses; do not re-derive a looser one for the diagnostic.
  const cartPresent = await isVisibleSafe(
    page.locator(CART_LIST_SEL).or(page.locator(CART_ROW_SEL)).or(page.getByText(CART_EMPTY_RX)),
  );
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
      console.log(`[full-shop-flow] STEP-TIMING ${name} ${ms}ms`);
    } catch (err) {
      const ms = Date.now() - t0;
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

  // (Removed the DIAGNOSTIC CART-API listener + cartApiCalls/cartWriteCount + the stepTimings accumulator:
  //  #96 deleted their only readers — CART-STATE and FLOW-SUMMARY — leaving them write-only. The listener
  //  fired on every network response for the whole run and its `console.log('CART-API …')` went to Node
  //  stdout only (NOT captured in the trace). The add ASSERTION is unaffected: it uses the ladder's own
  //  local `cartWrites` array + the stepper-transform signal, never this module-level cartWriteCount.)

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
      // (Removed a standalone LOGIN-STATE console.log; signInStill is kept — it's woven into the greeting
      //  assertion's failure message below, the forensic that explains WHY a login red happened.)
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

    // (Removed a STORE-STATE @before-add diagnostic block here — an extra readFulfillmentState + log that
    //  backed NO assertion. The store binding IS asserted above in select-store-mckinley
    //  (setStoreSeen || boundByState → toBeTruthy), which is the coverage.)

    // ---- STEP: BASELINE CLEAR — start from a known-EMPTY cart (determinism) ------------------------
    // The cart is server-side + per-account, so it PERSISTS across runs. A previous run whose end-of-flow
    // teardown was bypassed (e.g. a mid-flow hang killed the run before `finally`) leaves residue that
    // otherwise ACCUMULATES (the 17-item pile-up) and skews verify-cart-4. Clear to empty FIRST and verify
    // the badge → 0 (clearCart throws STEP-FAIL 'baseline-clear-cart' with the residual count if it can't),
    // so every run starts deterministic regardless of prior state — and the accumulation cannot recur even
    // if this run's own teardown is later skipped. Runs AFTER store-binding (the cart is fulfillment-scoped).
    abortIfOverCap();
    await clearCart(page, 'baseline-clear-cart');

    // ── ★ IDENTITY LEDGER (verify-cart-4's evidence) ────────────────────────────────────────────────
    // What this run ACTUALLY added, and what the SERVER says the cart holds — the two sides verify-cart-4
    // compares. Nothing here is hardcoded: the expectation comes from the PDP each add committed on, so a
    // catalog change moves it rather than faking a failure.
    //
    const expectedAdds: { item: string; sku: string | null }[] = [];
    let serverCartSkus: string[] | null = null; // the LATEST cart the server returned
    let cartWriteSeen = false; // did ANY cart write fire? distinguishes "no request" from "no cart body"
    let cartSeq = 0; // arrival order, so "latest response wins" is deterministic (see below)
    let bestSeq = -1;

    /**
     * ★ READ THE CART BODY WHERE THE RESPONSE ARRIVES (2026-07-30 fix).
     *
     * The first cut of this (#120) installed ONE page-level listener for the whole flow, kicked off
     * `resp.json()` fire-and-forget, collected the promises, and awaited them later in verify-cart-4.
     * That RACED THE NAVIGATIONS: this flow navigates on every add (search → PDP) and again into /cart,
     * and a Playwright response body stops being readable once the page moves on. So every parse
     * rejected, serverCartSkus stayed null, and GATE 2 fired on runs 11:50 and 12:25 — a live red.
     *
     * ★ THE PRECEDENT, followed properly this time: meals2go-cheese-pizza-cart arms its wait BEFORE the
     *   click and awaits the response AND its .json() IMMEDIATELY, with no navigation in between. That is
     *   the invariant — NO DEFERRED BODY READ MAY SURVIVE A NAVIGATION — and this wrapper enforces it
     *   structurally: the listener lives only for the duration of ONE add, and its parses are awaited
     *   before the wrapper returns, i.e. before the loop can navigate again.
     *
     * Body failures stay swallowed: telemetry must never break the flow. A genuinely unreadable body now
     * surfaces as GATE 2's explicit "no cart body" failure — which is the honest outcome, not a crash.
     *
     * ★★ 2026-07-31 — THE SECOND CUT, and the reason the first one still failed. #121 fixed the race it
     *    targeted (the "no parseable cart body" error is gone), but GATE 2 then fired on the OTHER branch:
     *    "no cart write was observed". The obvious hypothesis — the ladder returns on the UI transform
     *    before the write lands, so this wrapper detaches too early — is FALSIFIED by the trace of run
     *    1105330:
     *
     *      lineitems POST at 13:26:27.657Z   ·   that add's ATC-RESULT logged at 13:26:28
     *
     *    The write fires roughly a second BEFORE the ladder returns, i.e. squarely inside the window when
     *    this listener is attached. Timing was never the problem.
     *
     *    ★ THE REAL MECHANISM: three of the four `lineitems` POSTs are recorded with **status -1** —
     *    Playwright's marker for a request that never completed (aborted / cancelled mid-flight). For
     *    those, Playwright fires `requestfailed`, NOT `response`. A `page.on('response')` listener
     *    therefore CANNOT see them, no matter how long it stays attached. (The fourth completed with 200
     *    and carried no body.) The write still reaches the server — the badge climbs 0→1→2→3→4 and the
     *    teardown clears 4 items — the browser just never surfaces a response for it.
     *
     *    ★ So OBSERVING the write and READING the cart are two different events with two different
     *    primitives, and conflating them is the whole defect:
     *      • OBSERVE  → `request` event. Fires when the request is ISSUED, so an aborted write still
     *                   counts. This is what "the write was observed" actually requires.
     *      • READ     → a response that genuinely completes. The add's POST is not that. The cart page's
     *                   own GET is (status 200, observed every run) — armed and awaited in verify-cart-4.
     */
    const withCartBodyCapture = async (run: () => Promise<void>): Promise<void> => {
      const parses: Promise<void>[] = [];
      // ★ OBSERVATION — the `request` event, because an aborted POST never reaches `response`.
      const onCartRequest = (req: { method: () => string; url: () => string }) => {
        try {
          // status is unknown at request time; pass 200 so the shared predicate's `status < 500` arm is
          // satisfied and the match is decided by method + host + path, which is all we know (and all we
          // need — a request that was ISSUED is a write we observed).
          if (isCartWrite(req.method(), req.url(), 200)) cartWriteSeen = true;
        } catch {
          /* telemetry never breaks the flow */
        }
      };
      const onCartBody = (resp: {
        request: () => { method: () => string };
        url: () => string;
        status: () => number;
        json: () => Promise<unknown>;
      }) => {
        try {
          if (!isCartWrite(resp.request().method(), resp.url(), resp.status())) return;
          cartWriteSeen = true;
          // Sequence the read so the LATEST response wins deterministically. Promise resolution order is
          // not arrival order, so "last .then to run" would be arbitrary — and within one add the cart can
          // both grow and (on a retried rung) be rewritten, so "most SKUs" is wrong too.
          const seq = cartSeq++;
          parses.push(
            resp
              .json()
              .then((b) => {
                const skus = cartSkusFromBody(b);
                if (skus && seq > bestSeq) {
                  bestSeq = seq;
                  serverCartSkus = skus;
                }
              })
              .catch(() => {}),
          );
        } catch {
          /* telemetry never breaks the flow */
        }
      };
      page.on('request', onCartRequest);
      page.on('response', onCartBody);
      try {
        await run();
        // Await any bodies HERE — still inside the add step, before the next navigation. Nothing is
        // carried across a nav boundary. (#121's fix; kept, and still correct for the rare POST that
        // does complete.)
        await Promise.allSettled(parses);
      } finally {
        page.off('request', onCartRequest);
        page.off('response', onCartBody);
      }
    };

    // ---- STEP(s): search + add each item (search-select + DOM-verified add-to-cart buy-box ladder) ----
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

        // ★ RESULT SELECTION — every staple is GUARDED against the boosted-merchandise hijack (a raw .first()
        // would silently add the boosted #1, and verify-cart-4 counts, not identity → a false green):
        //   • bananas (trace 933812): a boosted 92928-Sweet-Cherries → selectBananaResult() pins the ACTUAL
        //     banana (id 92685, deterministic) and rejects flavored look-alikes.
        //   • milk / eggs / bread: selectStapleResult(require, reject) — require the staple, reject seasonal/
        //     promo/candy/off-category (MERCH_REJECT). Catches the July-4th "Red, White & Blue" loaf→bread
        //     (trace 955866) AND the live time bomb: Easter chocolate/Cadbury-creme eggs→"eggs".
        // Still a SEARCH-result click (in-context) for all items, never direct product-URL nav (#83).
        const firstProduct =
          item === 'bananas'
            ? await selectBananaResult(page)
            : STAPLE_GUARDS[item]
              ? await selectStapleResult(page, { item, ...STAPLE_GUARDS[item] })
              : // ★ NO SILENT FALLBACK. An unguarded staple must RED, never .first() — a raw .first() would
                //   SILENTLY add the boosted #1 result (a seasonal/promo hijack, the July-4th bread failure),
                //   and verify-cart-4 COUNTS items, not identity, so the run would PASS with the wrong item.
                //   A fifth SHOPPING_ITEMS entry MUST ship with a guard.
                ((): never => {
                  throw new Error(
                    `add-${item}: no result-selection guard for staple "${item}" — it was added to ` +
                      `SHOPPING_ITEMS without a guard. Refusing to .first() (that would silently add the ` +
                      `boosted #1 result; verify-cart-4 counts, not identity → a false green). Add a ` +
                      `STAPLE_GUARDS['${item}'] { require, reject } entry, or a dedicated guard like ` +
                      `selectBananaResult.`,
                  );
                })();
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

        // ★ RECORD WHAT THIS STEP IS ADDING. The PDP url is already hard-asserted above, so its slug is
        // the most reliable in-run statement of identity available. Deliberately NOT an assertion here: a
        // slug without a leading number must not red an add step that otherwise worked. It is recorded as
        // null and verify-cart-4 fails explicitly on an incomplete ledger — fail-closed, but in the step
        // that owns the claim.
        expectedAdds.push({ item, sku: skuFromProductUrl(page.url()) });

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

        // ★ STAPLE VERIFY (milk / eggs / bread): confirm the landed PDP slug IS the intended staple and is
        // NOT a merchandised/seasonal/promo look-alike, BEFORE the add commits. This is the must-go-red that
        // turns a SILENT wrong-item add into a loud failure: verify-cart-4 only COUNTS items (not identity),
        // so without this a boosted promo with a working buy-box (a July-4th loaf, an Easter Cadbury creme
        // egg) would add and the run would PASS with candy in the cart — a false green. Reds loudly instead.
        const guard = STAPLE_GUARDS[item];
        if (guard) {
          const slug = page.url().split('/shop/product/')[1] ?? '';
          const landedIsStaple = guard.require.test(slug) && !guard.reject.test(slug);
          expect(
            landedIsStaple,
            `add-${item}: landed PDP "${slug}" is not a staple ${item} — a boosted seasonal/promo/candy result ` +
              `hijacked the "${item}" search. The monitor must NOT silently add the wrong item (verify-cart-4 ` +
              `counts, not identity). Re-recon ${item} selection.`,
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
        await expect(
          addToCart,
          `add-${item}: the main buy-box "Add to Cart" was not visible within ${Math.round(STEP_TIMEOUT / 1000)}s. ` +
            `The selector is DOM-VERIFIED (trace 925854 + live 2026-07-13 across the milk/eggs/bread PDPs: ` +
            `getByRole button /add…to cart/ or [aria-label*="to cart"], excluding the recommended-item ` +
            `.component--add-to-cart-mini-form). Absent here means the buy-box did not RENDER — the product's ` +
            `data failed to load (e.g. a client-side Product API "Failed to fetch") or the item is out of stock.`,
        ).toBeVisible({ timeout: STEP_TIMEOUT });

        // ── CLICK-FIDELITY PREP ── dismiss any floating "How can we help?"/emplifi chat widget that can
        // overlay the button + swallow the click (the vendored dismissInterstitials does not cover it).
        // (Removed a `waitForLoadState('networkidle', 3000)` PDP settle here: Wegmans NEVER goes idle
        // — persistent astutebot/emplifi/LaunchDarkly sockets keep the network busy forever — so this paid
        // its full 3s on EVERY add for a condition that can never occur. React hydration is handled inside
        // addToCartLadder (waitForReactHandler); the add is gated by the ladder's cart-write/stepper commit.)
        await dismissChatWidget(page);

        // ═══ ADD-TO-CART — CLICK-STRATEGY LADDER (first-commit-wins; full telemetry on total failure) ═══
        // Craig confirms the add works MANUALLY on this buy-box button → a scripting problem (correct
        // button clicked, React onClick doesn't fire; top hypothesis = hydration timing). addToCartLadder
        // runs hydrate+locator → precise-center → raw-pointer → dispatch-events → force, stopping at the
        // first rung whose stepper transform appears OR whose cart-write fires, capturing the
        // reactHandler/hydration state + a transform-independent cart-write signal for EACH rung. On
        // success it records which strategy committed; on total failure it throws with the full ladder map
        // (every rung's reactHandler / click / transform / cartWrite) — a maximally diagnostic fire either
        // way. runStep wraps a throw into error_message + trace_signals.
        // The add ASSERTION lives inside addToCartLadder: it throws if no rung produced the stepper
        // transform OR a cart-write (the transform-independent commit). (Removed the post-add CART-STATE
        // diagnostic block here — a second readCartCount + a transform-probe + a log line that backed NO
        // assertion; the ladder's own commit-or-throw is the coverage.)
        // ★ Wrapped so the cart-body read happens HERE, inside this step, before the loop navigates again.
        await withCartBodyCapture(() => addToCartLadder(page, item, addToCart, addToCartMatches));
      });
    }

    // ---- STEP: verify the cart holds exactly what this run added, BY IDENTITY ----------------------
    //
    // ★ WAS A NODE COUNT (`≥4` on a DOM row count, then `≤4` on `cartBadge ?? n`). Two problems, both
    //   measured on 2026-07-30 across 34 consecutive failures:
    //     • IDENTITY-BLIND. It counted to 4 and never read an item, so a leftover could SATISFY the
    //       threshold and a boosted-merchandise hijack (the July-4th "Red, White & Blue" loaf, Easter
    //       chocolate eggs) could pass with the WRONG product in the cart. The add steps above already
    //       say so twice: "verify-cart-4 COUNTS items, not identity → a false green."
    //     • The number was wrong anyway. The cart genuinely held the 4 correct SKUs while the assertion
    //       read 5 — the count came from loose DOM/badge selectors, not from the cart.
    //
    // ★ NOW: identity off the cart API, following meals2go-cheese-pizza-cart (wait for the cart response,
    //   assert its status, then assert its contents). A nav <li> has no SKU, so it can never be
    //   miscounted; a leftover is named rather than inferred from a threshold.
    //
    // ★ The expectation is what this run ADDED (PDP slugs recorded per add step), never a hardcoded SKU
    //   list — a catalog change moves the expectation with it instead of manufacturing a failure.
    abortIfOverCap();
    await runStep(page, 'verify-cart-4', async () => {
      // ★ THE AUTHORITATIVE CART READ — the cart page's own GET, not the add's POST.
      //
      // The adds' `lineitems` POSTs abort (status -1) on most runs, so their responses never arrive and
      // carry no body; see withCartBodyCapture for the trace evidence. The /cart page issues a
      // `GET …/commerce/cart/carts/` which DOES complete (200 on every run examined) because we are
      // sitting on the page while it resolves.
      //
      // ★ ARMED here (it must precede the navigation that triggers it) but PARSED after GATE 1 — the
      //   cart-identity gate caught an earlier draft that set serverCartSkus before the render assertion.
      //   That gate is right: nothing may make a cart-contents claim before the page is proven to have
      //   rendered. Arming is not a claim; the parse is, so only the parse moves.
      const cartRead = page
        .waitForResponse((r) => isCartRead(r.request().method(), r.url(), r.status()), { timeout: STEP_TIMEOUT })
        .catch(() => null);
      await page.goto(CART_URL, { waitUntil: 'domcontentloaded' });

      // ★ READ THE BODY HERE — before dismissInterstitials, which clicks /continue/i and CAN navigate;
      //   Playwright discards response bodies on navigation, and a deferred read across a navigation is
      //   the exact defect #121 fixed. Captured into a LOCAL and deliberately NOT promoted to
      //   serverCartSkus yet: a capture is not a claim, and no cart-contents claim may precede GATE 1.
      // ★★ RECORD WHICH OF THE THREE STATES WE ARE IN. "readSkus is null" had three distinct causes —
      //    no response matched / the body did not parse / it parsed but carried no lineItems — and GATE 2
      //    collapsed them into one message that ASSERTED the third ("The API response shape may have
      //    changed"). That is a guess presented as a finding, and the evidence that would settle it was
      //    thrown away by a bare `catch {}`. Run 1146366 was diagnosed by downloading an 8 MB trace to
      //    establish something the run already knew. Same class as #127/#130 — fourth appearance.
      const cartResp = await cartRead;
      let readSkus: string[] | null = null;
      let readMatched = false;
      let parseError: string | null = null;
      let bodyKeys: string[] | null = null;
      if (cartResp) {
        readMatched = true;
        try {
          const body: unknown = await cartResp.json();
          // ★ The TOP-LEVEL KEYS, captured BEFORE we judge the shape — so a shape claim is only ever made
          //   with the shape in hand. Names only, never values: this string reaches error_message.
          bodyKeys = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>) : [];
          readSkus = cartSkusFromBody(body);
        } catch (e: unknown) {
          parseError = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 140);
        }
      }

      await dismissInterstitials(page);

      // ── GATE 1: did the /cart APP RENDER? ──────────────────────────────────────────────────────────
      // ★ Asserted FIRST and reported as itself. At the 2026-07-30 failures the diag read
      //   {"cartPresent":false,"checkoutPresent":false,"counts":{"inputs":1}} — a page SHELL. Any count or
      //   cart claim taken from that page is meaningless, so an unmounted cart must fail as a RENDER
      //   failure and say nothing about cart contents.
      const cartApp = page
        .locator(CART_LIST_SEL)
        .or(page.locator(CART_ROW_SEL))
        .or(page.getByText(CART_EMPTY_RX))
        .filter({ visible: true });
      const mounted = await cartApp
        .first()
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT })
        .then(() => true)
        .catch(() => false);
      expect(
        mounted,
        `verify-cart-4: the /cart app did not render within ${Math.round(STEP_TIMEOUT / 1000)}s — no cart ` +
          `line-item list, no cart rows and no empty-cart copy appeared. MEASURED: the page served a shell. ` +
          `This says nothing about what the cart contains; no count or contents assertion is meaningful here.`,
      ).toBeTruthy();

      // ── PROMOTE the authoritative cart read, now that the page is PROVEN to have rendered ──────────
      // The adds' `lineitems` POSTs abort (status -1) on most runs, so their responses never arrive and
      // carry no body; see withCartBodyCapture for the trace evidence. The /cart page issues a
      // `GET …/commerce/cart/carts/` which DOES complete (200 on every run examined) because we are
      // sitting on the page while it resolves. It is also the LATEST state by construction — it happens
      // after every add — so it wins over anything an add step captured; no sequence comparison needed.
      //
      // Fail-soft: no read, or an unreadable body, leaves serverCartSkus as whatever the add steps
      // captured (usually null, given the aborts) and GATE 2 below decides what that means.
      if (readSkus) serverCartSkus = readSkus;

      // ── GATE 2: do we HAVE the server's cart for this run? ─────────────────────────────────────────
      // The bodies are ALREADY read and awaited — each inside the add step that produced it (see
      // withCartBodyCapture). There is deliberately nothing to await here: an await at this point is what
      // the 2026-07-30 red was, because by now the page has navigated several times and the bodies are
      // gone. The two failure texts stay distinct so a fire says which half broke, as meals2go's GATE-E does.
      // ★ The assertion below is UNCHANGED. It worked — it failed loudly with the true condition instead of
      //   passing on absent evidence. The read was fixed, not the gate.
      const serverSkus: string[] | null = serverCartSkus;
      // ★★ THREE STATES, THREE MESSAGES — and NEVER assert a shape change without having seen the shape.
      //    Each names a different next action: chase the request, chase the transport, or chase the
      //    contract. The old single message sent every reader after the third regardless.
      const noCartStateWhy = noCartStateReason({ readMatched, parseError, bodyKeys });
      expect(
        serverSkus,
        cartWriteSeen
          ? `verify-cart-4: cart write(s) fired but no server cart state is available for this run, so ` +
            `cart contents were not verified. MEASURED: ${noCartStateWhy}.`
          : `verify-cart-4: no cart write was observed during the add steps. MEASURED: no server cart ` +
            `state available for this run, so cart contents were not verified.`,
      ).toBeTruthy();

      // ── GATE 3: the LEDGER must be complete before it can be trusted ───────────────────────────────
      const unknown = expectedAdds.filter((a) => a.sku === null).map((a) => a.item);
      expect(
        unknown.length,
        `verify-cart-4: could not determine the SKU this run added for: ${unknown.join(', ')} — the product ` +
          `url carried no /shop/product/<sku> slug. MEASURED: the expectation is incomplete, so an identity ` +
          `check would be weaker than it looks; failing rather than asserting less.`,
      ).toBe(0);

      // ── GATE 4: IDENTITY — the added SKUs are present, and the cart holds nothing else ─────────────
      const expected = [...new Set(expectedAdds.map((a) => a.sku as string))];
      const actual = [...new Set(serverSkus as string[])];
      const label = (sku: string) => {
        const hit = expectedAdds.find((a) => a.sku === sku);
        return hit ? `${sku} (${hit.item})` : sku;
      };
      const missing = expected.filter((s) => !actual.includes(s));
      const extra = actual.filter((s) => !expected.includes(s));
      console.log(
        `[full-shop-flow] CART-IDENTITY added=[${expected.join(',')}] server=[${actual.join(',')}] ` +
          `missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
      );

      expect(
        missing.length,
        `verify-cart-4: the cart is MISSING ${missing.length} SKU(s) this run added: ` +
          `${missing.map(label).join(', ')}. MEASURED from the cart API: server cart = ` +
          `[${actual.join(', ')}] (${actual.length}); this run added [${expected.join(', ')}] ` +
          `(${expected.length}). Read the per-add step diags for which add did not commit.`,
      ).toBe(0);

      expect(
        extra.length,
        `verify-cart-4: the cart holds ${extra.length} SKU(s) this run did NOT add: ` +
          `${extra.join(', ')}. MEASURED from the cart API: server cart = [${actual.join(', ')}] ` +
          `(${actual.length}); this run added [${expected.join(', ')}] (${expected.length}). This run did ` +
          `not determine how they got there.`,
      ).toBe(0);

      // Set-size equality is implied by the two checks above; asserted explicitly so the invariant
      // ("exactly what this run added") is stated rather than inferred by a reader.
      expect(
        actual.length,
        `verify-cart-4: cart holds ${actual.length} distinct SKU(s), this run added ${expected.length}. ` +
          `MEASURED from the cart API: server cart = [${actual.join(', ')}]; added = [${expected.join(', ')}].`,
      ).toBe(expected.length);
    });

    // (No listener to remove here any more. The recorder is now scoped to a SINGLE add step by
    // withCartBodyCapture and detached in its own finally, so it cannot still be live at this point —
    // which also means the teardown clear's empty-cart response can never overwrite the evidence the
    // assertion above already used. The lifetime is structural rather than remembered.)

    // ---- STEP: checkout as PICKUP ------------------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'checkout-pickup', async () => {
      await page.getByRole('button', { name: /checkout|proceed to checkout/i }).or(page.getByRole('link', { name: /checkout/i })).filter({ visible: true }).first().click({ timeout: 5000 });
      await dismissInterstitials(page);
      // Select PICKUP (interaction). The pickup control's fulfillment BINDING is already asserted at
      // select-store-mckinley (readFulfillmentState); here we just click it to drive scheduling.
      const pickup = page.getByRole('button', { name: /pickup/i }).or(page.getByRole('radio', { name: /pickup/i })).or(page.getByText(/pick ?up/i)).filter({ visible: true }).first();
      if (await isVisibleSafe(pickup)) await pickup.click({ timeout: 5000 }).catch(() => {});
      await dismissInterstitials(page);
      // ★ HARDENED ASSERTION — prove the Checkout click ADVANCED past the cart to the scheduling step, via a
      // CHECKOUT-PAGE artifact that CANNOT be true otherwise. The OLD assertion (a /pick ?up/i text match)
      // lived in the PERSISTENT HEADER fulfillment toggle → it would pass even if the Checkout click never
      // advanced (the check-223 assert-chrome shape, in miniature). The pickup-timeslot container is a
      // scheduling-page artifact ABSENT on /cart and ABSENT from the header — and it is DOM-VERIFIED (the
      // next step, timeslots-render, asserts this exact selector and passes 30/30 over 7d). (The
      // authenticated /checkout DOM cannot be driven anonymously — it redirects to B2C — so the verified
      // timeslot container is the anchor; a "choose a time"/"schedule" heading is OR'd in as a bonus only,
      // it never gates the pass.)
      const scheduling = page
        .locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]')
        .or(page.getByRole('heading', { name: /choose a (pickup )?time|schedule (your )?(pickup|order)|select a (pickup )?time|reserve (a|your) time|when would you like/i }))
        .filter({ visible: true });
      await expect(
        scheduling.first(),
        'checkout-pickup: the Checkout click did NOT advance to the pickup scheduling step — no timeslot/scheduling artifact rendered. (A "Pickup" label alone lives in the persistent header toggle and is NOT proof the checkout advanced; the cart may be blocked or the checkout did not proceed.)',
      ).toBeVisible({ timeout: STEP_TIMEOUT });
    });

    // ---- STEP: timeslots render + selectable -------------------------------------------------------
    abortIfOverCap();
    await runStep(page, 'timeslots-render', async () => {
      const slots = page.locator('[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]').or(page.getByRole('button', { name: /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i })).filter({ visible: true });
      await expect(slots.first(), 'timeslots-render: no pickup timeslots rendered (verified-by-passing: 30/30 green over 7d; absent here means no pickup slots are available or the timeslot UI did not load).').toBeVisible({ timeout: STEP_TIMEOUT });
      const n = await countSafe(slots);
      expect(n, `timeslots-render: expected ≥1 selectable timeslot, saw ${n}`).toBeGreaterThanOrEqual(1);
    });

    // ---- STEP: select a slot (SAFE per Craig — no hold until order placement; NEVER place order) --------
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
  } finally {
    // ---- TEARDOWN (always runs — a dirty run poisons its own next run). Best-effort + guarded so it
    //      never throws; clear-cart THEN logout. No lock to release (option 3). --------------------------
    await clearCart(page).catch(() => {});
    await logout(page).catch(() => {});
    // (Removed the post-teardown FLOW-SUMMARY block — it ran an extra readCartCount + readFulfillmentState
    //  + a log line on EVERY run and backed NO assertion; per-step durations are already in run_steps and
    //  the trace. captureStepDiag still fires on the FAILING step for forensics.)
  }
});

/** ★ BANANAS result-selection guard. The "bananas" query returns BOOSTED/merchandised results — trace
 *  933812 saw 92928-Sweet-Cherries hijack the FIRST position, so a raw .first() added cherries. Return the
 *  search-result anchor that is an ACTUAL banana: prefer the exact product 92685 ("Bananas, Sold by the
 *  Each"), else the first result whose product NAME (slug after the id, or link text) STARTS with "Bananas"
 *  (the produce item) — while REJECTING flavored/merchandised look-alikes (Sweet Cherries, Banana Pudding,
 *  Banana Pepper, banana bread/chips/muffins, …). Throws LOUD if no banana is present — a silent .first()
 *  would add the wrong item (the original bug). Still returns a RESULT anchor to click (in-context nav). */
// ★ MERCHANDISER-BOOST REJECT — the union of seasonal/holiday/promo/off-category terms a merchandiser
//   boosts to the top of a staple query. This is the class that hijacked "bananas" (→ Sweet Cherries, #84)
//   and "bread" (→ a July-4th "Red, White & Blue" loaf, #100), and that WILL hijack "eggs" at Easter
//   (Cadbury creme eggs, chocolate eggs, dye kits, Peeps). A raw .first() falls for it; worse, a promo with
//   a WORKING buy-box adds SILENTLY — verify-cart-4 COUNTS items, not IDENTITY, so the run would pass with
//   candy in the cart (a false green). Extend this list as new merchandising patterns appear.
const MERCH_REJECT =
  /red.?white.?blue|patriotic|independence|memorial.?day|labor.?day|easter|cadbury|creme ?egg|peeps|dye.?kit|jelly.?bean|\bcandy\b|chocolate|\bcookie|\bcake\b|cupcake|dessert|pudding|egg.?nog|\bnog\b|pumpkin.?spice|gingerbread|peppermint|shamrock|st\.?.?patrick|valentine|christmas|hanukkah|halloween|thanksgiving|holiday|seasonal|limited.?edition|gift.?(set|basket|card)|\bbundle\b|scented|candle|\bsoap\b|shampoo|lotion|\bkit\b|flavored/i;

// ★ Per-staple guard config: REQUIRE the result IS the intended staple (slug + link text). Shared across
//   milk/eggs/bread; bananas keeps its own id-pinned guard (selectBananaResult) — do not fold it in here or
//   it loses the deterministic 92685 pin.
// ★ `id` PINS a stable, live-verified staple SKU (milk 55066, eggs 46155 — both confirmed #1 for their
//   query 2026-07-13), the deterministic path immune to merchandising boost/reorder (same shape as
//   selectBananaResult's 92685 pin). require/reject is the FALLBACK when the pinned SKU is gone (OOS /
//   discontinued) — and a fallback FIRE emits STAPLE-PIN-MISS so SKU churn is VISIBLE, not a silent regex
//   gamble on a rotting blocklist. bread has no single staple SKU, so it stays require/reject only.
const STAPLE_GUARDS: Record<string, { require: RegExp; reject: RegExp; id?: string }> = {
  milk: { id: '55066', require: /\bmilk\b/i, reject: MERCH_REJECT },
  eggs: { id: '46155', require: /\beggs?\b/i, reject: MERCH_REJECT },
  bread: {
    require: /bread|loaf|baguette|bagel|\brolls?\b|\bbuns?\b|ciabatta|\bpita\b|naan|sourdough|brioche|challah|focaccia|\brye\b|multigrain/i,
    reject: MERCH_REJECT,
  },
};

/** Generalized staple-search guard — the shared shape of selectBananaResult (#84) and selectBreadResult
 *  (#100), now id-PINNED (like bananas' 92685). PRIMARY: return the pinned SKU (opts.id) if present — a
 *  deterministic anchor immune to merchandising boost/reorder, and immune to blocklist rot (require:
 *  /\beggs?\b/i alone PASSES "Cadbury Creme Egg"; only the reject term saves it, and the landed-verify uses
 *  the SAME reject list, so a novel promo term defeats both halves at once — the id-pin sidesteps that
 *  entirely). FALLBACK: if the pinned SKU is absent (OOS / discontinued), pick the first result that IS the
 *  staple (`require`) and is NOT merchandised (`reject`), matched on slug + link text — AND emit a loud
 *  STAPLE-PIN-MISS diag so the SKU churn is VISIBLE (a silent fallback to a rotting blocklist is no better
 *  than the blocklist). Still a SEARCH-result click (in-context) — never a /shop/product/ direct nav (#83).
 *  Throws LOUD if no staple exists at all — never a silent .first(). The landed-PDP verify in the add step
 *  is the second half of the guard. */
async function selectStapleResult(page: Page, opts: { item: string; require: RegExp; reject: RegExp; id?: string }): Promise<Loc> {
  const anchors = page.locator('a[href*="/shop/product/"]').filter({ visible: true });
  // PRIMARY — the pinned SKU (deterministic, boost/rot-proof).
  if (opts.id) {
    const byId = page.locator(`a[href*="/shop/product/${opts.id}-"]`).filter({ visible: true }).first();
    if (await byId.isVisible({ timeout: STEP_TIMEOUT }).catch(() => false)) return byId;
  }
  // FALLBACK — the pin is absent; take the first require&&!reject result and make the miss LOUD.
  const n = await anchors.count();
  let firstSlug = '';
  for (let i = 0; i < n; i++) {
    const a = anchors.nth(i);
    const href = (await a.getAttribute('href').catch(() => '')) ?? '';
    const name = ((await a.textContent().catch(() => '')) ?? '').trim();
    const slug = href.split('/shop/product/')[1] ?? '';
    if (!firstSlug) firstSlug = slug;
    if (opts.require.test(`${slug} ${name}`) && !opts.reject.test(`${slug} ${name}`)) {
      if (opts.id) {
        // ★ SKU CHURN IS NOW VISIBLE. Mirror to page-console so it survives the sensitive monitor's
        //   redaction (page.evaluate(console.warn) → trace_signals.console; Node console.log is NOT traced).
        const miss = `[full-shop-flow] STAPLE-PIN-MISS ${opts.item} expected=${opts.id} took=${slug} — pinned SKU absent (OOS/discontinued); re-recon the ${opts.item} pin.`;
        console.log(miss);
        await page.evaluate((m) => console.warn(m), miss.slice(0, 195)).catch(() => {});
      }
      return a;
    }
  }
  throw new Error(
    `add-${opts.item}: no staple "${opts.item}" in the search results (pinned SKU ${opts.id ?? '(none)'} absent; ` +
      `first result was "${firstSlug || '(none)'}") — only boosted/merchandised look-alikes. The search boost ` +
      `changed; re-recon ${opts.item} selection.`,
  );
}

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

/** The cart-app MOUNT anchors — the two DOM states that prove we are looking at a RENDERED cart page
 *  rather than a page shell: the line-item list container, or the rendered empty-cart copy.
 *  ★ Deliberately NARROWER than captureStepDiag's `[class*="cart" i], [data-testid*="cart" i]`, which is
 *  an unscoped substring: it matches header cart chrome and any cart-named element, so its answer does
 *  not distinguish "the cart app mounted" from "something cart-ish is on the page" — in EITHER
 *  direction. (That diag probe is a forensic hint and stays as it is; it is not load-bearing. The
 *  2026-07-30 recon read `cartPresent:false` on the failing /cart page — evidence the app had not
 *  mounted, not evidence about this selector's precision.) */
const CART_LIST_SEL = '[class*="cart-item-list" i], [data-testid*="cart-item-list" i]';
const CART_EMPTY_RX = /your cart is empty|cart is empty|no items in your cart|start shopping|cart is currently empty/i;
/** How long cartResidual waits for ONE of the mount proofs to render before reporting UNKNOWN. Sized to
 *  the cart app's mount, not to a guess about hydration: the loop that calls this has already navigated
 *  and dismissed interstitials, so anything slower than this is a genuinely unhealthy cart page. */
const CART_PROOF_TIMEOUT_MS = 8_000;

/** Residual cart count for clearCart's empty-verify. Returns -1 when the state is UNKNOWN — the caller
 *  MUST NOT treat -1 as empty.
 *
 * ★ EMPTINESS REQUIRES A POSITIVE, MOUNTED-CART PROOF (2026-07-30). It used to be
 *   `const badge = await readCartCount(page); if (badge !== null) return badge;` — so an unwaited badge
 *   read of `0` was returned as a definitive count. readCartCount is a best-effort SYNCHRONOUS read
 *   (400ms innerText timeout, no hydration wait) of a CLIENT-rendered badge populated from cart state
 *   fetched after paint, so an early read can return the PRE-HYDRATION `0` on a cart that is not empty.
 *   Trusting that `0` is what let a broken/skipped clear look successful.
 *
 *   Now: a `0` is only believed when the cart app has demonstrably MOUNTED and says so — either the
 *   rendered empty-cart copy, or the line-item list container present with zero rows in it. A NON-ZERO
 *   badge is still trusted immediately: over-reporting a dirty cart only costs extra clearing work,
 *   whereas under-reporting is the failure this function exists to prevent. Asymmetric on purpose.
 *
 *   Two proofs rather than one so a copy change on either side cannot silently turn a genuinely-empty
 *   cart into UNKNOWN (which would red the monitor on a clean cart — the opposite false alarm). */
async function cartResidual(page: Page): Promise<number> {
  // A NON-ZERO badge is safe to trust: it can only cause MORE clearing work, never a false "empty".
  const badge = await readCartCount(page);
  if (badge !== null && badge > 0) return badge;

  // The line-item ROWS. ★ NOT `li[class*="item" i]`, which matches any nav <li> carrying the Tailwind
  // class `tw:items-center` ("items-center" contains "item"). And the `-list` container is EXCLUDED
  // because "cart-item-list" itself contains "cart-item" — the substring trap one level up.
  // This count only ever reports NON-emptiness (see below), so residual looseness here can cost extra
  // clearing work but can never manufacture a false "empty".
  const rows = page
    .locator(
      '[class*="cart-item" i]:not([class*="cart-item-list" i]), [data-testid*="cart-item" i]:not([data-testid*="cart-item-list" i])',
    )
    .filter({ visible: true });
  const emptyCopy = page.getByText(CART_EMPTY_RX).filter({ visible: true });
  const list = page.locator(CART_LIST_SEL).filter({ visible: true });

  // ★ ACTIVELY WAIT for one of the mount proofs to render, bounded — do not read once and guess. This is
  // the real hydration wait: it waits on the SIGNALS THAT MEAN SOMETHING (empty copy / list container /
  // a row) instead of on the clock, so it is sound where a fixed settle is not, and it uses the repo's
  // `waitFor` idiom rather than the fleet-banned page.waitForTimeout. A timeout here is not fatal — it
  // just means we fall through to the UNKNOWN return below, which the caller must not read as empty.
  await emptyCopy
    .or(list)
    .or(rows)
    .first()
    .waitFor({ state: 'visible', timeout: CART_PROOF_TIMEOUT_MS })
    .catch(() => {});

  // PROOF 1 — the rendered empty-cart copy. The site's own statement that there is nothing to clear.
  if (await isVisibleSafe(emptyCopy.first())) return 0;

  const rowCount = await countSafe(rows);
  if (rowCount > 0) return rowCount; // definitely non-empty

  // PROOF 2 — the list CONTAINER mounted with NO ELEMENT CHILDREN. Covers an empty-copy wording change:
  // the cart app is provably mounted and rendering nothing. Deliberately does NOT consult the badge — a
  // `0` from it is exactly the pre-hydration read that made this function untrustworthy.
  //
  // ★ Counts DOM children rather than "the row selector matched 0", on purpose. Keying emptiness off a
  //   selector miss would hand us a NEW fail-open: rename the row class and a full cart reads as empty.
  //   `children.length` cannot miss a row it does not have a selector for — so a full cart whose rows we
  //   fail to recognise falls through to UNKNOWN below, which is the safe direction.
  const listChildren = await list
    .first()
    .evaluate((el) => el.children.length)
    .catch(() => null);
  if (listChildren === 0) return 0;

  return -1; // UNKNOWN — no positive mounted-cart proof of emptiness; never reported as empty
}

// ── ★★ PLAYWRIGHT ACTION FAILURES: KEEP THE CALL LOG ────────────────────────────────────────────────
//
// ★ WHY THIS EXISTS. Playwright does not just say "click timed out" — it hands back an ACTIONABILITY CALL
// LOG inside `error.message` that names the exact reason, e.g.
//     locator.click: Timeout 4000ms exceeded.
//     Call log:
//       - locator resolved to <button class="… component--carts-empty-button …">…</button>
//       -   element is visible, enabled and stable
//       -   <a class="menu-link">Seafood</a> from <header role="banner"> subtree intercepts pointer events
//       - retrying click action  (x12)
// Every `.catch(() => false)` on a click in this file THREW THAT AWAY. Run 1145685 (2026-08-05) reported
// `failedAt=SERVER-PERSIST … cart NOT empty` — pointing a reader at the SERVER — when the truth was a CSS
// overlay: the site header covering the button. Recovering it cost an 8 MB trace download and parsing
// Playwright's internal `log` trace events. The engine had already computed the answer; we discarded it.
// (Same class as the Meals2Go fix in #127, but worse: that one blamed a sibling ELEMENT, this blamed a
// different SUBSYSTEM.)
//
// ★ CAUSE-FIRST ORDERING IS THE POINT, NOT PRETTINESS. The call log is ~12 near-identical retry cycles, so
// a naive head-truncation spends the budget on "retrying click action" and cuts off the one line that
// names the interceptor. These helpers DEDUPE (each distinct line once) and then sort CAUSE lines to the
// front, so whatever the cap is, the reason survives and only context is lost.
//
// ★ Structural only — element tags/classes/roles from Playwright's own log. No creds, token or PII (and
// the runner additionally scrubs error_message for a sensitive check).

/** ★ The lines that state the REASON an action could not proceed. Deliberately NARROW: an earlier version
 *  of this also matched `resolved to` and `element is …`, and those two — which are CONTEXT, and appear
 *  EARLIER in the log — crowded the interceptor line out of the budget entirely. Verified against the real
 *  6.3 KB error from run 1145685: with them in, "intercepts pointer events" did not survive either cap. */
const PW_CAUSE_RX =
  /intercepts pointer events|not stable|not enabled|not visible|not attached|outside of the viewport|element is not|did not receive/i;
/** Useful, but only AFTER the reason: what we aimed at, and the confirmation it looked fine. */
const PW_CONTEXT_RX = /resolved to|element is /i;

/** One call-log line, bounded — so a single enormous element dump cannot consume the whole budget and
 *  starve the lines after it.
 *
 *  ★★ ELIDES THE MIDDLE, NOT THE TAIL, AND THAT IS THE WHOLE POINT. Playwright writes the interception
 *  line as `<a …200 chars of Tailwind classes…> from <header …> subtree intercepts pointer events` — the
 *  identity is at the FRONT and the DIAGNOSIS is at the BACK, with junk between. Head-truncating it keeps
 *  the class list and throws away "intercepts pointer events", which is the only part that matters. (This
 *  is not hypothetical: the first version of this function did exactly that and the prove-can-fail run
 *  against the real 6.3 KB error from run 1145685 reported the phrase MISSING.) */
function pwLine(s: string, cap = 150): string {
  // ★ DROP THE TAILWIND UTILITY TOKENS FIRST. Wegmans' markup carries dozens of `tw:*` classes per element
  //   (`tw:hidden tw:lg:block tw:print:hidden tw:relative …`); they are pure layout noise, they sit BETWEEN
  //   the two things that identify an element (`component--carts-empty-button`, `component--site-header-
  //   desktop`), and at ~60% of every dump they are what pushes those names out of any budget. Measured on
  //   the real error: without this, neither the target's class nor the overlay's owner survived; with it,
  //   both do. Narrow and reversible — it removes one prefixed token class, nothing else.
  const t = s.replace(/\s*\btw:[^\s"']+/g, '').replace(/\s{2,}/g, ' ').replace(/class="\s*"/g, '').trim();
  if (t.length <= cap) return t;
  const head = Math.ceil((cap - 1) * 0.55);
  return `${t.slice(0, head)}…${t.slice(-(cap - 1 - head))}`;
}

/** Lines of a Playwright action error, deduped, ordered REASON → context → scaffolding. */
function actionLogLines(e: unknown): { headline: string; lines: string[] } {
  const raw = e instanceof Error ? e.message : String(e);
  const seen = new Set<string>();
  const all: string[] = [];
  for (const l of raw.split('\n')) {
    const t = l.replace(/^\s*-\s*/, '').trim();
    if (t && t !== 'Call log:' && !seen.has(t)) {
      seen.add(t);
      all.push(t);
    }
  }
  const headline = pwLine(all.shift() ?? 'unknown error');
  // ★ CLASSIFY ON THE FULL LINE, TRIM ONLY WHEN RENDERING. Testing a trimmed line is how the first version
  //   of this lost the interceptor twice over: the phrase it matches on had already been cut off.
  const cause = all.filter((l) => PW_CAUSE_RX.test(l));
  const context = all.filter((l) => !PW_CAUSE_RX.test(l) && PW_CONTEXT_RX.test(l));
  const rest = all.filter((l) => !PW_CAUSE_RX.test(l) && !PW_CONTEXT_RX.test(l));
  // ★ ORDER: first reason → what we aimed at → any FURTHER reasons → scaffolding.
  //   Not "all reasons first": Playwright often reports the same overlay twice (once per intercepting
  //   descendant), and two near-identical 150-char lines ate the whole budget, pushing out the
  //   `locator resolved to <button …>` line — i.e. WHAT was being clicked, which the next reader needs
  //   most when the anchor itself is under suspicion.
  return { headline, lines: [...cause.slice(0, 1), ...context, ...cause.slice(1), ...rest] };
}

/** The REASON only, for a breadcrumb line (clearStep caps the whole line at 195 chars — keep this short).
 *  Falls back to the headline when Playwright named no reason (e.g. a non-actionability error). */
function actionCause(e: unknown, cap = 120): string {
  const { headline, lines } = actionLogLines(e);
  return pwLine(lines.find((l) => PW_CAUSE_RX.test(l)) ?? headline, cap);
}

/** Headline + reason-first call log, for the thrown error_message (the operator-facing record). */
function actionFailure(e: unknown, cap = 460): string {
  const { headline, lines } = actionLogLines(e);
  const out: string[] = [headline];
  // Fill in reason-first order and STOP at the cap, rather than concatenating everything and cutting the
  // tail — so the budget is spent on whole, readable lines instead of half of one long one.
  for (const l of lines) {
    const next = pwLine(l);
    if (out.join(' | ').length + next.length + 3 > cap) break;
    out.push(next);
  }
  return out.join(' | ');
}

/** Best-effort dismiss the /cart cookie-consent banner ("Our website uses cookies… [Close]") that sits
 *  at the BOTTOM of the cart page and can intercept the ⋮ meatball click OR overlay the "Delete Items"
 *  confirm dialog. SCOPED to a cookie/consent container so it can NEVER dismiss the confirm modal itself
 *  (a generic page-wide "close" could). Prefers "Close" (the banner's actual control), then accept/got-it.
 *  Bounded, optional (no-op if absent), never throws. Returns a status the clear-cart telemetry logs:
 *  'absent' (no banner), 'dismissed' (banner present + close clicked), 'present(<why>)' (present but the
 *  close click FAILED — and now carrying Playwright's reason instead of just the bare word). */
async function dismissCookieBanner(page: Page): Promise<string> {
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
  // A banner we can SEE but cannot CLOSE is worth a reason: it is a prime suspect for intercepting the
  // very clicks this step goes on to make, and "present" alone never said whether the closer was
  // occluded, disabled or simply absent.
  let why = 'no-closer';
  const clicked = await btn
    .click({ timeout: 1500 })
    .then(() => true)
    .catch((e: unknown) => {
      why = actionCause(e, 90);
      return false;
    });
  return clicked ? 'dismissed' : `present(${why})`;
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
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const onWegmansApi = /(^|\.)wegmans\.(com|cloud)$/.test(host) || /wegapi|kitting/i.test(host);
  return onWegmansApi && /\/(cart|basket|line-?items?)/i.test(url) && (method === 'DELETE' || /empty|clear|delete/i.test(url)) && status < 500;
}

// ── ★★ WHICH SUB-STEP ACTUALLY FAILED ───────────────────────────────────────────────────────────────
//
// ★ THE BUG THIS REPLACES: `failedAt` was assigned BEFORE each sub-step and only overwritten by the
//   next one, so it recorded "the last sub-step REACHED", not the one that failed. Any run that got to
//   the end therefore reported FINAL-COUNT no matter what broke — and the SERVER-PERSIST promotion,
//   keyed on that, then blamed the API on runs where no click had ever landed (run 1145685).

/** Sub-steps whose FAIL is ADVISORY — recorded for the reader, but not a verdict on the run.
 *
 *  ★ NAV reports FAIL when the cart-app probe does not see a cart container, yet the flow proceeds and
 *    routinely succeeds anyway (observed repeatedly: `NAV FAIL … cartApp=n` immediately followed by
 *    `INITIAL-COUNT OK cart=4`). It is a hint about the landing, not proof of one — and a genuine
 *    navigation failure is NOT hidden by excluding it, because cartResidual then cannot read the cart
 *    and INITIAL-COUNT fails on the very next line. So a real nav break still names itself; only the
 *    false alarm is suppressed. Without this, "first FAIL" would answer NAV on nearly every failing
 *    run — trading one wrong-by-construction label for another. */
const ADVISORY_SUBSTEPS: ReadonlySet<string> = new Set(['NAV']);

/** Evidence that the CONFIRM click reached the server — the only basis on which SERVER-PERSIST is honest. */
export interface ConfirmEvidence {
  /** Cart-clear writes observed AFTER the confirm click specifically (clearWrites.slice(writesBeforeConfirm)). */
  postConfirmWrites: number;
  /** Whether the "Yes, delete items" click actually succeeded. */
  confirmClicked: boolean;
}

/**
 * The label for CLEAR-SUMMARY and the thrown error: the first NON-ADVISORY sub-step that failed,
 * promoted to SERVER-PERSIST only when the evidence for that claim exists.
 *
 * ★ BOTH HALVES OF THE PROMOTION ARE REQUIRED. It previously fired on `clearWrites.length > 0`, but
 *   clearWrites accumulates from an always-on page.on('response') for the WHOLE step — so a write from
 *   the add-to-cart phase, or from anything else touching a cart path, satisfied it. "The server took
 *   the delete and dropped it" is a specific accusation; it needs a write attributable to the confirm
 *   click (post-confirm slice) AND a confirm click that actually landed. Absent either, the honest
 *   label is FINAL-COUNT: the cart did not empty and we cannot say the server is at fault.
 */
export function classifyClearFailure(firstFail: string | null, ev: ConfirmEvidence): string {
  const label = firstFail ?? 'FINAL-COUNT';
  if (label !== 'FINAL-COUNT') return label; // something earlier broke — that is the answer, not the API
  return ev.postConfirmWrites > 0 && ev.confirmClicked ? 'SERVER-PERSIST' : 'FINAL-COUNT';
}

// ── ★★ THE "ALL DEPARTMENTS" MEGA-MENU — the thing that actually occludes the cart toolbar ──────────
//
// MEASURED on wegmans.com at the runner's exact 1280x720 viewport:
//   header[role=banner].component--site-header-desktop   sticky,   0 → 196,  z-index 1000
//   section.menu-region  (the flyout)                    absolute, 191 → 459, z-index 1200
// The flyout is `display:none` and ZERO-SIZE when collapsed, so it cannot intercept anything; it only
// occludes when OPEN, and the failing trace carried aria-expanded="true" x10. So the site header was
// never the problem — an open mega-menu was, and #131's `hitSelf` probe was measuring the symptom.
//
//   clear, clickable viewport band with the flyout OPEN:   460 → 720
//   clear, clickable viewport band with it CLOSED:         200 → 720
//
// ★ A REAL USER CAN CLICK "Empty My Cart" — they close the menu they opened, or scroll. This is a
//   MONITOR defect (we leave a menu open and click underneath it), NOT a wegmans.com UI defect. Closing
//   it is the same gesture a user makes, so it costs no fidelity: nothing here can manufacture a green.
//
// ★ MEASURED TOGGLES: Escape does NOT close it (the obvious wrong fix). Clicking the trigger again DOES.
//   It is NOT hover-triggered, so a stray mouse position is not the cause — something clicked it.
const MEGA_MENU_SEL = 'section.menu-region';
const MEGA_MENU_TRIGGER_SEL = 'li.component--site-header-all-departments-menu button';

/** State of the mega-menu for the breadcrumb: it was already shut / we shut it / it REFUSED to shut. */
type MegaMenuState = 'closed' | 'closed-by-us' | 'STILL-OPEN';

/**
 * Close the All Departments mega-menu if it is open, by CLICKING ITS OWN TRIGGER — the gesture a user
 * makes. Returns what happened, for the crumb.
 *
 * ★ NO BYPASS ON FAILURE, DELIBERATELY. If the menu will not close we return 'STILL-OPEN' and let the
 *   caller go on to click anyway: the click then fails on the real occlusion and #130 names the
 *   interceptor. Adding a dispatchEvent/force fallback here would convert "the button is genuinely
 *   covered" into a green, which is the one outcome this monitor must never produce.
 */
async function closeMegaMenu(page: Page): Promise<MegaMenuState> {
  const menu = page.locator(MEGA_MENU_SEL).first();
  const isOpen = (): Promise<boolean> =>
    menu.evaluate((el) => getComputedStyle(el).display !== 'none').catch(() => false);
  if (!(await isOpen())) return 'closed'; // absent or collapsed — nothing to do, and nothing to report
  await page.locator(MEGA_MENU_TRIGGER_SEL).first().click({ timeout: 3000 }).catch(() => {});
  // Deterministic settle on the menu actually going away (bounded), not a blind sleep.
  await menu.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  return (await isOpen()) ? 'STILL-OPEN' : 'closed-by-us';
}

/** Would a real click at this element's centre actually reach IT, or is something on top?
 *
 *  ★ The two coordinate-dispatching rungs of the ladder below (`raw-pointer`, `force`) do NOT hit-test:
 *  they aim at a point and let the browser route the event to whatever is topmost. That is fine when the
 *  element is clear and actively dangerous when it is not — on /cart the topmost element over the cart
 *  toolbar is a site-header category LINK, so an ungated rung navigates away mid-run. This is the guard
 *  those two rungs consult. Fail-CLOSED: an evaluate that throws (detached node) returns false, i.e. the
 *  rung is skipped rather than fired blind. */
async function hitTargetIsTrigger(loc: Loc): Promise<boolean> {
  return loc
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && (el === hit || el.contains(hit) || hit.contains(el));
    })
    .catch(() => false);
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
async function robustClickToOpen(
  page: Page,
  trigger: Loc,
  opened: Loc,
  armMs = 1800,
): Promise<{ via: string | null; why: string }> {
  const RUNG_CLICK_TIMEOUT = 2200;
  const t = trigger.first();
  const strategies: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'hydrate+locator',
      run: async () => {
        // (Removed a `waitForLoadState('networkidle', 1500)` settle here — the SAME never-can-fire pattern
        // #96 cut on the add path at :469/:1066: Wegmans holds persistent astutebot/emplifi/LaunchDarkly
        // sockets open, so networkidle never resolves and paid its full 1500ms on every menu-open. The
        // scrollIntoView + click below already auto-wait for actionability.)
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
        // ★ HIT-TARGET GUARD (see hitTargetIsTrigger). page.mouse dispatches at COORDINATES, so if an
        //   overlay covers the trigger this rung clicks the OVERLAY — silently, and reported as a rung
        //   that merely "didn't open the menu".
        if (!(await hitTargetIsTrigger(t))) throw new Error('raw-pointer: occluded — refusing to click through an overlay');
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
        // ★★ THE force HAZARD, CLOSED. `force: true` skips Playwright's hit-target CHECK — it does NOT
        //    stop the browser from hit-testing. The click is still a real mouse event at the trigger's
        //    coordinates, so when an overlay covers it the TOPMOST element receives it. On /cart that
        //    topmost element is <a href="/shop/categories/2957058">Seafood</a> in the site header — i.e.
        //    this rung's "robust" fallback would NAVIGATE THE RUN OFF THE CART PAGE, and everything
        //    downstream (count, empty, confirm) would then be measuring the wrong page. A fallback that
        //    silently leaves the page is worse than one that fails.
        //
        // ★ GATED, NOT DELETED. force exists for the real case it was added for: a React control that is
        //   genuinely under the cursor but whose actionability check Playwright will not satisfy (an
        //   animating ancestor, a never-"stable" element). That case still works. What is now refused is
        //   the one where force would click SOMETHING ELSE — which it could never have fixed anyway.
        if (!(await hitTargetIsTrigger(t))) throw new Error('force: occluded — refusing to force-click through an overlay');
        await t.click({ force: true, timeout: RUNG_CLICK_TIMEOUT });
      },
    },
  ];
  // ★ RUNG FAILURES ARE RECORDED, NOT DISCARDED. The old `catch { /* fall through */ }` meant a total
  //   ladder failure reported only `via=NONE` — five strategies had each been told exactly why they
  //   failed (occluded / no bbox / not stable) and every one of those answers was dropped. On success
  //   `why` is unused, so a working ladder costs nothing; it only speaks when the ladder loses.
  const rungWhy: string[] = [];
  for (const s of strategies) {
    try {
      await s.run();
    } catch (e: unknown) {
      rungWhy.push(`${s.name}:${actionCause(e, 70)}`);
    }
    if (await appearsWithin(opened, armMs)) return { via: s.name, why: '' };
  }
  return { via: null, why: rungWhy.join(' ; ').slice(0, 300) };
}

/** Teardown / baseline — clear the cart via the cart page's NATIVE "Empty My Cart" BULK action (⋮ menu),
 *  NOT a per-item Remove loop. Recon (trace 934649 + Craig's cart-page screenshot): the prior per-item
 *  remove loop fired ZERO removal requests — its /^remove$/ button selector never matched the real cart's
 *  remove control, so nothing cleared and the previous session's items PERSISTED and accumulated (cart hit 5
 *  → verify-cart-4 failed). The /cart page has a MEATBALL menu (⋮, top-right of "My Cart") that opens a
 *  dropdown (Print / Share / Add to Saved Lists / Empty My Cart); "Empty My Cart" (trash icon) is a SINGLE
 *  bulk clear — one action, exactly how a user empties the cart. Flow: dismiss cookie banner → open ⋮
 *  ROBUSTLY → VERIFY the menu opened ("Empty My Cart" visible) → click "Empty My Cart" → confirm "Yes,
 *  delete items" → VERIFY the cart is DURABLY 0 via cartResidual, which demands a POSITIVE mounted-cart
 *  proof of emptiness (never a bare header-badge `0` — that can be a pre-hydration render). One retry,
 *  then a loud STEP-FAIL with the residual count — NEVER a silent pass.
 *
 *  ★ 2026-07-30: this function is reached on EVERY call now, including the baseline. The old badge-only
 *  short-circuit made baseline-clear-cart 359 pass / 0 fail — see the BADGE-HINT block below for why an
 *  unwaited `0` is not evidence, and scripts/check-clear-cart-gate.mjs for the invariants CI holds.
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
      // ★ Assigned ONCE, at the end, from classifyClearFailure — never accumulated as we go. It used to be
      //   set BEFORE each sub-step, which recorded the last sub-step REACHED rather than the one that
      //   failed; every run that got to the end therefore said FINAL-COUNT. `firstFail` (below) is now the
      //   only input, and it is captured by `crumb` from the result it actually emits.
      let failedAt = 'unknown';
      // ★ Playwright's OWN reason for a failed click, kept instead of discarded (see actionLogLines).
      //   `…Why` (short) goes in the breadcrumb line; `…Full` (headline + cause-first call log) is appended
      //   to the thrown error_message, which is what runs.error_message and the alert actually show.
      let emptyClickWhy = '';
      let emptyClickFull = '';
      // Mega-menu state at the empty-click — 'closed' until we look (see closeMegaMenu).
      let megaMenu: MegaMenuState = 'closed';
      let confirmClickWhy = '';
      let confirmClickFull = '';
      const crumbs: string[] = []; // accumulate the CLEAR-STEP lines → thrown error_message carries the breadcrumb
      // ★ THE FIRST NON-ADVISORY SUB-STEP THAT REPORTED FAIL — captured HERE, in the same call that emits
      //   the result, so the label can never drift from what the breadcrumb says (the old `failedAt = 'X'`
      //   assignments were a parallel bookkeeping that recorded arrival, not outcome). Never overwritten:
      //   the first real break is what explains the run; later FAILs are its consequences.
      let firstFail: string | null = null;
      const crumb = async (sub: string, result: string, detail = '') => {
        if (result === 'FAIL' && firstFail === null && !ADVISORY_SUBSTEPS.has(sub)) firstFail = sub;
        crumbs.push(await clearStep(page, label, sub, result, detail));
      };
      // Evidence for the SERVER-PERSIST claim, accumulated at the confirm/delete sub-steps (see
      // classifyClearFailure). Defaults say "no evidence", so the label cannot be claimed by accident.
      let confirmClickedEver = false;
      let postConfirmWrites = 0;

      // ── ★ BADGE-HINT (was: BADGE-FIRST SHORT-CIRCUIT) ─────────────────────────────────────────────
      // This used to SHORT-CIRCUIT the whole step: read the header cart badge on the CURRENT page and, on a
      // hard `0`, log `SUMMARY OK badge-empty` and return — no /cart navigation, no clear, no verification.
      //
      // ★ THAT MADE THE STEP UNABLE TO FAIL. Over the 7 days to 2026-07-30, baseline-clear-cart was
      //   359 pass / 0 fail — it has NEVER failed — averaging 966ms against the teardown's 52s, because it
      //   almost always took this path and asserted nothing. readCartCount is a best-effort SYNCHRONOUS
      //   read (400ms innerText timeout, NO hydration wait) of a CLIENT-rendered badge populated from cart
      //   state fetched after paint. Read on an arbitrary page (here: straight after select-store), a `0`
      //   can be the PRE-HYDRATION initial render of a cart that is not empty. A step that cannot fail
      //   protects nothing, and this was the last way cart residue could survive silently into a run.
      //
      // ★ WHY NOT "just wait for the badge to hydrate": there is no trustworthy hydration signal HERE.
      //   A fixed settle is banned fleet-wide (page.waitForTimeout — see b2c-login-test.spec.ts) and would
      //   be unsound anyway: polling a value that reads `0` both before and after hydration cannot tell the
      //   two apart, so a slow hydration still yields a confident wrong answer. The signals that CAN prove
      //   emptiness (the rendered empty-cart copy; the mounted line-item list) only exist ON /cart — which
      //   is exactly where the loop below already goes, and where it already has a verified already-empty
      //   fast exit (INITIAL-COUNT → `before === 0` → SUMMARY OK already-empty, skipping the ceremony).
      //
      // So the badge is now a logged HINT and never a decision: we ALWAYS fall through to the verified
      // nav+clear loop. Cost is one /cart navigation (~9s) on a 600s run cap; in exchange the step can
      // fail, and "empty" is always something we proved rather than something we assumed. A non-zero hint
      // is still worth recording — it tells the breadcrumb reader the cart was dirty before we navigated.
      const headerBadge = await readCartCount(page).catch(() => null);
      await crumb(
        'BADGE-HINT',
        'SKIP',
        `header badge=${headerBadge ?? '?'} (hint only — NOT proof of emptiness; verifying on /cart)`,
      );

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const tag = `attempt=${attempt + 1}`;

        // ── SUB-STEP 1: NAV — navigate to the cart page + log the URL we actually landed on ──────────────
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
          await crumb('SUMMARY', 'OK', `${tag} already-empty initial=${initialCount} final=0`);
          return;
        }

        // ── SUB-STEP 2: COOKIE-BANNER — present? dismissed? (can intercept the ⋮ click / overlay the dialog) ──
        const cookie = await dismissCookieBanner(page);
        await crumb('COOKIE-BANNER', 'OK', `${tag} state=${cookie}`);

        // The "Empty My Cart" dropdown item — the SUCCESS PROBE for "the menu opened" AND the click target.
        // Trace 935321: when the menu is CLOSED this renders 0x, so its visibility is the reliable menu-open
        // signal (the menu items only exist inside the OPEN dropdown).
        // ★★ THE SEMANTIC CLASS, NOT A 4-WAY NAME CHAIN. Trace of run 1145685 shows what the old
        //    .or(menuitem).or(button).or(link).or(getByText) chain actually resolved to:
        //      <button class="component--base-button component--carts-empty-button …">
        //    — a purpose-built control with its own class. The name chain was four ways of guessing at
        //    something the markup states outright, and its last rung (getByText) could only ever match a
        //    text node, which is visible but not clickable.
        //
        // ★★ :not([aria-disabled="true"]) IS LOAD-BEARING — DO NOT "SIMPLIFY" IT AWAY.
        //    A SECOND rendering of the SAME class exists in this DOM, disabled:
        //      <button aria-disabled="true" class="… component--carts-empty-button … is-disabled …">
        //    alongside disabled "Share My Cart" / "Add to My Saved Lists" siblings. Nothing in the old
        //    locator pinned which one resolved. That is exactly the failure this fleet already ate on
        //    Meals2Go (#129): a VISIBLE but DISABLED control matched first, satisfied every visibility
        //    probe, and then timed out on click because Playwright waits for "enabled" forever. Here it
        //    is latent rather than firing — pin it before it does.
        //    ★ aria-disabled, not :disabled — this is an ARIA-disabled button, not a native disabled one,
        //      so the CSS :disabled pseudo-class does NOT match it.
        const emptyItem = page
          .locator('button.component--carts-empty-button:not([aria-disabled="true"])')
          .filter({ visible: true })
          .first();

        // ── SUB-STEP 4: MEATBALL-FOUND — is the ⋮ "cart actions" button located + visible? ────────────────
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
        let openedVia: string | null = null;
        let openWhy = ''; // ★ why the LADDER lost, when it does — was `via=NONE` and nothing else
        for (let openTry = 0; openTry < 3 && openedVia === null; openTry++) {
          if (!(await meatball.isVisible({ timeout: 4000 }).catch(() => false))) {
            await dismissInterstitials(page); // meatball not found this round — clear overlays, re-probe
            await dismissCookieBanner(page);
            continue;
          }
          const opened = await robustClickToOpen(page, meatball, emptyItem, 1800);
          openedVia = opened.via;
          if (opened.via === null) openWhy = opened.why;
        }
        const menuOpen = openedVia !== null && (await isVisibleSafe(emptyItem));
        await crumb(
          'MENU-OPEN',
          menuOpen ? 'OK' : 'FAIL',
          `${tag} menuOpen=${menuOpen ? 'y' : 'n'} via=${openedVia ?? 'NONE'}${openWhy ? ` why=${openWhy}` : ''}`,
        );

        if (menuOpen) {
          // ── SUB-STEP 6: EMPTY-CLICKED — click "Empty My Cart" (the trash-icon dropdown item). ───────────
          // ★★ THE ONE THAT COST A TRACE DOWNLOAD. This click's error carried
          //    "<a class='menu-link'>Seafood</a> from <header role='banner'> subtree intercepts pointer
          //    events" after 12 retries — the whole answer — and `.catch(() => false)` dropped it, leaving
          //    `clicked=n`. The run then reported failedAt=SERVER-PERSIST, sending the reader at the API.
          //    ★ TOLERANCE UNCHANGED: a click that errors but whose effect still lands (the confirm dialog
          //      appears) still passes — DIALOG-APPEARED remains the gate. Only the DIAGNOSIS improves.
          // ★★ CLOSE THE MEGA-MENU FIRST — the actual remedy (see MEGA_MENU_SEL for the measurements).
          //    The occluder is section.menu-region, not the header, and it only occludes while OPEN.
          //    Clicking its own trigger shut is what a user does; if it refuses, we still click and fail
          //    honestly rather than reaching for a bypass.
          megaMenu = await closeMegaMenu(page);

          // ★ SCROLL WITH block:'end', NOT 'center' — AND DO NOT "IMPROVE" THIS BACK TO CENTER.
          //   At 1280x720 the occluded band is 191→459 with the flyout open, 0→196 with it shut.
          //   block:'center' aims at viewport y ~360 — INSIDE the open-flyout band, i.e. centring targets
          //   the one position where the button is guaranteed to be covered. That is why #131's centring
          //   did nothing. 'end' parks it near the viewport bottom instead, in the clear band.
          //
          // ★★ BUT THIS IS THE SECONDARY, NOT THE FIX — and it does NOT rescue a mega-menu that refused to
          //    close. MEASURED (prove-can-fail): with the flyout open and the button near the top of the
          //    document, block:'end' clamps at scrollY=0 exactly like 'center' did and the click still
          //    times out. Scrolling only helps when there is content ABOVE the button to scroll through.
          //    ★ closeMegaMenu is what makes the click land: "close, no scroll at all" was measured
          //      SUFFICIENT on its own. This line is belt-and-braces for the case where the page happens
          //      to be scrolled down; it earns its keep cheaply and claims nothing more than that.
          await emptyItem.evaluate((el) => el.scrollIntoView({ block: 'end' })).catch(() => {});
          // ★ MEASURE WHETHER THAT WORKED, don't assume it. One elementFromPoint at the button's centre
          //   says whether WE are what a click would hit. This is the difference between the next run
          //   answering "is the overlay viewport-anchored or in document flow?" and it costing another
          //   trace download — the open question this fix rests on (see the PR).
          const hitIsSelf = await emptyItem
            .evaluate((el) => {
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return hit !== null && (el === hit || el.contains(hit));
            })
            .catch(() => null);
          const emptyClicked = await emptyItem
            .click({ timeout: 4000 })
            .then(() => true)
            .catch((e: unknown) => {
              emptyClickWhy = actionCause(e);
              emptyClickFull = actionFailure(e);
              return false;
            });
          // ★ DELIBERATELY NO broad dismissInterstitials() here (#91). It clicks ANY visible close/dismiss/
          //   continue button and can CLOSE the "Delete Items" confirm dialog before we click "Yes, delete
          //   items" — a prime suspect for "menu opens but cart stays 5" (the confirm auto-dismissed). The
          //   only overlay that legitimately needs clearing between the empty-click and the confirm is the
          //   cookie banner, handled by the SCOPED dismissCookieBanner in SUB-STEP 7 below.
          await crumb(
            'EMPTY-CLICKED',
            emptyClicked ? 'OK' : 'FAIL',
            // ★ megaMenu= says whether the remedy actually fired: `closed` (nothing to do), `closed-by-us`
            //   (we shut it — the intended path), or `STILL-OPEN` (it refused, and the click below was
            //   made into a known occlusion). One glance at the crumb now answers "did the close work?"
            //   instead of it costing a trace download, which is the whole lesson of #130.
            `${tag} clicked=${emptyClicked ? 'y' : 'n'} megaMenu=${megaMenu} ` +
              `hitSelf=${hitIsSelf === null ? '?' : hitIsSelf ? 'y' : 'n'}${emptyClickWhy ? ` why=${emptyClickWhy}` : ''}`,
          );

          // ── SUB-STEP 7: DIALOG-APPEARED — did the "Delete Items" confirm dialog render? Live screenshots:
          //    title "Delete Items", PRIMARY button EXACTLY "Yes, delete items" (red), secondary "Cancel".
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

          // ★ DIALOG-VANISHED probe (#91): the confirm button rendered but is GONE after the (scoped,
          //   cookie-only) dismiss above — some overlay-dismissal closed the dialog before we could confirm.
          //   Surfaced explicitly so one fire rules dismiss-closes-dialog in or out for good.
          const dialogSurvived = confirmShown ? await isVisibleSafe(confirmBtn) : false;
          if (confirmShown && !dialogSurvived) {
            await crumb('DIALOG-VANISHED', 'FAIL', `${tag} confirm-btn-gone-after-cookie-dismiss`);
          }

          if (dialogSurvived) {
            // ── SUB-STEP 8: CONFIRM-CLICKED — click "Yes, delete items". ─────────────────────────────────
            const writesBeforeConfirm = clearWrites.length;
            // ★ Arm the clear-write wait BEFORE the confirm click (#91) so a fast server response can't land
            //   between the click and a later waitForResponse arm. (The always-on onClearResp listener still
            //   records every write; this promise is only the bounded wait for one to arrive.)
            const delRespPromise = page
              .waitForResponse((r) => isCartClearWrite(r.request().method(), r.url(), r.status()), { timeout: 6000 })
              .catch(() => null);
            // ★ Same treatment as EMPTY-CLICKED, and for the same reason: DELETE-FIRED below reports
            //   "writes=0", which reads as an API/handler problem even when the truth is that the confirm
            //   button was never successfully clicked. Tolerance unchanged — DELETE-FIRED is still the gate.
            const confirmClicked = await confirmBtn
              .click({ timeout: 4000 })
              .then(() => true)
              .catch((e: unknown) => {
                confirmClickWhy = actionCause(e);
                confirmClickFull = actionFailure(e);
                return false;
              });
            await dismissInterstitials(page); // safe now — the confirm has been clicked / dialog actioned
            await crumb(
              'CONFIRM-CLICKED',
              confirmClicked ? 'OK' : 'FAIL',
              `${tag} clicked=${confirmClicked ? 'y' : 'n'}${confirmClickWhy ? ` why=${confirmClickWhy}` : ''}`,
            );

            // ── SUB-STEP 9: DELETE-FIRED — did a cart-clear/delete NETWORK write fire after the confirm? ──
            //    The wait was armed before the click; read what the listener saw once it settles.
            await delRespPromise;
            const fired = clearWrites.slice(writesBeforeConfirm);
            // ★ The SERVER-PERSIST evidence, captured where it is actually known: writes attributable to
            //   THIS confirm click (not the whole step), and whether the click landed at all.
            confirmClickedEver = confirmClickedEver || confirmClicked;
            postConfirmWrites += fired.length;
            const lastWrite = fired[fired.length - 1];
            await crumb(
              'DELETE-FIRED',
              fired.length ? 'OK' : 'FAIL',
              `${tag} writes=${fired.length}${lastWrite ? ` last=${lastWrite.method}:${lastWrite.status}:${lastWrite.path}` : ''}`,
            );
          }
        }

        // ── SUB-STEP 10: FINAL-COUNT / VERIFY — FRESH nav + cartResidual, which requires a POSITIVE
        //    mounted-cart proof of emptiness (rendered empty copy, or the list container with no children).
        //    NOT the header badge on its own: a `0` from that can be a pre-hydration render. ────────────
        await page.goto(CART_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await dismissInterstitials(page);
        remaining = await cartResidual(page);
        await crumb('FINAL-COUNT', remaining === 0 ? 'OK' : 'FAIL', `${tag} before=${before} remaining=${remaining}`);
        if (remaining === 0) {
          await crumb('SUMMARY', 'OK', `${tag} initial=${initialCount} final=0`);
          return; // durably empty
        }
      }
      // Still non-empty (or unknown) after the retry → loud STEP-FAIL. The CLEAR-SUMMARY names the exact
      // failing sub-step; the breadcrumb (every CLEAR-STEP line) is folded into the thrown error_message so
      // the persisted failure trace pinpoints WHERE the clear broke (nav / cookie / meatball / menu-open /
      // empty-click / dialog / confirm / delete-fired / final-count) with initial=N final=M — no more guessing.
      // ★ SERVER-PERSIST classification (#91): every client sub-step succeeded AND a write attributable to
      //   the CONFIRM CLICK fired, yet the count held — the server accepted the delete but didn't persist
      //   it (a different bug class than any client-side break; route the fix at the API, not the UI flow).
      //   Both halves are now required — see classifyClearFailure for why `clearWrites.length > 0` alone
      //   let a write from the add-to-cart phase award this label to a run where no click ever landed.
      failedAt = classifyClearFailure(firstFail, { postConfirmWrites, confirmClicked: confirmClickedEver });
      // ★★ THE CLICK REASON OUTRANKS THE SUB-STEP LABEL. Run 1145685 reported `failedAt=SERVER-PERSIST`
      //    — "the server accepted the delete but didn't persist it" — while a click had in fact never
      //    landed because the site header was over the button. A label describes WHERE the flow stopped;
      //    this describes WHY, and when both exist the WHY is what the operator needs first, so it is
      //    appended to the thrown message rather than left in the trace for someone to go dig out.
      const clickWhy = [
        emptyClickFull ? `EMPTY-CLICK: ${emptyClickFull}` : '',
        confirmClickFull ? `CONFIRM-CLICK: ${confirmClickFull}` : '',
      ]
        .filter(Boolean)
        .join(' ;; ');
      const summary = await clearStep(page, label, 'SUMMARY', 'FAIL', `failedAt=${failedAt} initial=${initialCount} final=${remaining} attempts=${MAX_ATTEMPTS}`);
      const d = await captureStepDiag(page, label).catch(() => ({ full: '', compact: '' }));
      console.log(`[full-shop-flow] STEP-FAIL ${label} DIAG ${d.full}`);
      if (d.compact) await page.evaluate((m) => console.warn(m), d.compact).catch(() => {});
      throw new Error(
        `${d.compact} :: ${summary} :: BREADCRUMB=[ ${crumbs.join(' | ')} ] :: ${label}: cart NOT empty ` +
          `(residual=${remaining}) after ${MAX_ATTEMPTS} "Empty My Cart" attempts — failing sub-step: ${failedAt}.` +
          // Placed LAST so it is the final thing read, and prefixed so it cannot be mistaken for the label.
          (clickWhy ? ` ★ A CLICK NEVER LANDED — Playwright's reason (outranks the sub-step label above): ${clickWhy}` : ''),
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
