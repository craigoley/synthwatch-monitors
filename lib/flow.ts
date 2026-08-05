import { test, expect, type Page } from '@playwright/test';

/**
 * SynthWatch flow conventions.
 *
 * A monitor script is a standard Playwright test file. SynthWatch's runner
 * executes it and maps each `test.step(...)` to a run_step (the funnel you see
 * in the dashboard: "failed at step: search"). So WRAP every meaningful action
 * in test.step with a clear name.
 *
 * Why these helpers exist: real production sites change their DOM constantly.
 * Brittle CSS-path selectors break on the next deploy and page you for a
 * "monitoring outage" that is really just the site changing. Prefer role/text
 * based locators (getByRole/getByText) and assert on STABLE signals (URL
 * patterns, key visible text), not exact DOM structure. The AI root-cause
 * classifier will label such breaks "selector-drift" (the monitor needs
 * updating) vs "real-outage" (the site is down) -- both are useful, but resilient
 * selectors keep the false "outage" rate low.
 */

/** Re-export so scripts import everything from one place. */
export { test, expect, type Page };

/**
 * A named step. Thin wrapper over test.step so every script reads the same and
 * the runner's run_step funnel is well-labelled. Keep step names short + action-
 * oriented: 'search', 'open product', 'assert loaded'.
 */
export async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  return test.step(name, body);
}

// Parity: the block between the >>> and <<< markers below is VENDORED into the runner's
// specfetch/specShim.ts (the copy the runner EXECUTES); this lib/flow.ts is the AUTHORING copy and is
// DEAD AT RUNTIME (the runner esbuild-aliases the spec's lib/flow import to specShim). The runner's CI
// (scripts/check-libflow-parity.mjs) hashes this exact block — a change here FAILS runner CI until it
// is mirrored into specShim.ts and its LIBFLOW-VENDOR-SHA is bumped. KEEP IN SYNC.
// >>> SHARED-WITH-RUNNER-SPECSHIM
/**
 * Assert a page "loaded" using STABLE signals rather than DOM structure:
 *  - the URL matches an expected pattern (e.g. a product/recipe URL shape), and
 *  - a key piece of visible text is present (e.g. the product/recipe title).
 * Pass either or both. Throws (fails the monitor) if the expectation isn't met.
 */
export async function assertLoaded(
  page: Page,
  opts: { urlPattern?: RegExp; visibleText?: string | RegExp; timeoutMs?: number },
): Promise<void> {
  const timeout = opts.timeoutMs ?? 15000;
  if (opts.urlPattern) {
    await expect(page).toHaveURL(opts.urlPattern, { timeout });
  }
  if (opts.visibleText) {
    // Visible-text assertion is resilient to DOM restructuring: we don't care
    // WHERE the text is, only that the user would see it.
    await expect(page.getByText(opts.visibleText).first()).toBeVisible({ timeout });
  }
}

/**
 * Selector for FLOW-DRIVEN modals that a spec opens and drives itself (e.g. the
 * meals2go fulfillment/store-selection modal). dismissInterstitials must NEVER
 * click a button inside one of these or whose class marks it as that modal's
 * close affordance -- doing so closes the very modal the flow needs and the flow
 * falls through against an empty page (observed: meals2go trace 847996, where the
 * generic /^close$/ matcher clicked .store-modal-close-button).
 *
 * This is intentionally SCOPED: cookie/newsletter/consent banners are NOT flow
 * modals, so they are still dismissed. If a new spec drives its own modal, add
 * its container/close-class here rather than loosening the dismiss matchers.
 */
const FLOW_MODAL_EXCLUDE_SELECTOR =
  'app-fulfillment-type-change, app-modal-form, [role="dialog"].weg-modal-outer';
const FLOW_MODAL_EXCLUDE_CLASSES = ['store-modal-close-button'];

