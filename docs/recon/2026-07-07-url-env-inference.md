# Recon — URL→environment inference: load-bearing or sugar? — 2026-07-07

**Question (Craig):** derive a check's `environment` from its target URL (with a management surface to
correct wrong guesses), vs / on top of the explicit `checks.environment` column just built (#213). Does
the fleet's URLs actually CARRY enough signal to infer environment?

**Scope:** ANALYSIS ONLY, docs-only. Repos: `synthwatch-monitors` (the specs/manifest) +
`synthwatch` (runner: how the target URL reaches a check row). Branched from `origin/main` @ `45e68f8`.

## Evidence contract

- Every finding cites `file:line` or pasted command output. **OBSERVED** vs **INFERRED** separated.
- The key question is a **distribution**, so it is **COUNTED**.
- Fleet size note: the prompt said "16 specs"; `origin/main` now has **17** (b2c-login-test landed as
  PR #52 after the prompt was written). All 17 are enumerated below.

---

## TL;DR — the decision

**CLEAN hosts (URL substring deterministically implies env): 0. AMBIGUOUS: 17/17 checks (5/5 distinct
target hosts).** Not one target URL in the fleet carries an env-discriminating substring — every target
is a bare, unmarked prod origin. **So URL-inference is ergonomic SUGAR, not load-bearing.** The
`checks.environment` column (#213) + a human override do 100% of the real work; inference could at best
pre-fill a default that is *already* the DB default (`'prod'`), and on the one genuinely-shared host
(`*.vercel.app`) it would GUESS WRONG. Build it only as a write-time suggestion that renders `unknown`
(never silently `prod`) — and only after pre-prod hosts adopt a CLEAN naming convention, or it is inert.

---

## 1. Host inventory — every monitor's target host(s)

**OBSERVED.** Two host classes per spec: the **target_url host** (the `page.goto` entry origin, which
is also what the check row stores — see §3) and **backend/API hosts** the spec's assertions hit (network
anchors / scoped routes). Only the target_url host is ever an inference input (§3).

| # | monitor (spec) | target_url host (= manifest `target`) | backend/API hosts hit in-spec |
|---|---|---|---|
| 1 | wegmans/homepage-load | `www.wegmans.com` | — |
| 2 | wegmans/search-product | `www.wegmans.com` | (Algolia results via nav) |
| 3 | wegmans/search-autocomplete | `www.wegmans.com` | `*.algolia.net` (`search-autocomplete:17,57`) |
| 4 | wegmans/recipe-nav | `www.wegmans.com` | — |
| 5 | wegmans/recipe-search | `www.wegmans.com` | — |
| 6 | wegmans/shop-category-browse | `www.wegmans.com` | — |
| 7 | wegmans/store-locator | `www.wegmans.com` | — |
| 8 | wegmans/b2c-login-test | `www.wegmans.com` | `myaccount.wegmans.com` (B2C, scoped route `:233`), `api.ipify.org`/`ifconfig.me` (`:138`) |
| 9 | wegmans/meals2go-homepage | `www.meals2go.com` | `wegapi.azure-api.net` (`meals2go-homepage:18,59`) |
| 10 | wegmans/meals2go-cheese-pizza-cart | `www.meals2go.com` | `www.meals2go.com/…/cart-items` (same-origin, relative) |
| 11 | wegmans/meals2go-browse-menu | `www.meals2go.com` | `wegapi.azure-api.net` (`meals2go-browse-menu:22,50`) |
| 12 | wegmans/meals2go-catering-browse | `www.meals2go.com` | `wegapi.azure-api.net` (`meals2go-catering-browse:24,63`) |
| 13 | amore/amore-menu | `wegmansamore.com` | — |
| 14 | amore/amore-reservations | `wegmansamore.com` | `*.opentable.com` (`amore-reservations:13,50`) |
| 15 | nextdoor/nextdoor-homepage | `www.wegmansnextdoor.com` | — |
| 16 | nextdoor/nextdoor-reservations | `www.wegmansnextdoor.com` | `*.opentable.com` (`nextdoor-reservations:19,58`) |
| 17 | synthwatch/dashboard-homepage | `synthwatch-dashboard.vercel.app` | — |

Distinct target_url hosts (the inference denominator): **5** — `www.wegmans.com` (×8),
`www.meals2go.com` (×4), `wegmansamore.com` (×2), `www.wegmansnextdoor.com` (×2),
`synthwatch-dashboard.vercel.app` (×1).

Distinct backend/API hosts (never an inference input): `wegapi.azure-api.net`, `*.algolia.net`,
`*.opentable.com`, `myaccount.wegmans.com`, `api.ipify.org`, `ifconfig.me`.

*(Falsifier for "some spec hits a staging/dev host": `grep -rniE 'https?://' monitors/` — the full census
above shows only prod origins; no `staging.`/`dev.`/`-preview`/`qa.` host appears anywhere.)*

---

## 2. Env-inferability classification + COUNT (the decision driver)

**CLEAN** = a URL substring deterministically implies env (`staging.`/`dev.`/`-preview.` prefix, etc.),
so inference would be *correct by construction*. **AMBIGUOUS** = the host is shared across envs, or an
unmarked prod apex the URL cannot disambiguate; these NEED the manual override — inference can only guess.

### Target_url hosts (what inference actually reads)

| host | checks | bucket | why |
|---|---|---|---|
| `www.wegmans.com` | 8 | **AMBIGUOUS** | unmarked prod apex — no env substring. "Prod" is a *convention* ("no marker ⇒ prod"), not information carried in the URL; a hypothetical `staging` reusing the apex would be indistinguishable. |
| `www.meals2go.com` | 4 | **AMBIGUOUS** | same — unmarked apex. |
| `www.wegmansnextdoor.com` | 2 | **AMBIGUOUS** | same. |
| `wegmansamore.com` | 2 | **AMBIGUOUS** | unmarked prod, and *no `www.`* — the family isn't even internally consistent, so a prefix rule mis-keys it. |
| `synthwatch-dashboard.vercel.app` | 1 | **AMBIGUOUS** (actively misleading) | `*.vercel.app` is Vercel's **shared preview+prod** domain (S2 recon, `docs/recon/2026-07-07-monitors.md:163`). The host cannot disclose env; a naive "`vercel.app`⇒prod" rule would mis-label a preview deploy as prod. THE poster child for "render `unknown`, not default prod." |

**CLEAN: 0/5 distinct hosts (0/17 checks). AMBIGUOUS: 5/5 distinct (17/17 checks) = 100%.**

### Backend/API hosts (for completeness — never inference inputs, all non-env-bearing)

`wegapi.azure-api.net` (multi-tenant Azure APIM), `*.algolia.net` (multi-tenant SaaS), `*.opentable.com`
(third-party widget), `myaccount.wegmans.com` (B2C custom domain behind Akamai), `api.ipify.org` /
`ifconfig.me` (IP echo). All **AMBIGUOUS / shared-infra** — none is an environment-bearing origin, and a
naive map that ingested them would mis-bucket them against a Wegmans environment.

### The ratio → the verdict

**0% CLEAN.** Inference carries **zero** discriminating weight on the current fleet: the only "signal"
available is the tautology "no env marker ⇒ prod," which is exactly the DB column's `DEFAULT 'prod'`
(§3) — inference would recompute the default the schema already applies. Therefore **inference is sugar;
the column + override do the real work.** It could become load-bearing ONLY if future pre-prod checks
adopt a CLEAN host convention (`staging.wegmans.com`, `-preview` Vercel aliases, etc.) — which is a
naming decision, not a property of today's URLs.

---

## 3. Where the target URL lives relative to the check row (OBSERVED — runner)

**ANSWER: there is a first-class stored `checks.target_url TEXT NOT NULL` column — inference runs at
check-creation from a STORED field; it does NOT have to parse the compiled spec.** And `#213`'s
`environment` is a sibling stored column, source-of-truth.

- `checks.target_url TEXT NOT NULL` — `synthwatch db/schema.sql:27`. For network checks, "Host is from
  `target_url`" (`db/schema.sql:48`). So the host is one `new URL(target_url).host` away, in the row.
- `checks.environment TEXT NOT NULL DEFAULT 'prod' CHECK (environment IN ('prod','staging','dev'))` —
  `db/schema.sql:162-164`, migration `db/migrations/0059_checks_environment.sql`. #213. The `DEFAULT
  'prod'` backfills every existing check (metadata-only, no rewrite).
- **Provenance of `target_url` for monitors-as-code:** the runner's reconcile sets it from the manifest
  `target` field — `target_url: monitor.target ?? null` (`runner/reconcile.ts:451`, `:407`, diff `:296`).
  So for a browser monitor, `checks.target_url` == the manifest `target` (e.g. `https://www.wegmans.com`)
  — the **entry origin**, not the deepest backend. (Caveat: `target` is optional in the manifest schema;
  `?? null` against a `NOT NULL` column means a manifest omitting `target` would fail the insert — all 17
  currently set it, so moot today.)
- **`environment` is NOT synced from git and NOT clobbered by reconcile.** The reconcile field-split
  (`runner/reconcile.ts`): `GIT_AUTHORITATIVE_COLUMNS = [name, kind, target_url, flow_name, sensitive,
  redact_patterns]`; `SEED_ONLY_COLUMNS = [interval_seconds, enabled]`. **`environment` is in neither** —
  it is dashboard/runner-owned, so a human-set/inference-confirmed environment **survives every sync**.
  The monitors `manifest.schema.json` also has **no** `environment` field (`additionalProperties:false`,
  §1 properties list) — environment can't be declared in the monitors repo at all.

**Consequence for the design:** inference reads a clean stored `target_url` (no spec-parsing), writes a
proposal into the human-owned `checks.environment`, and reconcile will never overwrite that confirmed
value. The substrate is ideal for a *write-time suggestion*; nothing forces inference into the read path.

---

## 4. Scoped design — the suggestion layer (NOT built)

**Shape:** inference is a **check-creation-time proposal only**. It never persists an "inferred" value
as its own field and is never read by any aggregation.

1. **At creation / first sync of a check:** parse `new URL(checks.target_url).host` → run a
   `hostEnvGuess(host)` returning `{ env: 'prod'|'staging'|'dev'|'unknown', confidence }`. **CLEAN host →
   propose the matched env. AMBIGUOUS host → return `unknown`** (never silently `prod`). Given §2, today
   that is `unknown` for 100% of the fleet — i.e., the proposal is "please confirm," which is honest.
2. **Human confirms/corrects** in the create form; the confirmed value is written to
   `checks.environment` (the CHECK-constrained column). The DB `DEFAULT 'prod'` remains the safety net
   for rows created without a choice (already the backfill semantics of migration 0059).
3. **Management surface** = a list/edit view of `(check, target_url, environment)` with per-check and
   bulk re-classification — this is where AMBIGUOUS hosts (all of them) and any wrong guess get fixed.
   For monitors-as-code, environment is set/corrected here (the manifest can't carry it, and reconcile
   won't overwrite it — §3), so corrections are durable across syncs.
4. **Inference function contract:** a host→env map with an explicit `unknown` bucket; `*.vercel.app`,
   apex hosts, and shared backends map to `unknown`, never `prod`. Pair with a documented pre-prod host
   naming convention (`staging.`/`dev.`/`-preview`) or the map returns `unknown` forever and the layer
   is inert (§2).

### ★ The explicit constraint — should the exclude-set (slo/mttr/trust) EVER read the inferred value?

**ANSWER: NO — the exclude-set must read ONLY the confirmed `checks.environment` column. The strong
prior HOLDS, and the data flow already enforces it.**

- **It already reads only the confirmed column.** The default-exclude is
  `WHERE coalesce(environment,'prod')='prod'` over `checks.environment` in synthwatch-api's slo/mttr/trust
  rollups (`db/migrations/0059_checks_environment.sql` header; `docs/recon/2026-07-07-preprod-arc-scope.md:109,119,171`).
  There is **no "inferred" field in the schema** for it to read — inference (if built) writes INTO
  `checks.environment` after human confirmation, so by construction the exclude consumes a
  human-confirmed value, never a heuristic.
- **Why it must stay that way (correctness):** migration 0059's own rationale — "a pre-prod check
  pollutes every prod rollup (SLO budget, MTTR, trust)" — is exactly the failure a mis-guess would cause.
  If the exclude read an inferred value, a single wrong guess (the `*.vercel.app` preview labeled `prod`,
  §2) would silently drop a real pre-prod failure into the prod SLO/MTTR/trust numbers, or hide a prod
  failure — the precise pollution the first-class column exists to prevent. The runner design already
  states the principle: **"do not infer silently"** (`docs/recon/2026-07-07-preprod-arc-scope.md:79`).
- **Therefore:** inference is strictly a **write-time UX affordance** (pre-fill the dropdown), never a
  **read-time input** to any aggregation. `checks.environment` (confirmed) stays the sole source of truth
  for every correctness-critical exclude. A correctness-critical exclude must not depend on a heuristic —
  and here it structurally cannot, as long as inference is confined to proposing a default a human ratifies.

---

## Bottom line

- **Is URL-inference load-bearing? No — 0% of the fleet's target URLs carry env signal (17/17
  AMBIGUOUS).** It is ergonomic sugar over `checks.environment`, which stays source-of-truth.
- **Worth building?** Low priority. As a *pure write-time suggestion* that renders `unknown` on ambiguity
  and only pre-fills, it's cheap and harmless — but on today's fleet it proposes nothing useful (every
  host → `unknown`/`prod`-default). It pays off only once pre-prod checks exist with a CLEAN host naming
  convention; until then the manual override + the column already do everything.
- **The exclude-set reads ONLY the confirmed column — confirmed against the data flow. Keep it that way.**
