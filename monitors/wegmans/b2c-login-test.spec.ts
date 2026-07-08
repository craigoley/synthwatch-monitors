import { test, expect, step, dismissInterstitials, type Page } from '../../lib/flow';

/**
 * Monitor: wegmans-b2c-login-test  —  ★ InfoSec ON-DEMAND TEST INSTRUMENT (ships DISABLED) ★
 *
 * WHAT THIS IS: a real monitors-as-code spec (registered in the manifest, sensitive=true), NOT a
 * scratch probe. It lets InfoSec fire an on-demand login attempt from the sanctioned, allowlisted
 * egress to test whether the Akamai B2C bot policy now admits the monitor's traffic and the login
 * COMPLETES. Craig fires it on-demand (enabledByDefault:false); it is not wired to a cron.
 *
 * ★★ LOAD-BEARING GROUND TRUTH (from Craig's InfoSec conversation) ★★
 * InfoSec allowlisted the 3 ACA egress IPs (20.85.72.149 / 172.169.169.109 / 20.80.135.196)
 * CONDITIONALLY: an egress IP is trusted ONLY when its traffic also carries the Vercel bypass header.
 * They reuse that header as the DISCRIMINATOR to separate this monitor's traffic from other traffic on
 * the same public egress — AT THE AKAMAI LAYER, not just Vercel. So:
 *   allowlisted IP + header present  = past the bot wall (Akamai admits it)
 *   header absent / wrong IP         = bot-challenged
 * The header is therefore a PRECONDITION for a valid login test, and it MUST ride the navigation TOWARD
 * B2C (myaccount.wegmans.com), not only the wegmans.com initial load — the prior probe blocked at the
 * navigation toward B2C.
 *
 * ★★ THE RUNNER GAP THIS SPEC COMPENSATES FOR (flag in the PR) ★★
 * The runner injects x-vercel-protection-bypass PER-REQUEST, host-scoped to runner/vercelBypass.ts's
 * PROTECTED_BYPASS_HOSTS = { www.wegmans.com, wegmans.com, www.meals2go.com, meals2go.com }. That set
 * DOES NOT include myaccount.wegmans.com — so the runner does NOT put the header on the B2C navigation,
 * which is exactly where InfoSec's discriminator must apply. This spec fills the gap: it registers a
 * route SCOPED TO THE B2C HOST ONLY and adds the header there, reading the SAME secret the runner uses
 * (VERCEL_BYPASS_TOKEN). This respects vercelBypass.ts's anti-leak invariant (host-scoped, per-request,
 * NEVER context-wide extraHTTPHeaders that would spray the token to third-party subresources). The
 * runner still covers www.wegmans.com; this spec covers only myaccount.wegmans.com — no overlap. The
 * clean long-term fix is to add myaccount.wegmans.com to PROTECTED_BYPASS_HOSTS in the runner.
 *
 * ★ VALIDITY GATE FIRST: before classifying the login outcome, this spec confirms the header ACTUALLY
 * APPLIED on the B2C navigation (its own route handler sets bypassAppliedToB2C when it adds the header
 * to a myaccount.wegmans.com request). A run is a VALID login test only if the header rode through;
 * otherwise the result is INCONCLUSIVE_HEADER_DROPPED (our bug — fix the injection, not InfoSec's
 * problem). This distinguishes "blocked because the header didn't apply" from "blocked DESPITE the
 * header applying" (the latter is InfoSec-actionable: their allowlist rule / IP isn't matching).
 *
 * ★ THE OUTCOME IS THE SIGNAL — this spec CLASSIFIES (it does not just pass/fail):
 *   (a) COMPLETED                   — authenticated: a token-acquisition network event AND a post-login
 *                                     DOM anchor on wegmans.com. The EXPECTED happy path now that the
 *                                     allowlist+header is live. GREEN.
 *   (b) OTP_GATED                   — past the bot wall, hit the B2C ...WithPhoneVerification OTP step.
 *                                     ★ The LIKELY real gate now; decides cron-feasibility (below). RED.
 *   (c) BOT_BLOCKED                 — Akamai challenge fired DESPITE header+allowlisted IP. ★ ACTIONABLE
 *                                     FAILURE: reports the block evidence + header-applied=true + the
 *                                     observed egress IP (vs the allowlist), so InfoSec can tell whether
 *                                     their rule is matching. RED.
 *   (d) INCONCLUSIVE_HEADER_DROPPED — the header did NOT apply on the B2C navigation (token unset, or
 *                                     the route did not ride the nav). OUR bug, not InfoSec's. RED.
 *   (e) OTHER                       — creds rejected / selector drift / timeout. RED.
 * Only (a) passes GREEN. A wrong-password secret lands in (e) creds-rejected, never in (a) — must-go-red
 * holds; header-dropped and bot-blocked are reported outcomes, never silent passes.
 *
 * ★ CREDENTIALS — from runner env SECRETS, never in git/logs. Browser specs run in the runner process
 * and read process.env.<NAME> directly (checks.auth is NOT applied to browser contexts — executeBrowser
 * makes a bare newContext; there is no per-check secret-injection path for browser today, so creds come
 * via runner env at on-demand run time). Craig sets B2C_TEST_USER / B2C_TEST_PASS (and VERCEL_BYPASS_
 * TOKEN) as ACA-job secrets before firing. Values go only to page.fill / the scoped route header —
 * NEVER console.log'd, NEVER placed in a URL. sensitive=true + redact_patterns (manifest) scrub
 * Bearer/JWT/B2C-session values from persisted trace_signals; the built-in token denylist applies too.
 *
 * ★ FEASIBILITY / CRON FUTURE (InfoSec's to settle via the on-demand runs — NOT resolved here): the B2C
 * policy is B2C_1A_...WithPhoneVerification. IF OTP fires on EVERY login, this can never be a green-when-
 * healthy CRON monitor (an unattended runner cannot satisfy a phone OTP) — but it stays a valid on-demand
 * instrument. IF OTP does NOT fire for the test account, the path to a real cron login health monitor
 * opens. The COMPLETED-vs-OTP_GATED split is exactly what tells InfoSec which future is viable. No cron
 * wiring here.
 *
 * SELECTORS: the B2C form ids (#signInName / #password / SelfAsserted submit) are Azure AD B2C defaults;
 * the wegmans.com sign-in affordance is matched resiliently (role/text).
 */

