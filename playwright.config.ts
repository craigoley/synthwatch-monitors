import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the monitor scripts.
 *
 * This config is used for LOCAL development + the CI compile-check (does every
 * script parse + type-check + list as a valid test). SynthWatch's RUNNER applies
 * its OWN execution config when it runs a synced script (the real interval,
 * locations, trace/screenshot-on-failure, the SynthWatch user-agent, etc.) -- so
 * keep this config minimal and dev-focused. The per-monitor schedule lives in
 * SynthWatch (bound to the manifest `id`), not here.
 */
export default defineConfig({
  testDir: './monitors',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  projects: [
    {
      // The monitor specs (browser). Local/CI use `--list` to compile-check; the RUNNER executes them.
      name: 'monitors',
      testDir: './monitors',
      testMatch: '**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        userAgent: 'SynthWatch-Monitor/1.0 (+https://github.com/craigoley/synthwatch-monitors)',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      },
    },
    {
      // PURE unit red-tests over the guard logic (tests/). NO browser device → runs in CI without Chrome
      // installed (`npm run test:unit` / `playwright test --project=unit`). Never touches the live site.
      name: 'unit',
      testDir: './tests',
      testMatch: '**/*.spec.ts',
    },
  ],
});
