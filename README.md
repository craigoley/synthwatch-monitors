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

> ★ **READ THIS FIRST — the one thing that breaks production on day one.**
> **Import ONLY from `../../lib/flow`.** A new shared module (`lib/helpers.ts`,
> `./utils`, anything else) **WILL NOT COMPILE in the runner** — SynthWatch fetches
> each spec **single-file** at `main`'s HEAD and esbuilds it with exactly one import
> alias (`lib/flow`). Your spec type-checks and runs locally, then fails at runtime in
> the runner. If you need a shared helper, add it **inside the `SHARED-WITH-RUNNER-SPECSHIM`
> markers in `lib/flow.ts`** and mirror it into the runner's `specShim.ts` (see
> `CLAUDE.md`) — that is the only shared surface. Do not create a second module.

1. Copy `monitors/synthwatch/dashboard-homepage.spec.ts` (the template) to
   `monitors/<area>/<name>.spec.ts`.
2. Write the journey as named steps (`step('search', async () => { ... })`) using
   **resilient locators** (`getByRole` / `getByText`) and asserting **stable
   signals** (URL patterns, visible text) — not brittle CSS paths. See `lib/flow.ts`.
   Import test helpers from `../../lib/flow` (`test`, `expect`, `step`,
   `dismissInterstitials`, `assertLoaded`, `credential`) — **and nothing else** (see
   the box above).
3. Add a matching entry to `manifest.json` with a **unique, never-reused `id`**.
4. Open a PR. CI validates the manifest ↔ scripts are in sync, type-checks, and
   confirms every script parses. Once merged, SynthWatch syncs it.

Run `npm run check` locally to validate before pushing.

> _Verified 2026-07-14 — NO AUTOMATED CHECK. This section (and the pin tables below) are
> hand-written prose; only `db/schema.sql`, the enum unions, and the contract fixtures are
> CI-gated against drift. **Distrust this doc if the code disagrees** — the code
> (`lib/flow.ts`, `manifest.schema.json`, `.github/workflows/check.yml`) is the source of truth._

## Selector resilience (important)

Production sites change their DOM constantly. Brittle selectors break on the next
site deploy and page you for a "monitoring outage" that's really just the site
changing. Always prefer role/text-based locators and assert on what a *user* would
see (a title, a URL shape), not exact structure. SynthWatch's AI root-cause
classifier labels such breaks **selector-drift** (update the monitor) vs
**real-outage** (the site is down) — resilient selectors keep the false-outage rate
low.

## Pin & entry freshness

This writes DOWN the fleet's existing pin policy — it already lives in spec-header
comments and failure messages; this section just consolidates it.

Monitors deliberately pin volatile, site-owned values because deterministic entry beats
racy UI navigation (see `CLAUDE.md`: "bypass racy autocomplete"). The known pin classes:

| pin class | examples (monitor → pin) | where stated |
|---|---|---|
| Direct-URL entry slugs | meals2go-browse-menu → `/browse-menu/pizza-wings`; meals2go-catering-browse → `/browse-catering/custom-cakes?cuisine=1985`; wegmans-shop-category-browse → `/shop/search?category=beverages`; wegmans-recipe-search → `/recipes/search?query=chicken` | each spec's header + failure message |
| Catalog/query terms | search-product → "ginger sparkling water"; recipe-search → "chicken"; search-autocomplete → "milk" (chosen always-in-catalog; a delisting reds as selector-drift, not outage) | spec headers |
| Store context | browse-menu/catering → auto-selected default store (store 16 observed; geo/IP-derived, deliberately NOT hardcoded in the network anchor — `meals2go-catering-browse.spec.ts` header); cart → McKinley/Buffalo; store-locator → a Buffalo-area store-name list | spec headers |
| Third-party URL shapes | Algolia `/1/indexes/<index>/queries` (index name deliberately un-pinned — wildcard regex, `search-autocomplete.spec.ts`); OpenTable loader URL; wegapi `kitting/…/menus`, `app-config/client/kv` | spec constants + headers |
| Marketing copy / labels | "Meals & Recipes" nav label; "RESERVE YOUR TABLE" headings; the Amore menu-PDF filename convention (`a[href$=".pdf"][href*="Menu" i]`) | spec locators + comments |

**The triage rule (entry-rot before backend-down).** When a monitor with a pinned entry
goes red at its first gate — a 404, a redirect, or its entry network anchor never firing —
suspect PIN-ROT first (the site restructured the slug/URL/id), and re-derive a live value
from the site's own navigation BEFORE concluding the backend is down. A rotted pin reads
identically to an outage but is a monitor defect, not an incident. This rule is stated in
the failure messages themselves: `meals2go-catering-browse.spec.ts` (header, "★ ENTRY-SLUG
RISK"), `meals2go-browse-menu.spec.ts`, `recipe-search.spec.ts`, and
`shop-category-browse.spec.ts` (propagated in PR #43) — the red run's error text tells the
responder where to re-derive the value.

**Freshness lifecycle (when pins are verified).** Pins are verified at recon time — each
spec header carries its dated ground truth (e.g. "recon 2026-06-30", "live recon
2026-07-02", "Entry live-verified 2026-07-04") — then proven by the first verified-clean
run before a monitor is enabled (`enabledByDefault: false`, see `CLAUDE.md`). There is
**no scheduled re-verification**: a pin is revalidated when its monitor goes red, per the
triage rule above. At the current fleet size that wait-for-red policy is deliberate; the
dated header stamps are what make a stale pin auditable.

**Cert-check cadence.** There is no explicit certificate-expiry check in this repo. TLS is
exercised implicitly on every run: each monitor's `page.goto` fails on an invalid or
expired certificate, so a cert problem on a target surfaces as that monitor going red at
its own interval (`suggestedIntervalSeconds`, 600–1800 s across the fleet). Any
expiry-lead-time alerting (warning *before* a cert lapses) would be a platform-side
feature, not a spec in this repo.

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
