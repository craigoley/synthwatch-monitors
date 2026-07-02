# Deep review — synthwatch-monitors — 2026-07

Overnight deep analysis of the monitor fleet. **Docs only; nothing was fixed.**

## Evidence contract

- **No live runs.** Per the hard rail, no monitor was executed against wegmans.com,
  meals2go.com, or any other target. Evidence is limited to: static reads of every file,
  full git history (`git log --all`), the offline gate (`npm run validate:manifest`,
  `tsc --noEmit`, `playwright test --list` — all green, 15 tests in 15 files), and the
  **installed** Playwright 1.61.1 type declarations (`node_modules/playwright-core/types/types.d.ts`)
  for API-behavior claims, not memory.
- Every claim cites `file:line` against the tree at `ae2c88e` (merge of PR #37, tip of `main`
  at branch time).
- **Recon / prior-analysis diff:** `git log --all --oneline -- docs/*` returns nothing — no
  prior analysis doc exists on any branch. This is the first deep review; there is no
  baseline to diff against. Claims inherited from the task brief that this repo's evidence
  cannot support are flagged explicitly (see §1 manifest-integrity and §5).
- Severity is only assigned after an attempt to falsify (noted inline where it changed the
  verdict).

---

## 1. Fleet inventory

**15 manifest entries, 15 spec files, all bound** (`npm run validate:manifest` →
"Manifest OK: 15 monitor(s), 15 script(s), all bound."). All entries are `kind: "browser"`
and `enabledByDefault: false`. Every spec parses and lists (`playwright test --list`, 15/15).

**Retry semantics (fleet-wide):** the repo defines none. `playwright.config.ts` sets no
`retries` (Playwright default: 0), and the manifest schema has no retry field
(`manifest.schema.json:20-46`). Retry/interval/location policy is explicitly runner-owned:
"the MONITORING CONFIG (interval, locations, alerting, enabled) lives in SynthWatch's DB"
(`manifest.json:4`; `playwright.config.ts:7-11`). `suggestedIntervalSeconds` is the only
cadence signal this repo carries, and it is advisory.

**Timeout budget (fleet-wide):** local/CI budget is 60 s per test with a 15 s expect
default (`playwright.config.ts:16-17`). The runner "applies its OWN execution config"
(`playwright.config.ts:8-10`), whose value is not visible from this repo. Per-monitor
worst-case wait sums below are measured against the only budget the repo declares (60 s).