/** True if `el` belongs to a flow-driven modal the spec controls itself. */
async function isInsideFlowModal(el: import('@playwright/test').Locator): Promise<boolean> {
  try {
    return await el.evaluate(
      (node, { sel, classes }) => {
        const e = node as Element;
        if (e.closest(sel)) return true;
        return classes.some((c) => e.classList.contains(c));
      },
      { sel: FLOW_MODAL_EXCLUDE_SELECTOR, classes: FLOW_MODAL_EXCLUDE_CLASSES },
    );
  } catch {
    // If we can't introspect (detached, etc.), be conservative and do NOT skip:
    // a missed flow modal is rare; not dismissing a real nuisance popup is worse.
    return false;
  }
}

/**
 * Dismiss the common interstitials production e-comm sites throw up (cookie
 * banners, location/store pickers, newsletter modals) that otherwise intercept
 * clicks. Best-effort: never fails the flow if a given interstitial isn't
 * present. Add site-specific dismissals here as flows discover them.
 *
 * IMPORTANT: skips any candidate inside a FLOW-DRIVEN modal (see
 * FLOW_MODAL_EXCLUDE_SELECTOR) so it never closes a modal a spec is actively
 * driving. Iterates real matches (not just .first()) so a flow-modal close
 * button never shadows a genuine nuisance-popup button of the same name.
 *
 * ★★ DO NOT ADD A "THIS MUST NOT NAVIGATE" GUARD HERE. One was added and REVERTED the same day; it
 *    took three green checks down (355 login, 77 twice) within one tick of shipping.
 *
 *    WHY IT CANNOT WORK IN THAT FORM: a guard comparing the URL before/after cannot distinguish
 *      (a) a control IT clicked navigating, from
 *      (b) a navigation ALREADY IN FLIGHT completing while it was looking,
 *    and (b) is COMMON — every deliberate click that kicks off an async route change or an OAuth
 *    redirect near a dismissInterstitials call trips it. Observed, all on etag 083d854d:
 *      • 355 login  "Clicked an unidentified control; wegmans.com/ -> myaccount.wegmans.com/.../authorize"
 *                   — the spec clicked Sign In itself; the B2C redirect landed during this call.
 *      • 77         "Clicked an unidentified control; /recipes/search -> /recipes/main-dishes/..."
 *                   — a recipe-tile click the spec had already issued.
 *    "Clicked an unidentified control" is the guard ADMITTING it had no click to attribute — it was
 *    reporting a navigation it did not cause.
 *
 *    AND ATTRIBUTION ALONE IS NOT ENOUGH. The third failure was
 *      • 77         'Clicked "Close"; wegmans.com/ -> wegmans.com/recipes'
 *    a genuinely self-navigating control this helper DID click — but the spec's very next step is
 *    /recipes, so the navigation was WANTED. A correct guard would have to attribute the navigation
 *    to a click it issued AND know whether the flow wanted it, and only the caller knows the second.
 *
 *    ★ A fixed settle does not rescue it either (and is banned fleet-wide): waiting WIDENS the window
 *      in which an unrelated redirect can land, making misattribution more likely, not less.
 *
 *    What actually removed the known cause is the ANCHORED /^continue$/i candidate below — the loose
 *    /continue/i was clicking Wegmans' "Continue Shopping". Keep that. If a self-navigating control is
 *    found again, exclude it by NAME here; do not re-add a global URL guard.
 */

