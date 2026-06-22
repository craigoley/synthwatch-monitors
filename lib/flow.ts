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
 * Dismiss the common interstitials production e-comm sites throw up (cookie
 * banners, location/store pickers, newsletter modals) that otherwise intercept
 * clicks. Best-effort: never fails the flow if a given interstitial isn't
 * present. Add site-specific dismissals here as flows discover them.
 */
export async function dismissInterstitials(page: Page): Promise<void> {
  const candidates: Array<{ role: 'button'; name: RegExp }> = [
    { role: 'button', name: /accept( all)?( cookies)?/i },
    { role: 'button', name: /^(close|no thanks|not now|dismiss)$/i },
    { role: 'button', name: /continue/i },
  ];
  for (const c of candidates) {
    const el = page.getByRole(c.role, { name: c.name }).first();
    try {
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 2000 });
      }
    } catch {
      // best-effort; ignore
    }
  }
}