const BYPASS_HEADER = 'x-vercel-protection-bypass';
/** The B2C host the discriminator header must ride (the runner does NOT cover this host — see header). */
const B2C_HOST = 'myaccount.wegmans.com';
/** The 3 ACA egress IPs InfoSec allowlisted (conditional on the header). Used to annotate a BOT_BLOCK. */
const ALLOWLISTED_EGRESS_IPS = new Set(['20.85.72.149', '172.169.169.109', '20.80.135.196']);

/** Read a required runner secret; throws a clear, value-free error if unset. The value is NEVER logged. */
function requireSecret(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[b2c-login-test] required secret env "${name}" is not set on the runner — set it as an ACA-job ` +
        `secret before firing this on-demand instrument (never hard-code credentials).`,
    );
  }
  return v;
}

/** host + pathname ONLY — drops query/fragment where B2C tokens (code/id_token) live, so evidence is
 *  safe to log. Never pass a full URL to a log. */
function safeLoc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable-url)';
  }
}

/** Akamai bot-block evidence: a 403/429 on the auth host, or an AkamaiGHost-served error. Keyed on
 *  status + host + the `server` header — NEVER the sensor payload. */
function isAkamaiBlock(status: number, url: string, serverHeader: string): boolean {
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    host = '';
  }
  const onAuthHost = /(^|\.)(wegmans\.com|b2clogin\.com)$/.test(host);
  if (/akamai/i.test(serverHeader) && status >= 400) return true;
  if (onAuthHost && (status === 403 || status === 429)) return true;
  return false;
}

/** A B2C token-acquisition network event: the B2C token endpoint (200), a redirect back to a wegmans
 *  host carrying an auth code/id_token, or the SelfAsserted "confirmed" step. We only INSPECT r.url();
 *  we never log its query. */
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

/** Best-effort observed egress IP (for annotating a BOT_BLOCK so InfoSec can check their allowlist).
 *  Plain-text echo; guarded; returns null on any failure. Not intercepted by the B2C-scoped route. */
async function observeEgressIp(page: Page): Promise<string | null> {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const resp = await page.request.get(url, { timeout: 8000 });
      if (resp.ok()) {
        const ip = (await resp.text()).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
      }
    } catch {
      /* try the next echo */
    }
  }
  return null;
}

type Loc = ReturnType<Page['locator']>;

/** Navigation-chrome labels that are UI text (NOT account PII) — safe to emit verbatim in the redacted
 *  diagnostic. A logged-in affordance the anchor regex missed usually shows as one of these, which is
 *  exactly what a future token-but-no-anchor OTHER needs to pinpoint the correct selector. */
const SAFE_LABEL_ALLOWLIST = new Set([
  'account', 'my account', 'your account', 'my wegmans', 'rewards', 'my rewards',
  'sign out', 'log out', 'logout', 'sign in', 'log in', 'login', 'register',
  'orders', 'my orders', 'order history', 'profile', 'my profile', 'settings',
  'cart', 'shopping list', 'shopping lists', 'lists', 'shop', 'help', 'home',
  'menu', 'search', 'store', 'stores', 'my store', 'checkout', 'favorites', 'reorder',
]);

/** Redact a control's label for the diagnostic. Greetings carry the account holder's name (PII the runner
 *  redactor does NOT scrub — its declared patterns are token/session-only), so they are masked; known nav
 *  labels pass through (UI chrome, not PII); anything else is structurally marked. Keeps the capture within
 *  the audit-#219 invariant: DOM structure + URL + selector names, never account values. */
function safeLabel(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n || n.length > 40) return n ? '‹control›' : '';
  if (/^(hi|hello|hey|welcome|greetings|good (morning|afternoon|evening))\b/i.test(n)) return '‹greeting›';
  return SAFE_LABEL_ALLOWLIST.has(n.toLowerCase()) ? n : '‹control›';
}

/** Best-effort visibility / count probes that never throw (bounded) — for the diagnostic capture. */
async function isVisibleSafe(loc: Loc): Promise<boolean> {
  try { return await loc.first().isVisible({ timeout: 1000 }); } catch { return false; }
}
async function countSafe(loc: Loc): Promise<number> {
  try { return await loc.count(); } catch { return -1; }
}
async function collectLabels(loc: Loc, scanCap: number, out: string[]): Promise<void> {
  const n = Math.min(await loc.count().catch(() => 0), scanCap);
  for (let i = 0; i < n && out.length < 12; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const label = safeLabel(await el.innerText({ timeout: 200 }).catch(() => ''));
    if (label && !out.includes(label)) out.push(label);
  }
}

/**
 * ★ TELEMETRY (token-but-no-anchor OTHER; run #915736 was un-adjudicable without this): capture a
 * REDACTION-SAFE structural diagnostic so a future run self-diagnoses stale-selector (cause 1: login worked,
 * the anchor selector is wrong) vs real abort (cause 2: post-token redirect/interstitial/partial session) —
 * WITHOUT a trace zip, which a sensitive monitor never persists (the runner skips the failure zip + the
 * screenshot for sensitive; only redacted trace_signals/console survive). Everything captured is structure +
 * URL host/path + static selector strings + PII-filtered nav labels — NO page.content(), no input values, no
 * token values. Safe BY CONSTRUCTION; the runner redactor is the backstop. Emitted as one JSON console line →
 * lands in trace_signals.console (redacted).
 */
async function captureTokenNoAnchorDiag(page: Page, tokenEventLoc: string, anchorDesc: string): Promise<string> {
  const control = (rx: RegExp) => page.getByRole('link', { name: rx }).or(page.getByRole('button', { name: rx }));

  // PII-safe discriminators (booleans + host/path only):
  const signInFormPresent = await isVisibleSafe(page.locator('#signInName, #password'));
  const b2cErrorPresent = await isVisibleSafe(page.locator('.error.itemLevel, #claimVerificationServerError, .error.pageLevel'));
  const otpPresent = await isVisibleSafe(page.locator('#otpCode, input[id*="otp" i], #phoneVerificationControl'));
  const accountAffordance = await isVisibleSafe(control(/account|profile|orders|my wegmans|rewards|sign ?out|log ?out|hello|welcome/i));
  const navRegionPresent = await isVisibleSafe(page.getByRole('navigation'));
  const counts = {
    links: await countSafe(page.getByRole('link')),
    buttons: await countSafe(page.getByRole('button')),
    forms: await countSafe(page.locator('form')),
    inputs: await countSafe(page.locator('input')),
  };
  // The visible top-of-page control labels (PII-filtered) — a logged-in affordance the anchor regex missed
  // (cause 1) usually surfaces here as a known nav label, telling the responder the RIGHT selector to use.
  const visibleControls: string[] = [];
  await collectLabels(page.getByRole('link'), 16, visibleControls).catch(() => {});
  await collectLabels(page.getByRole('button'), 16, visibleControls).catch(() => {});

  const likelyCause =
    signInFormPresent || b2cErrorPresent
      ? 'cause-2 (bounced to sign-in / B2C error → real partial-login, a genuine finding)'
      : accountAffordance
        ? 'cause-1 (logged-in chrome present under a different label → stale anchor selector, a spec fix)'
        : 'undetermined (no sign-in form, no error, no recognized account affordance — read finalUrl + visibleControls)';

  return JSON.stringify({
    situation: 'token-but-no-anchor',
    finalUrl: safeLoc(page.url()),
    tokenEvent: tokenEventLoc,
    anchorsTried: [anchorDesc],
    found: { signInFormPresent, b2cErrorPresent, otpPresent, accountAffordance, navRegionPresent, counts, visibleControls },
    likelyCause,
  });
}

type Code = 'COMPLETED' | 'OTP_GATED' | 'BOT_BLOCKED' | 'INCONCLUSIVE_HEADER_DROPPED' | 'OTHER';
type Verdict = { code: Code; detail: string; diag?: string };

/** A promise that never resolves — a losing branch in Promise.race (so a per-branch timeout does not
 *  win the race with a false negative; the timeoutSentinel is the sole guaranteed resolver). */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * Classify the outcome after the sign-in submit. Races the terminal signals; the first REAL match wins,
 * and a predicate-that-never-matches waitForResponse provides the guaranteed budget timeout (no
 * page.waitForTimeout — banned fleet-wide). Success requires BOTH a token event and a post-login anchor,
 * so it can never false-green. BOT_BLOCKED / OTP / creds-rejected typically arrive before a success
 * token event, so real-time arrival order gives the right priority.
 */
async function classify(page: Page, budgetMs: number): Promise<Verdict> {
  const blockByNetwork = page
    .waitForResponse((r) => isAkamaiBlock(r.status(), r.url(), r.headers()['server'] ?? ''), { timeout: budgetMs })
    .then((r): Verdict => ({ code: 'BOT_BLOCKED', detail: `akamai deny ${r.status()} on ${safeLoc(r.url())}` }))
    .catch(() => never<Verdict>());
  const blockByDom = page
    .getByText(/access denied|pardon the interruption|reference #|unusual traffic|verify you are (a )?human|don'?t have permission/i)
    .first()
    .waitFor({ state: 'visible', timeout: budgetMs })
    .then((): Verdict => ({ code: 'BOT_BLOCKED', detail: 'akamai/challenge interstitial rendered (access-denied text)' }))
    .catch(() => never<Verdict>());

  const completed = page
    .waitForResponse((r) => isTokenEvent(r.status(), r.url()), { timeout: budgetMs })
    .then(async (tokenResp): Promise<Verdict> => {
      const tokenEventLoc = safeLoc(tokenResp.url());
      const anchorDesc = 'link|button name~/sign out|log out|my account|account|hi,/i';
      const anchor = page
        .getByRole('link', { name: /sign ?out|log ?out|my account/i })
        .or(page.getByRole('button', { name: /sign ?out|log ?out|account|hi,? /i }))
        .first();
      try {
        await anchor.waitFor({ state: 'visible', timeout: 15_000 });
        return { code: 'COMPLETED', detail: 'token acquired + authenticated DOM anchor on wegmans.com' };
      } catch {
        // ★ Token acquired but the anchor never rendered — the token-but-no-anchor OTHER (run #915736).
        // Capture a redaction-safe structural diagnostic so this is self-diagnosing next time.
        const diag = await captureTokenNoAnchorDiag(page, tokenEventLoc, anchorDesc).catch(() => '');
        return {
          code: 'OTHER',
          detail: 'token event observed but no post-login anchor rendered (partial/aborted login)',
          diag,
        };
      }
    })
    .catch(() => never<Verdict>());

  const otp = page
    .locator('#otpCode, input[id*="otp" i], #phoneVerificationControl, [id*="phoneVerification" i]')
    .or(page.getByText(/verification code|we (sent|texted) you|enter the code|didn'?t get (a|the) code|verify your (phone|identity)/i))
    .first()
    .waitFor({ state: 'visible', timeout: budgetMs })
    .then((): Verdict => ({ code: 'OTP_GATED', detail: 'reached B2C ...WithPhoneVerification OTP/phone step (bot wall cleared)' }))
    .catch(() => never<Verdict>());

  const credsRejected = page
    .locator('.error.itemLevel, #claimVerificationServerError, .error.pageLevel')
    .or(page.getByText(/incorrect|invalid (username|password)|isn'?t right|we can'?t seem to find|doesn'?t match|please try again/i))
    .first()
    .waitFor({ state: 'visible', timeout: budgetMs })
    .then((): Verdict => ({ code: 'OTHER', detail: 'credentials rejected — B2C sign-in error shown (not authenticated)' }))
    .catch(() => never<Verdict>());

  const timeoutSentinel = page
    .waitForResponse(() => false, { timeout: budgetMs })
    .then((): Verdict => ({ code: 'OTHER', detail: 'timeout' }))
    .catch((): Verdict => ({ code: 'OTHER', detail: `no terminal signal within ${Math.round(budgetMs / 1000)}s (timeout)` }));

  return Promise.race([blockByNetwork, blockByDom, completed, otp, credsRejected, timeoutSentinel]);
}

test('Wegmans B2C login — InfoSec on-demand unblock test', async ({ page }) => {
  // Creds up front → a missing secret fails fast + value-free (never logged).
  const username = requireSecret('B2C_TEST_USER');
  const password = requireSecret('B2C_TEST_PASS');
  // The discriminator token (same secret the runner uses). May be unset → the validity gate reports
  // INCONCLUSIVE_HEADER_DROPPED rather than silently running an invalid test.
  const bypassToken = process.env.VERCEL_BYPASS_TOKEN;

  // ★ Fill the runner gap: inject the discriminator header on the B2C host ONLY (host-scoped, per-
  // request — respects vercelBypass.ts's anti-leak invariant). The runner covers www.wegmans.com; this
  // covers myaccount.wegmans.com, which PROTECTED_BYPASS_HOSTS omits. Scoped route (NOT catch-all).
  let b2cRequestSeen = false;
  let bypassAppliedToB2C = false;
  await page.route(`https://${B2C_HOST}/**`, async (route) => {
    b2cRequestSeen = true;
    const req = route.request();
    if (bypassToken) {
      bypassAppliedToB2C = true;
      await route.continue({ headers: { ...req.headers(), [BYPASS_HEADER]: bypassToken } });
    } else {
      await route.continue();
    }
  });

  let verdict: Verdict = { code: 'OTHER', detail: 'flow did not reach classification' };

  // ---- STEP 1: load wegmans.com (runner injects the Vercel bypass header for THIS host) ----------
  await step('open wegmans.com', async () => {
    await page.goto('https://www.wegmans.com', { waitUntil: 'domcontentloaded' });
    await dismissInterstitials(page);
  });

  // ---- STEP 2: navigate to the B2C sign-in — form appears OR we get blocked ----------------------
  const reachedForm = await step('navigate to B2C sign-in (Akamai gate)', async () => {
    const signIn = page
      .getByRole('link', { name: /sign ?in|log ?in/i })
      .or(page.getByRole('button', { name: /sign ?in|log ?in/i }))
      .filter({ visible: true })
      .first();
    try {
      if (await signIn.isVisible({ timeout: 8000 })) await signIn.click({ timeout: 5000 });
    } catch {
      const acct = page.getByRole('button', { name: /account|my account|hi,? /i }).first();
      try {
        await acct.click({ timeout: 4000 });
        await page
          .getByRole('menuitem', { name: /sign ?in|log ?in/i })
          .or(page.getByRole('link', { name: /sign ?in|log ?in/i }))
          .first()
          .click({ timeout: 4000 });
      } catch {
        /* best-effort — the outcome logic below reports if the form is unreachable */
      }
    }
    await dismissInterstitials(page);

    const formVisible = page
      .locator('#signInName')
      .first()
      .waitFor({ state: 'visible', timeout: 25_000 })
      .then(() => 'FORM' as const)
      .catch(() => never<'FORM'>());
    const blockedEarly = page
      .waitForResponse((r) => isAkamaiBlock(r.status(), r.url(), r.headers()['server'] ?? ''), { timeout: 25_000 })
      .then(() => 'BLOCK' as const)
      .catch(() => never<'BLOCK'>());
    const budget = page
      .waitForResponse(() => false, { timeout: 25_000 })
      .then(() => 'TIMEOUT' as const)
      .catch(() => 'TIMEOUT' as const);

    return Promise.race([formVisible, blockedEarly, budget]);
  });

  // ---- STEP 3: ★ VALIDITY GATE FIRST — did the discriminator header ride the B2C navigation? ------
  // A run is a valid login test ONLY if the header applied on the B2C host. Resolve the invalid cases
  // (header dropped) BEFORE interpreting any bot-block as InfoSec-actionable.
  const headerValidOnB2C = bypassAppliedToB2C; // set by our scoped route when it added the header
  await step('validity gate: discriminator header applied on B2C nav', async () => {
    if (!bypassToken) {
      verdict = {
        code: 'INCONCLUSIVE_HEADER_DROPPED',
        detail:
          'VERCEL_BYPASS_TOKEN is not set on the runner — the discriminator header could not be applied, ' +
          'so this is NOT a valid login test (fix: set the secret). Not an InfoSec/Akamai result.',
      };
      return;
    }
    if (b2cRequestSeen && !headerValidOnB2C) {
      verdict = {
        code: 'INCONCLUSIVE_HEADER_DROPPED',
        detail:
          `A request to ${B2C_HOST} was made but the bypass header did not attach (spec route did not ` +
          `add it) — our injection bug, not an InfoSec result.`,
      };
      return;
    }
    // else: either the header applied on a B2C request (valid), or no B2C request happened yet (handled
    // by the outcome resolution below). Nothing to short-circuit.
  });

  // If the validity gate already produced a terminal INCONCLUSIVE verdict, skip classification.
  const alreadyInconclusive = verdict.code === 'INCONCLUSIVE_HEADER_DROPPED';

  if (!alreadyInconclusive) {
    if (reachedForm === 'BLOCK') {
      // Blocked on the way to / at the B2C host. Actionable ONLY if the header validly applied.
      verdict = headerValidOnB2C
        ? { code: 'BOT_BLOCKED', detail: 'Akamai blocked the navigation toward B2C DESPITE the discriminator header applying.' }
        : b2cRequestSeen
          ? { code: 'INCONCLUSIVE_HEADER_DROPPED', detail: 'Blocked at B2C but the header did not attach — our injection bug.' }
          : { code: 'BOT_BLOCKED', detail: 'Blocked before any B2C request was observed (header validity on B2C could not be confirmed).' };
    } else if (reachedForm === 'TIMEOUT') {
      verdict = {
        code: 'OTHER',
        detail: 'B2C sign-in form (#signInName) never appeared and no Akamai deny was observed (selector drift or silent challenge).',
      };
    } else {
      // FORM reached (past the wall). Submit, then classify the login outcome.
      await step('submit B2C credentials', async () => {
        await page.locator('#signInName').first().fill(username);
        await page.locator('#password').first().fill(password);
        const submit = page
          .locator('#next, #continue')
          .or(page.getByRole('button', { name: /sign ?in|log ?in|continue|next/i }))
          .filter({ visible: true })
          .first();
        await expect(submit, 'STEP 3: B2C SelfAsserted submit button not found on the sign-in form.').toBeVisible({ timeout: 10_000 });
        await submit.click({ timeout: 5000 });
      });

      await step('classify outcome', async () => {
        verdict = await classify(page, 45_000);
      });
    }
  }

  // ---- Enrich a BOT_BLOCKED with header-applied + observed egress IP (InfoSec-actionable context) --
  if (verdict.code === 'BOT_BLOCKED') {
    const ip = await observeEgressIp(page);
    const ipNote = ip
      ? `observed egress IP ${ip} is ${ALLOWLISTED_EGRESS_IPS.has(ip) ? 'IN' : 'NOT IN'} the InfoSec allowlist`
      : 'observed egress IP: unavailable';
    verdict = {
      code: 'BOT_BLOCKED',
      detail: `${verdict.detail} [header-applied-on-B2C=${headerValidOnB2C}; ${ipNote}]`,
    };
  }

  // ---- Report: non-secret verdict to the console (survives trace_signals redaction; labels are not
  //      secrets), GREEN only on COMPLETED. All other outcomes go RED with the classification. --------
  console.log(`[b2c-login-test] OUTCOME=${verdict.code} :: ${verdict.detail}`);

  // ★ Token-but-no-anchor OTHER: emit the redaction-safe structural diagnostic (finalUrl, token-event
  //   host/path, anchors tried, and what rendered instead) as its own line → trace_signals.console
  //   (runner-redacted). Closes the telemetry gap that made run #915736 un-adjudicable (stale selector
  //   vs real abort). All fields are structure / host+path / PII-filtered labels — no secret values.
  if (verdict.diag) {
    console.log(`[b2c-login-test] OTHER-DIAG ${verdict.diag}`);
  }

  if (verdict.code !== 'COMPLETED') {
    throw new Error(
      `[b2c-login-test] OUTCOME=${verdict.code} — ${verdict.detail}. ` +
        `(GREEN only when the login COMPLETES. BOT_BLOCKED = Akamai still blocking DESPITE the ` +
        `header+allowlist — actionable for InfoSec; OTP_GATED = wall cleared, OTP-gated; ` +
        `INCONCLUSIVE_HEADER_DROPPED = our injection bug, not a valid test; OTHER = see detail.)`,
    );
  }
  expect(verdict.code, 'expected COMPLETED (authenticated) outcome').toBe('COMPLETED');
});
