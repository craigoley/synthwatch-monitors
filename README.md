# synthwatch-monitors

Playwright monitor scripts for [SynthWatch](https://github.com/craigoley/synthwatch).

> ★★ **THE #1 DAY-ONE RULE — read before you write a line.**
> **A monitor spec may import ONLY from `../../lib/flow`.** A new shared module
> (`lib/helpers.ts`, `./utils`, anything else) **WILL NOT COMPILE in the runner** —
> SynthWatch fetches each spec **single-file** at `main`'s HEAD and esbuilds it with
> exactly one import alias (`lib/flow`). It type-checks and runs locally, then fails at
> runtime in the runner. Need a shared helper? Add it inside the
> `SHARED-WITH-RUNNER-SPECSHIM` markers in `lib/flow.ts` and mirror it into the runner's
> `specShim.ts` (see `CLAUDE.md`) — that is the only shared surface. **Do not create a
> second module.**

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
   ★ **The field-by-field shape is `manifest.schema.json`** (the source of truth —
   ajv-gated by `scripts/validate-manifest.mjs` in CI); read that, not a prose copy here.
2. **`monitors/`** holds the Playwright scripts, organized by area
   (`monitors/wegmans/...`, `monitors/synthwatch/...`). Each is a standard
   Playwright test file using `test.step(...)` so SynthWatch's run-step funnel
   ("failed at step: search") works.
3. **SynthWatch syncs** this repo's `main` (after CI passes), discovers scripts via
   the manifest, and they appear in the dashboard's browser-monitor picker. You bind
   a monitor (interval, locations, alert profile) to a script `id`.

## Adding a monitor

★ Import **only** from `../../lib/flow` — see the **#1 day-one rule** at the top of this README.

1. Copy `monitors/synthwatch/dashboard-homepage.spec.ts` (the template) to
   `monitors/<area>/<name>.spec.ts`.
2. Write the journey as named steps (`step('search', async () => { ... })`) using
   **resilient locators** (`getByRole` / `getByText`) and asserting **stable
   signals** (URL patterns, visible text) — not brittle CSS paths. See `lib/flow.ts`.
   Import test helpers from `../../lib/flow` (`test`, `expect`, `step`,
   `dismissInterstitials`, `assertLoaded`, `credential`) — **and nothing else** (see
   the #1 day-one rule at the top).
3. Add a matching entry to `manifest.json` with a **unique, never-reused `id`**.
4. Open a PR. CI validates the manifest ↔ scripts are in sync, type-checks, and
   confirms every script parses. Once merged, SynthWatch syncs it.

Run `npm run check` locally to validate before pushing.

> _Verified 2026-07-14 — NO AUTOMATED CHECK. This is hand-written prose; only `db/schema.sql`,
> the enum unions, and the contract fixtures are CI-gated against drift. **Distrust this doc if
> the code disagrees** — the code (`lib/flow.ts`, `manifest.schema.json`,
> `.github/workflows/check.yml`) is the source of truth._

## Rollback

> ★ **DRAFT · UNREHEARSED · NEVER EXECUTED.** _Verified 2026-07-14 — NO AUTOMATED CHECK. This
> procedure has not been run; treat it as a starting point, not a tested runbook. Distrust it
> if the platform disagrees._

Two different things are called "roll back", with **two different mechanisms**:

1. **Roll back a monitor CHANGE (a bad spec edit) → revert the PR.** The runner serves monitors
   from `main` at **HEAD** (no pinned SHA), so once the revert merges and SynthWatch re-syncs,
   the previous spec is live. A normal repo action (PR + auto-merge).
2. **DISABLE a monitor (stop it running / paging) → a dashboard/DB action, NOT a repo action:**
   set `checks.enabled = false` for that monitor in the platform. ★ **Do NOT delete the spec to
   "disable" it** — removing a `monitors/*.spec.ts` without its `manifest.json` entry (or
   vice-versa) **trips `validate-manifest.mjs`** (manifest ↔ scripts must stay 1:1); and even a
   clean delete removes only the *code*, not the *schedule* — the check row keeps trying to run.
   Disable is the `enabled` flag, in the platform.

⚠️ **Re-sync cadence lives in the RUNNER, not this repo** — how fast a revert or a new spec
reaches production depends on the runner's sync interval (configured there). A merge here is
not instantly live.

## Selector resilience

Prefer role/text locators (`getByRole`/`getByText`) and assert a **stable** signal (a URL
shape, key visible text) — never exact CSS structure. The rationale + the convention live
in **`lib/flow.ts`** (header docstring, ~lines 3–19): a brittle selector reds as
**selector-drift** (update the monitor) rather than a real **outage**; keeping the
false-outage rate low is the whole game.

## Pin & entry freshness

Monitors deliberately pin volatile, site-owned values (entry slugs, query terms, store
context, third-party URL shapes) so deterministic entry beats racy UI nav. The full pin
policy — the pin-class table, the **entry-rot-before-backend-down** triage rule, the
freshness lifecycle, and the cert-check note — lives in
**[`docs/runbooks/pin-and-entry-freshness.md`](docs/runbooks/pin-and-entry-freshness.md)**
(moved out of the README to keep this file to onboarding). The authoritative copy is the
spec headers + failure messages.

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
lib/flow.ts              THE ONLY importable shared module (single-file fetch): step(),
                         assertLoaded(), dismissInterstitials(), credential(), + test/expect
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