| id | target property | journey covered | spec path | steps | worst-case wait sum vs 60 s local budget |
|---|---|---|---|---|---|
| `wegmans-homepage-load` | wegmans.com | homepage smoke: nav + shop link render | `monitors/wegmans/homepage-load.spec.ts` | 3 | ~30 s + goto — fits |
| `wegmans-search-product` | wegmans.com | search results URL → product card → quick-view dialog | `monitors/wegmans/search-product.spec.ts` | 3 | 5×15 s sequential expects = 75 s + goto — **no headroom; worst case exceeds** |
| `wegmans-search-autocomplete` | wegmans.com | type-ahead: Algolia 200 + suggestion renders (never submits) | `monitors/wegmans/search-autocomplete.spec.ts` | 3 | 20 s network (armed concurrently, spec:34-35) + 15+15 s — fits |
| `wegmans-shop-category-browse` | wegmans.com | category URL → product card → quick-view dialog (★UNVERIFIED entry URL, spec:27-31) | `monitors/wegmans/shop-category-browse.spec.ts` | 4 | 4×15 s = 60 s + goto — marginal |
| `wegmans-store-locator` | wegmans.com | /stores directory → Buffalo-area store → store detail | `monitors/wegmans/store-locator.spec.ts` | 4 | ~5×15 s worst = 75 s — **no headroom** |
| `wegmans-recipe-nav` | wegmans.com | home → Meals & Recipes → Courses tab → Dinner → first recipe detail | `monitors/wegmans/recipe-nav.spec.ts` | 5 | ~6×15 s = 90 s worst — **exceeds** |
| `wegmans-recipe-search` | wegmans.com | /recipes/search?query=chicken → first card → recipe detail (★UNVERIFIED entry URL, spec:26-29) | `monitors/wegmans/recipe-search.spec.ts` | 4 | 4–5×15 s — marginal |
| `wegmans-meals2go-homepage` | meals2go.com | homepage bootstrap: first-party app-config API 200 + /browse-menu card | `monitors/wegmans/meals2go-homepage.spec.ts` | 3 | 30 s network (armed pre-goto, spec:44-46) + 15 s — fits |
| `meals2go-browse-menu` | meals2go.com | anon menu discovery: kitting menus API 200 + item cards (never carts) | `monitors/wegmans/meals2go-browse-menu.spec.ts` | 3 | 30 s network + 15 s — fits |
| `meals2go-cheese-pizza-cart` | meals2go.com | carryout fulfillment (Buffalo→McKinley) → Pizza → cheese pizza → add-to-cart verified via cart-items API | `monitors/wegmans/meals2go-cheese-pizza-cart.spec.ts` | 5 | ~350 s worst; `CART_WAIT_MS = 60_000` (spec:262) alone equals the whole local budget — **cannot fit 60 s** |
| `amore-reservations` | wegmansamore.com | OpenTable loader request fires (rid=107458) + heading (never books) | `monitors/amore/amore-reservations.spec.ts` | 3 | 30 s request wait (armed pre-goto) + 15 s — fits |
| `amore-menu` | wegmansamore.com | /menus/ exposes a downloadable menu PDF | `monitors/amore/amore-menu.spec.ts` | 2 | 15 s — fits |
| `nextdoor-homepage` | wegmansnextdoor.com | location picker renders both location links | `monitors/nextdoor/nextdoor-homepage.spec.ts` | 2 | 2×15 s — fits |
| `nextdoor-reservations` | wegmansnextdoor.com | OpenTable loader request fires (rid=2407) + heading — mirror of amore | `monitors/nextdoor/nextdoor-reservations.spec.ts` | 3 | 30 s + 15 s — fits |
| `synthwatch-self-homepage` | synthwatch-dashboard.vercel.app | self-monitor/template: Monitors heading renders | `monitors/synthwatch/dashboard-homepage.spec.ts` | 2 | 2×15 s — fits |

Intervals: 600 s (self), 900 s (both homepage smokes: `manifest.json:56,89`), 1800 s (the
other 12).

### Manifest-integrity check (mechanical)

- **NULL/missing script:** none today, and **none ever in this repo's history.** All 8
  revisions of `manifest.json` (`ece2306` → `612bbee`) were checked for `"script": null`
  and for missing-script keys: zero hits. The task brief states this class "shipped twice:
  recipe-search, meals2go-browse-menu" — **this repo's evidence cannot confirm that**; if
  those incidents happened, they happened on the SynthWatch platform side (DB `spec_path`),
  not in this manifest. Recorded as Open Question Q3, not a finding.
- **Structural guards now present:** three layers guard the script binding —
  (1) `manifest.schema.json:13` makes `script` required with pattern
  `^monitors/.+\.spec\.ts$` (`:27-31`); (2) `scripts/validate-manifest.mjs:22` rejects a
  missing/malformed path, `:48-52` requires the file to exist, `:63-67` rejects orphan
  specs, `:15-19` enforces id pattern/uniqueness; (3) CI runs the validator on every PR and
  push to main (`.github/workflows/check.yml:32-33`). **Caveat:** layer (1) is not actually
  executed anywhere — see §6; the effective guard is the hand-rolled validator, which does
  cover the NULL-script class.
- **Consistent naming/IDs — three Minor inconsistencies:**
  - id prefix: `meals2go-cheese-pizza-cart` / `meals2go-browse-menu` vs
    `wegmans-meals2go-homepage` (`manifest.json:29,162,85`) — same property, two prefix
    conventions.
  - display name: "Meals2Go:" (`manifest.json:30`) vs "Meals 2 Go:" (`manifest.json:86,163`).
  - tags: `wegmans-meals2go-homepage` carries both `wegmans` + `meals2go` tags
    (`manifest.json:90`); the other two meals2go monitors carry only `meals2go`
    (`manifest.json:34,167`). A tag-filtered dashboard view of "wegmans" silently excludes
    two Wegmans properties' monitors.
  - directory: meals2go specs live under `monitors/wegmans/` while amore/nextdoor (equally
    Wegmans-owned properties) get their own directories.
