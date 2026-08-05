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
 */
/** origin+pathname only — the part a NAVIGATION changes. Query/hash churn and a reload are not
 *  navigations for our purposes, and a cookie-accept that reloads must not be mistaken for one. */
function navKey(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

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
  // ★ Where we started. A dismisser must never move the page — see the exit guard below.
  const startedAt = navKey(page.url());
  let lastClicked: string | null = null;

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
        lastClicked = (await el.textContent({ timeout: 500 }).catch(() => null))?.trim().slice(0, 40) ?? '(unnamed)';
        await el.click({ timeout: 2000 });
        break; // one genuine dismissal per candidate is enough
        // ★ THIS break IS UNCONDITIONAL, and must stay so. An earlier draft of this change made it
        //   conditional on "did the page move?", which quietly turned the loop into "click EVERY
        //   visible match for this candidate" — widening the click surface in the very change whose
        //   purpose is to narrow it. The navigation check belongs AFTER the inner loop (below), where
        //   it stops the OUTER candidate walk without adding clicks.
      } catch {
        // best-effort; ignore
      }
    }
    if (navKey(page.url()) !== startedAt) break; // stop clicking things on a page we did not choose
  }

  // ★★ THE GUARD — A SILENT NAVIGATION IS WORSE THAN A LOUD REFUSAL. This helper exists to clear
  //    nuisance overlays; moving the page is never a correct outcome for it. If it happens, every
  //    assertion after the call would be measuring a different page, and the failure would surface
  //    somewhere unrelated — which is exactly what cost two separate diagnoses (the mega-menu in the
  //    clear-cart occlusion, and verify-cart-4 reporting url=/shop/categories).
  //    ★ Compared on origin+pathname, so a reload or a query/hash change does NOT trip it — only a
  //      real move. Throwing is deliberate: the caller's step fails HERE, naming the control, instead
  //      of an assertion failing later against the wrong page.
  const endedAt = navKey(page.url());
  if (endedAt !== startedAt) {
    throw new Error(
      `dismissInterstitials NAVIGATED the page — it must only dismiss overlays, never move. ` +
        `Clicked ${lastClicked === null ? 'an unidentified control' : `"${lastClicked}"`}; ` +
        `${startedAt} -> ${endedAt}. Every assertion after this call would have run on a page the ` +
        `flow did not choose. Narrow the candidate that matched, or exclude this control.`,
    );
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