export async function dismissInterstitials(page: Page): Promise<void> {
  const candidates: Array<{ role: 'button'; name: RegExp }> = [
    { role: 'button', name: /accept( all)?( cookies)?/i },
    { role: 'button', name: /^(close|no thanks|not now|dismiss)$/i },
    // ★★ ANCHORED (was /continue/i). An interstitial's button is named exactly "Continue"; an
    //    UNANCHORED match also hits every app control whose label merely CONTAINS the word — and
    //    Wegmans' /cart carries `<button class="…component--cart-continue-shopping-button…">Continue
    //    Shopping</button>`, 4 of 6 instances not xl:hidden, so one is visible at 1280x720 and was
    //    being clicked. That NAVIGATED the run off /cart (a Next.js client-side route change — no
    //    document request, which is why it never showed up in the network trace), and every assertion
    //    after the call then ran on a page the flow did not choose. Candidate 2 was already anchored;
    //    this one being loose was the inconsistency, and the bug. "Continue to checkout" would have
    //    been the next one.
    { role: 'button', name: /^continue$/i },
  ];
  for (const c of candidates) {
    const matches = page.getByRole(c.role, { name: c.name });
    let count = 0;
    try {
      count = await matches.count();
    } catch {
      continue;
    }
    for (let i = 0; i < count; i++) {
      const el = matches.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 1000 }))) continue;
        // Never dismiss a button the active flow is driving (e.g. the meals2go
        // fulfillment modal's close button) -- that would close it on the flow.
        if (await isInsideFlowModal(el)) continue;
        await el.click({ timeout: 2000 });
        break; // one genuine dismissal per candidate is enough
        // ★ THIS break IS UNCONDITIONAL, and must stay so. A draft of the (now-reverted) navigation
        //   guard made it conditional on "did the page move?", which quietly turned the loop into
        //   "click EVERY visible match for this candidate" — widening the click surface in the very
        //   change whose purpose was to narrow it.
      } catch {
        // best-effort; ignore
      }
    }
  }
}

/**
 * Per-monitor LOGIN CREDENTIAL accessor (model B). A spec reads `credential('username')` instead of hardcoding
 * a secret; the check's `login_credentials` stores { role -> ENCRYPTED VALUE } — an operator sets the plaintext
 * in the dashboard Credentials panel and the api encrypts it under CRED_ENC_KEY. At RUN time the runner DECRYPTS
 * it and publishes the plaintext as process.env[SW_CRED_<ROLE>] for the life of this run (cleared after — see
 * runner/loginCredentials.ts). There is NO operator env-var step: the runner derives SW_CRED_<ROLE> itself.
 * Fail-CLOSED: an unset/undecryptable role throws, so a mis-configured login monitor fails loudly instead of
 * submitting an empty credential.
 * ★ SANDBOX: a preview/sandbox run NEVER receives SW_CRED_* (they don't cross the sandbox env boundary, by
 *   design — runner/sandbox/sandboxEnv.ts), so credential() cannot resolve in a preview regardless of how the
 *   check is configured. It is a LIVE-run accessor; the error below detects the sandbox and says so.
 * IN THE PARITY-HASHED BLOCK on purpose — a security-relevant, spec-reachable accessor whose authoring
 * (synthwatch-monitors lib/flow.ts) and runtime (specShim) copies must never silently drift. The env-var
 * format `SW_CRED_<ROLE>` must stay in lockstep with runner/loginCredentials.ts credentialEnvKey.
 */
export function credential(role: string): string {
  const value = process.env[`SW_CRED_${role.toUpperCase()}`];
  if (value === undefined || value.length === 0) {
    // Message-only branch (the THROW condition is unchanged): the sandbox sets SW_SANDBOX=1 and never receives
    // SW_CRED_*, so a credential()-based spec can't resolve in a preview — say that specifically instead of
    // sending the operator to a (model-A) runner env-var step that model B does not use.
    const inSandbox = process.env.SW_SANDBOX === '1';
    throw new Error(
      inSandbox
        ? `credential("${role}") is not available in a preview/sandbox run — the sandbox never receives ` +
            `SW_CRED_* (secrets do not cross the sandbox boundary, by design), so a credential()-based spec ` +
            `cannot resolve here no matter how the check is configured. Test it with a LIVE run.`
        : `credential("${role}") is not available — set login_credentials.${role} on this check via the ` +
            `dashboard Credentials panel (check detail page). The runner publishes SW_CRED_${role.toUpperCase()} ` +
            `automatically from the stored, encrypted value at run time; there is no runner env-var step.`,
    );
  }
  return value;
}
// <<< SHARED-WITH-RUNNER-SPECSHIM