- **Orphaned specs / manifest-without-spec:** none (validator output; independently
  confirmed by the file listing: 15 `.spec.ts` under `monitors/`, 15 `script` values).
- **Stale manifest description (Minor, user-facing):** `manifest.json:35` still says the
  cart monitor "then self-clean[s] by removing it" — the self-clean was removed in
  `ae224be` (PR #37); the spec now documents "NO SELF-CLEAN NEEDED"
  (`meals2go-cheese-pizza-cart.spec.ts:17-24,316-322`). If the dashboard renders manifest
  descriptions, it now describes behavior the script doesn't have.

---

## 2. Flake-risk scorecard

**Fleet-wide wait discipline is strong:** zero `waitForTimeout`, zero `networkidle`, zero
`setTimeout` across all 15 specs and `lib/flow.ts` (mechanical grep). All navigation uses
`waitUntil: 'domcontentloaded'`. Network anchors are explicit
`waitForResponse`/`waitForRequest` predicates armed *before* the triggering action
(e.g. `search-autocomplete.spec.ts:34-35`, `meals2go-homepage.spec.ts:44-46`). The one
wait-discipline soft spot is the cart spec's suppressed-error boundary waits (13 of the
fleet's 15 `.catch(() => …)` suppressions are in that one file).

Scoring: **LOW** = hard to flake without a real site change; **MEDIUM** = at least one
selector/assumption that a routine site deploy could break; **HIGH** = multiple brittle
assumptions or a budget that can't hold. Selector counts are per distinct locator
expression in the spec body.

| monitor | selector mix (role+testid / text / CSS) | wait discipline | budget vs steps | risk |
|---|---|---|---|---|
| `synthwatch-self-homepage` | 2 / 1 / 0 | explicit expects only | ample | **LOW** |
| `nextdoor-homepage` | 0 / 0 / 2 (href-anchored, visible-filtered, spec:33,37) | explicit | ample | **LOW** |
| `amore-menu` | 1 / 0 / 1 (`a[href$=".pdf"][href*="Menu" i]`, spec:30) | explicit | ample | **LOW** |
| `amore-reservations` | 1 / 0 / 0 + request anchor | request-wait armed pre-goto (spec:34-36) | ample | **LOW** |
| `nextdoor-reservations` | 1 / 0 / 0 + request anchor | same pattern (spec:40-42) | ample | **LOW** |
| `wegmans-meals2go-homepage` | 0 / 0 / 1 (href-anchored, visible-filtered, spec:71) + response anchor | response-wait armed pre-goto | ample | **LOW** |
| `meals2go-browse-menu` | 0 / 0 / 1 (`button.menu-card-link`, spec:60 — class-based, one deploy from breaking) + response anchor | response-wait armed pre-goto | ample | **LOW–MEDIUM** |
| `wegmans-homepage-load` | 3 / 0 / 1 | explicit | ample | **LOW–MEDIUM** — step 3's shop-link signal is self-declared ★UNVERIFIED (spec:38-41) |
| `wegmans-search-autocomplete` | 1 / 0 / 1 | explicit + response anchor | fits | **MEDIUM** — entry selector is a bare CSS id `#site-header-search-input` (spec:44); if the site renames the id the monitor reds as "search broken". The 120 ms `pressSequentially` (spec:48) is deliberate and verified in installed types |
| `wegmans-search-product` | 3 / 4 / 3 | explicit | 5×15 s sequential = 75 s worst, **zero headroom** | **MEDIUM** — quick-view detection rests on `dialog.component--product-details-dialog` / `.component--product-details` class names (spec:75-77); trace-verified but build-artifact-shaped. The `.or(getByRole('dialog'))` fallback (spec:77) mitigates |
| `wegmans-store-locator` | 2 / 1 / 3 | explicit | 75 s worst, no headroom | **MEDIUM** — the Buffalo-store name regex (spec:36,48: `alberta\|amherst\|mckinley\|…`) hardcodes 10 store names; a directory redesign or store closure list churn degrades it. href-anchored `a[href^="/stores/"]` is solid |
| `wegmans-recipe-nav` | 7 (incl. testid) / 1 / 1 | explicit | ~90 s worst over 6 sequential expects — **exceeds local budget** | **MEDIUM** — longest wegmans.com click-path (5 steps); depends on `#category-tabpanel-courses` id (spec:52) and the ARIA-tab structure (spec:44); card selector `getByTestId('img-recipe-card')` (spec:71) is the fleet's only test-hook dependency, trace-verified |
| `wegmans-recipe-search` | 4 (incl. testid ×2) / 1 / 0 | explicit | marginal | **MEDIUM–HIGH** — the *entry URL itself* is ★UNVERIFIED (spec:26-29: "likely uses /recipes/search?query=… If neither works…"). If wrong, this is a permanent-red the day it's enabled — a guaranteed false incident, the worst kind for monitor trust |
| `wegmans-shop-category-browse` | 3 / 0 / 4 | explicit | marginal | **MEDIUM–HIGH** — same class of risk: `?category=beverages` URL is ★UNVERIFIED (spec:27-31); quick-view dialog classes shared with search-product (spec:67-69) |
| `meals2go-cheese-pizza-cart` | 14 role / 2 text / 23 CSS `locator()` calls | explicit, but **13 suppressed-catch waits** (spec:94,101,110-116,126-131,145,171-174,204-208,221-222,231) | ~350 s worst; `CART_WAIT_MS=60 s` (spec:262) equals the entire local budget | **HIGH** |

**Why the cart spec earns HIGH** (all trace-verified selectors, so this is structural risk,
not guesswork): (1) heaviest brittle-CSS dependence in the fleet — Angular component tags
and generated ids/classes (`#fulfillment-confirmation-confirm-button-carryout` spec:81,
`button.google-result` spec:94-96, `app-wegmans-store:has(span.store-title:text-is("Mckinley"))
button.wegmans-store-container` spec:135, `button#cuisine-thin-crust-pizza` spec:199,
`app-pop-open-pane … button.cart-button` spec:247); any frontend rebuild can rename these.
(2) The GATE-B stage boundaries are all `.catch(() => {})`-suppressed (spec:94,110-116,145)
— if a boundary silently fails to hold, the failure surfaces at a *later* gate with a less
diagnostic message. (3) External dependency inside the flow: the store picker rides a
Google address autocomplete (spec:89-103) and a virtualized 113-store list (spec:121-124).
(4) Worst-case wait arithmetic (~350 s) is several multiples of the only declared budget;
the repo has no manifest field to tell the runner what budget this script actually needs
(§6). (5) `noWaitAfter: true` on the item click (spec:231) is **deprecated in the installed
Playwright 1.61.1** ("This option will default to `true` in the future" —
`playwright-core/types/types.d.ts`); functional today, a removal candidate upstream.

**Page-state assumptions worth flagging:** the cart spec deliberately tolerates a
"returning session may already be past the landing" state (spec:64,173) — correct for
robustness, but it means steps a–c can silently no-op down alternate paths, which is why
its true assertion load concentrates in GATE-E. The two reservation specs assert the loader
*request* rather than response because the OpenTable response reliably errors headless
(`amore-reservations.spec.ts:15-24`) — a documented, environment-verified choice, not a
weakness.

---

## 3. Duplication and shared-helper analysis

Measured repeated patterns (mechanical counts across the 15 specs):

| pattern | count | where |
|---|---|---|
| Opener idiom: `goto(url, {waitUntil:'domcontentloaded'})` + `dismissInterstitials(page)` | 14 specs (all but dashboard); 37 total `dismissInterstitials` call sites | every spec's first step; extra mid-flow calls in recipe-nav (4), store-locator (4), cart (11) |
| Armed network anchor: pre-armed `waitForResponse`/`waitForRequest` predicate + `.catch(() => null)` + null-check + explanatory `throw` | 6 specs (~12–18 lines each, ~80 lines total) | `search-autocomplete.spec.ts:34-59`, `meals2go-homepage.spec.ts:44-63`, `meals2go-browse-menu.spec.ts:35-54`, `amore-reservations.spec.ts:34-54`, `nextdoor-reservations.spec.ts:40-62`, cart spec GATE-E (spec:262-295, richer variant with request-seen flag) |
| OpenTable reservation twin: whole-spec duplication, only rid/URL/heading differ | 2 specs, ~60 duplicated lines, with a manual "keep the two in sync" contract (`nextdoor-reservations.spec.ts:9-11`) | amore-reservations ↔ nextdoor-reservations |
| Product quick-view assertion block (dialog locator chain + scoped title/CTA expects) | 2× (~30 lines) | `search-product.spec.ts:74-93` ↔ `shop-category-browse.spec.ts:66-79` |
| Recipe-card locator `getByRole('link').filter({has: getByTestId('img-recipe-card')})` | 3× | `recipe-nav.spec.ts:69-72`, `recipe-search.spec.ts:40-44,50-54` |
| Recipe-detail assertion (`assertLoaded` /recipes/cat/slug pattern + ingredients/directions text) | 2× | `recipe-nav.spec.ts:82-90` ↔ `recipe-search.spec.ts:61-67` |
| `getByRole('link').or(getByRole('button'))` name-regex idiom | 5× | homepage-load:30-33, recipe-nav:28-31,53-56, cart:166-169,199-202 |

### Minimal shared-helper proposal (sized)

One new module, `lib/patterns.ts` (~100 lines), **outside** the vendored
`SHARED-WITH-RUNNER-SPECSHIM` block — see the blocking open question Q1 below:

1. `openPage(page, url)` — goto + dismissInterstitials. Removes 14 duplicated opener
   bodies (~28 lines).
2. `armNetworkSignal(page, {pattern, kind, status?, timeoutMs})` returning
   `{await assertFired(failureMessage)}` — collapses the 6 armed-anchor idioms (~80 → ~15
   lines) and standardizes the request-seen diagnostics the cart spec pioneered
   (spec:253-258) for everyone.
3. `assertProductQuickView(page, {titlePattern?})` — the dialog chain + scoped CTA
   (2 sites, ~30 lines removed); one place to update when Wegmans renames the dialog class.
4. `recipeCard(page)` + `assertRecipeDetail(page)` — 5 sites.
5. `defineOpenTableReservationMonitor({title, url, headingPattern, label})` — a spec
   factory collapsing the twins to two ~10-line files and deleting the manual keep-in-sync
   contract.

Net effect: roughly **−170 lines across specs, +~100-line module**, and — more valuable
than the line count — single-point updates for the three patterns most likely to drift
(interstitials, network anchors, the quick-view dialog).

**Blocker before building this (Q1):** `lib/flow.ts:34-37` documents that the runner
esbuild-aliases *the spec's `lib/flow` import* to its vendored `specShim.ts`, and this repo
copy is "DEAD AT RUNTIME". The repo contains no evidence of how the runner resolves a
*second* `lib/*` import — a new `lib/patterns.ts` might bundle fine or might break every
migrated spec at sync time. Confirm runner-side resolution first (or extend `flow.ts`
outside the hash-gated vendored block, which the parity comment permits — the hash covers
only the `>>>`/`<<<` span).

---

## 4. Secrets / PII sweep

**Clean.** No credentials, tokens, API keys, cookies, customer data, or internal-only URLs
in specs, manifest, config, or scripts. There is no fixtures directory. Specifics
(locations only, per the report contract):

- **Token/key *mentions* (no values):** `search-autocomplete.spec.ts:23-25` describes
  Algolia's public search-only key policy; `meals2go-browse-menu.spec.ts:13-19`,
  `meals2go-homepage.spec.ts:35-36`, `meals2go-cheese-pizza-cart.spec.ts:26-27` document
  the guest-Bearer non-sensitive rationale. No key/token material appears anywhere.
- **`process.env`:** zero references repo-wide — no credential-injection surface exists
  (relevant to §5).
- **Endpoints named in code:** `wegapi.azure-api.net` (public API gateway called by the
  public meals2go frontend — `meals2go-homepage.spec.ts:38`, `meals2go-browse-menu.spec.ts:30`),
  `algolia.net` (`search-autocomplete.spec.ts:27`), `opentable.com` loader with public
  restaurant ids rid=107458/2407 (`amore-reservations.spec.ts:26`,
  `nextdoor-reservations.spec.ts:32`), `synthwatch-dashboard.vercel.app`
  (`dashboard-homepage.spec.ts:19`, `manifest.json:48`). All are URLs any browser visitor
  sees; none are internal.
- **PII-adjacent:** store names/locations in `store-locator.spec.ts:36,48` and the cart
  spec are public storefront facts. No names, emails, addresses, or account data.
- **Identifying-but-intentional:** the synthetic UA advertises the repo URL
  (`playwright.config.ts:22`) — by design ("Identifiable synthetic UA"). Internal
  SynthWatch trace/run ids appear in comments (e.g. `search-product.spec.ts:9`, cart
  spec:15,21) — benign provenance breadcrumbs.
- **Hygiene:** `.gitignore` excludes `test-results/`, `playwright-report/`, `blob-report/`
  — local traces (which *can* embed guest tokens) can't be committed accidentally.

---

## 5. Login-monitor readiness — repo-side only

Scope note honored: **no feasibility claims about Akamai, the IP allowlist, or runner
infra.** This section inventories only what exists in this repo versus what a
login-every-run monitor needs from this repo.

### What exists today

| asset | state | evidence |
|---|---|---|
| Login spec | **does not exist** — no spec touches auth; every monitor is explicitly anonymous | grep for login/sign-in/credential across `monitors/`: comment-only hits |
| Stealth-matrix probe | **not in this repo** — no file or history reference matches; if it exists it lives elsewhere | full-tree + `git log --all` search |
| Credential/config stubs | **none** — zero `process.env` references, no `.env.example`, no fixtures dir, no storageState files | repo-wide grep |
| B10 sensitive machinery (the enable-gate a login monitor will need) | **exists and is CI-enforced** | schema conditional requiring `redact_patterns` when `sensitive:true` (`manifest.schema.json:15-19`), validator hard-gate (`validate-manifest.mjs:43-45`), regex-compile check (`:29-41`) |
| Policy precedent for classifying a login flow | **written down** — "If a future variant ever logs in / carries account or payment data, that variant must be sensitive=true with redact_patterns" | `meals2go-browse-menu.spec.ts:16-19`; same scoping in cart spec:26-27 |
| Flow-modal exclusion mechanism (so `dismissInterstitials` won't close a login modal the spec drives) | exists, but its selector list is login-unaware and lives inside the **hash-gated vendored block** — changing it requires the runner-side parity bump | `lib/flow.ts:34-37,72-74` |
| First-run verification protocol for unverified selectors | documented | `README.md:88-96` |

### Repo-side checklist for when the allowlist lands

1. **Write the login spec** (`monitors/wegmans/<login-journey>.spec.ts`): step-gated
   sign-in → post-auth capability assertion, following the fleet's armed-network-anchor
   pattern (assert the auth endpoint's success response, not chrome — the must-go-red
   discipline every recent spec uses).
2. **Manifest entry with `sensitive: true` + ≥1 `redact_patterns`** — the CI gate already
   refuses to ship it otherwise (`validate-manifest.mjs:43-45`). The patterns themselves
   require live recon of the login network shape, which is blocked until runs are
   sanctioned.
3. **Establish a credential-injection contract** — nothing exists today. Decide and
   document the env-var names the runner will inject (`process.env` is type-available;
   `tsconfig.json` includes node types), and make the spec fail with a *distinct*
   "credentials not configured" error rather than a look-alike site failure.
4. **Decide session policy repo-side:** login-every-run needs no storageState artifacts
   (none exist — consistent with that design); if reuse is ever wanted, storage handling,
   its redaction, and `.gitignore` coverage must be added first.
5. **Extend `FLOW_MODAL_EXCLUDE_SELECTOR`** if the sign-in UI is modal-driven
   (`lib/flow.ts:72-74`), with the vendored-block parity bump on the runner side
   (`lib/flow.ts:34-37`).
6. **Self-clean semantics:** define what, if anything, the logged-in flow mutates and how
   it cleans up — the cart spec's ephemeral-guest rationale (spec:17-24) does **not**
   transfer to an authenticated cart/account, where state persists across runs.
7. **First-run verification pass** per `README.md:88-96` — all login selectors will be
   ★UNVERIFIED by definition until a sanctioned live run.
