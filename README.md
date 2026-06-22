# synthwatch-monitors

Playwright monitor scripts for [SynthWatch](https://github.com/craigoley/synthwatch).

This repo holds the **browser-monitor scripts** SynthWatch runs as synthetic monitors.
It exists so that **adding or fixing a monitor is a pull request here — reviewed,
gated, and synced live — *without* redeploying SynthWatch.** The script (the *how*)
lives here; the monitoring config (interval, locations, alerting, enabled) lives in
SynthWatch, bound to a script's stable `id`.

This is the "monitoring as code" model (the pattern Checkly pioneered): monitors are
version-controlled code, reviewed like application code, but decoupled from the
monitoring platform's deploy cycle.

## How it works

```
You edit a monitor  ->  PR to this repo  ->  CI gates it (manifest + typecheck + compile)
                    ->  auto-merge to main  ->  SynthWatch syncs from main  ->  live, no SynthWatch redeploy
```

1. **`manifest.json`** is the registry. Each entry binds a stable `id` (the key a
   SynthWatch monitor references) to a script under `monitors/`. SynthWatch reads
   this after syncing the repo to know which monitors exist and what to call them.
2. **`monitors/`** holds the Playwright scripts, organized by area
   (`monitors/wegmans/...`, `monitors/synthwatch/...`). Each is a standard
   Playwright test file using `test.step(...)` so SynthWatch's run-step funnel
   ("failed at step: search") works.
3. **SynthWatch syncs** this repo's `main` (after CI passes), discovers scripts via
   the manifest, and they appear in the dashboard's browser-monitor picker. You bind
   a monitor (interval, locations, alert profile) to a script `id`.

## Adding a monitor

1. Copy `monitors/synthwatch/dashboard-homepage.spec.ts` (the template) to
   `monitors/<area>/<name>.spec.ts`.
2. Write the journey as named steps (`step('search', async () => { ... })`) using
   **resilient locators** (`getByRole` / `getByText`) and asserting **stable
   signals** (URL patterns, visible text) — not brittle CSS paths. See `lib/flow.ts`.
3. Add a matching entry to `manifest.json` with a **unique, never-reused `id`**.
4. Open a PR. CI validates the manifest ↔ scripts are in sync, type-checks, and
   confirms every script parses. Once merged, SynthWatch syncs it.

Run `npm run check` locally to validate before pushing.

## Selector resilience (important)

Production sites change their DOM constantly. Brittle selectors break on the next
site deploy and page you for a "monitoring outage" that's really just the site
changing. Always prefer role/text-based locators and assert on what a *user* would
see (a title, a URL shape), not exact structure. SynthWatch's AI root-cause
classifier labels such breaks **selector-drift** (update the monitor) vs
**real-outage** (the site is down) — resilient selectors keep the false-outage rate
low.

## Security model

A monitor script is **code SynthWatch's runner executes**, and the runner has
database, blob-storage, and Azure managed-identity access. So this repo is treated as
**trusted, reviewed code**:

- **Branch protection + review + gated auto-merge** on `main` are the primary control
  — a monitor change is reviewed and CI-gated before it can sync. This is why the
  separate-repo-with-review model is used instead of letting people upload scripts or
  edit them in an on-site editor (both would be unreviewed arbitrary code execution).
- Scripts use a **fixed, vetted dependency set** (Playwright + the `lib/flow.ts`
  helpers). They do not `npm install` arbitrary packages at runtime.
- SynthWatch runs each script with a **bounded timeout/resources** and (by design)
  scoped so a script drives a browser + asserts — it should not reach the runner's
  database or managed-identity credentials. The runner harness handles persistence
  *after* the flow.

Do **not** add a script that does anything other than drive a browser and assert on
a monitored site. Network calls go to the monitored target, not internal services.

## Layout

```
manifest.json            registry: id -> script binding (what SynthWatch reads)
manifest.schema.json     JSON schema for the manifest
lib/flow.ts              shared helpers: step(), assertLoaded(), dismissInterstitials()
monitors/<area>/*.spec.ts   the Playwright monitor scripts
scripts/validate-manifest.mjs   CI: manifest <-> scripts in sync, ids valid/unique
playwright.config.ts     local/CI config (SynthWatch applies its own at runtime)
.github/workflows/check.yml   CI gate (manifest + typecheck + compile)
```

## Status of the seed monitors

The seed scripts (`wegmans/*`, `synthwatch/*`) use **resilient-guess selectors** that
**must be verified against the live sites on first run** — the real DOM/nav structure
may differ from the assumptions in the scripts. When SynthWatch first runs one, the
trace + screenshot show the real page; tighten the locators to match. They ship
`enabledByDefault: false` so you enable them deliberately (and, for wegmans.com,
after confirming synthetic traffic against production is sanctioned and the interval
is conservative).
