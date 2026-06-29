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
export async function dismissInterstitials(page: Page): Promise<void> {
  const candidates: Array<{ role: 'button'; name: RegExp }> = [
    { role: 'button', name: /accept( all)?( cookies)?/i },
    { role: 'button', name: /^(close|no thanks|not now|dismiss)$/i },
    { role: 'button', name: /continue/i },
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
      } catch {
        // best-effort; ignore
      }
    }
  }
}
// <<< SHARED-WITH-RUNNER-SPECSHIM
