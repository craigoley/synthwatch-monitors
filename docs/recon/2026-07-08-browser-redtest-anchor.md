# Recon — browser red-test anchor mechanism (D1-v2 PR2 unblock) — 2026-07-08

**Task:** the scheduled red-test sweep (D1-v2 PR2) covers only 8/33 monitors (the http ones) because the
17 browser monitors need a per-monitor "route-block anchor" that isn't synthesizable today (#210). Scope
the anchor MECHANISM concretely so the browser-coverage build is ready. **Analysis only — do NOT build.**

**Repos:** `synthwatch-monitors` (the specs) + `synthwatch` (the runner red-test harness). Branched from
`origin/main` @ `338c51d`.

## Evidence contract

Every claim cites `file:line` / pasted output. **OBSERVED** vs **INFERRED** separated. The load-bearing
question — "does route-block prove red?" — is answered against the actual classifier + the actual spec
idioms, not assumed.

---

## TL;DR — the decision

**The browser red-test EXECUTION harness already exists** (`runBrowserRedTest`, `runner/redTest.ts`) and
uses the *same* `context.route` primitive as the S2 host-rewrite (`index.ts:~907`). So "is a browser
red-test just `route.abort()` the critical request?" — **yes, and it's already coded.** What is missing
(#210) is not the harness but the **per-monitor anchor**, and recon shows it is *two coupled gaps*:

1. **No sweep-readable SOURCE for the route-block pattern.** The manual CLI takes `--fault=route-block:<pattern>`
   from a human (`redTestMain.ts:parseFault`); a human-less scheduled sweep has nowhere to read it.
2. **The classifier credits ONLY an `ExpectationError` as red — and all 8 network-anchored specs raise
   their must-go-red gate with a *plain* `throw new Error`, which classifies as `'error'` →
   INCONCLUSIVE, not red.** So route-block on today's specs would NOT prove red for them without a small
   spec-contract fix.

**Coverage reality (corrects the "17 of 25" hope):** route-block cleanly unblocks the **8 network-anchored
monitors** (their anchor pattern already lives in-spec; add a declared source + a gate→`expect()` fix);
a **subset of the 9 DOM-anchored** monitors is unblockable *only* with a per-spec declared sub-resource
anchor; and a residue of **SSR/static-DOM specs has no blockable route at all** → they need a different
fault kind (selector-fail / assertion-inversion, not built) or the existing attested-manual tier.
`ssl/dns/tcp/ping` have **no fault path** and should stay out-of-scope-by-design.

---

## 1. How the http red-test synthesizes a fault, and what a browser monitor actually needs

**OBSERVED — the fault taxonomy** (`runner/redTest.ts`, the `Fault` type):

```ts
export type Fault =
  | { kind: 'bad-url'; url: string }        // HTTP: re-run with target_url pointed at a known-bad url
  | { kind: 'route-block'; pattern: string }; // browser: abort the anchor request the assertion depends on
```

- **HTTP (`runHttpRedTest`, redTest.ts):** `run({ ...check, target_url: fault.url })` — swap `target_url`
  for a known-bad url, keep the monitor's OWN assertions. **Fully synthesizable**: the fault needs no
  per-monitor input — every http check gets the same treatment (point target at a wrong url). That is why
  8/8 http monitors are auto-red-testable.
- **Why browser can't reuse it:** a browser monitor's assertion isn't "the target url returned expected
  content" — it is a *journey* (`page.goto` → interact → assert a post-action artifact). Re-pointing
  `target_url` doesn't inject a deterministic, assertion-specific fault; the spec drives its own
  navigation. So browser needs a fault that breaks *the specific thing the monitor asserts on*.

**OBSERVED — what a browser monitor must do to prove the alert fires.** The honesty classifier
(`redTest.ts classifyRedTest`) is strict:

| run verdict after the fault | outcome | meaning |
|---|---|---|
| `fail` (an **`ExpectationError`** was thrown) | **red** | the monitor's own assertion fired → red-test PASSED |
| `pass` | not-red | assertion too weak to notice the fault (the #25/#26 bug) |
| `error` / `infra_error` (any *non*-ExpectationError throw: Playwright timeout, nav crash, `throw new Error`, spec-load) | **inconclusive** | an unrelated failure — never reported as red |

And what makes a throw an `ExpectationError` is decided in the shim (`specShim.ts:156-161`, `errors.ts:24-33`):
a spec's `expect(locator).toBeVisible()` / `.toBe()` **miss** is re-thrown as `ExpectationError` (→ red),
but a **bare `throw new Error(...)`** or a **raw awaited `waitForResponse` timeout** is a generic error
(→ inconclusive).

> **So the precise requirement:** the injected fault must make the monitor's **own `expect(...)` matcher
> miss** (an `ExpectationError`). Not crash the nav (that's `error`), not trip a bare `throw new Error`
> gate (that's `error`). "Block a critical route" works **only if** the blocked route makes an `expect()`
> assertion fail — otherwise it's inconclusive.

---

## 2. Is a browser red-test derivable from the existing route machinery?

### 2a. The primitive and the harness both already exist — OBSERVED

- **Same route machinery as host-rewrite.** `executeBrowser` intercepts every request with
  `await context.route('**/*', …)` for header-injection + S2 origin-rewrite (`index.ts:~907`;
  `resolveRewrite` → `route.continue({ url })`, `hostRewrite.ts`). 
- **The red-test harness is built on that same primitive.** `runBrowserRedTest` (`redTest.ts`) does exactly
  the "abort the critical request" idea:

  ```ts
  const context = await browser.newContext();
  await context.route(fault.pattern, (route) => route.abort()); // ★ the fault
  … await specToFlow(tests[0].fn, page)(rec); …
  verdict = isExpectationError(err) ? 'fail' : 'error';          // ★ the honesty split
  ```

  It fetches the real compiled spec, aborts `fault.pattern`, runs the monitor's real flow, and maps an
  `ExpectationError` → red. **So the answer to "is a browser red-test just `route.abort()` the critical
  request?" is YES — and it is already coded.** No harness to build.

### 2b. …but two coupled gaps make it non-synthesizable *today* — OBSERVED

**Gap A — no sweep-readable pattern source.** `runBrowserRedTest` *requires* `fault.pattern`. The only
producer is the CLI flag `--fault=route-block:<pattern>` typed by a human (`redTestMain.ts:parseFault`).
A scheduled sweep with no human has no per-monitor source of the pattern. (HTTP has none of this problem —
`bad-url` is the same synthetic url for every check.) **This is the core of #210.**

**Gap B — the current specs' must-go-red gate throws a *plain* Error → inconclusive, not red.** All 8
network-anchored specs use the idiom "await the anchor, catch to null, then `throw new Error` if null":

```ts
// monitors/wegmans/meals2go-browse-menu.spec.ts:36-49 (representative; identical shape in all 8)
const resp = await page.waitForResponse((r) => MENUS_API.test(r.url()) && r.status() === 200, {…})
  .catch(() => null);            // MENUS_API = /wegapi\.azure-api\.net\/kitting\/.*\/menus/i  (:30)
…
if (!resp) { throw new Error('GATE: kitting menus API did not return 200 …'); }  // ← PLAIN Error
…
await expect(itemCards.first(), '…').toBeVisible({ timeout: 15000 });            // ← the ExpectationError
```

If the sweep route-blocks `MENUS_API`, `resp` is `null` → the **`throw new Error` fires first** →
`isExpectationError` is false → verdict `error` → **INCONCLUSIVE**. The downstream `toBeVisible` (which
*would* be an `ExpectationError`, since the item cards also come from that API) is never reached. Same
shape verified in `search-autocomplete.spec.ts:35-55` (`ALGOLIA_QUERIES`), `meals2go-homepage.spec.ts:45-57`
(`BOOTSTRAP_API`), `amore-reservations.spec.ts:35-48` (`OPENTABLE_LOADER`), and by mirror in
`meals2go-catering-browse`, `nextdoor-reservations`, `meals2go-cheese-pizza-cart` (`/cart-items`).

> **The spec-contract fix (behavior-preserving):** raise the anchor gate through the shim's `expect`
> instead of a bare throw — `expect(resp, 'GATE: kitting menus API did not fire …').toBeTruthy()`
> (`toBeTruthy`/`toBeNull` are in the shim's `SUPPORTED_MATCHERS`). On a real missing anchor it still reds
> exactly as before; but now the miss is an `ExpectationError`, so a route-block classifies as **red**.
> This is a small, mechanical change to 8 specs and is arguably better hygiene regardless.

### 2c. Is the pattern *derivable* from the spec? — mostly, for the 8; not for the DOM specs

For the 8 network-anchored specs the anchor is already a named constant *in the spec* (the `waitForResponse`
predicate): `MENUS_API`, `CATERING_MENUS_API`, `BOOTSTRAP_API`, `ALGOLIA_QUERIES`, `OPENTABLE_LOADER`,
`/cart-items/`. That regex **is** the route-block pattern. The 9 DOM-anchored specs
(`homepage-load`, `recipe-nav`, `recipe-search`, `search-product`, `shop-category-browse`, `store-locator`,
`nextdoor-homepage`, `amore-menu`, `dashboard-homepage`) have **no network gate** — they assert
`toHaveURL` + `getByText(...).toBeVisible()` on the rendered page (`lib/flow.ts assertLoaded`). Some render
the asserted text from an XHR whose block *would* fail `toBeVisible` (e.g. `search-product`'s product
title, `shop-category-browse`, `recipe-*`); others assert **SSR/static** content (`nextdoor-homepage`'s
server-rendered location links, `amore-menu`'s static PDF `href`, `homepage-load`/`dashboard-homepage`
chrome) where **no single blockable request** changes the assertion. Those cannot be route-block-red-tested
at all.

---

## 3. Smallest mechanism, ranked — and the coverage it buys

**The mechanism = a per-monitor declared red-test anchor (a URL-pattern string) fed to the existing
`runBrowserRedTest(route-block, pattern)`, PLUS the spec-contract that the must-go-red gate raises via
`expect()`.** Ranked options for *where the pattern comes from*:

| # | option | drift-safety | covers | plumbing | verdict |
|---|---|---|---|---|---|
| **1** | **`checks.redtest_anchor` column, declared in `manifest.json`, reconcile-plumbed** (mirror the exact #216 `rewrite_from_origin` field-split: manifest key → GIT_AUTHORITATIVE column → the sweep reads it off the check row) | author keeps it in sync | **all** kinds (network + declared-DOM) uniformly; sweep already does `loadCheck` | migration + reconcile field + manifest.schema.json field + ajv mirror | **RECOMMENDED — the universal, sweep-readable source; smallest new surface that unblocks the whole class** |
| 2 | **Spec-exported constant** (`export const RED_TEST_ANCHOR = MENUS_API.source`) read from the already-fetched compiled module in `runBrowserRedTest` | best (co-located with the `waitForResponse` that uses it — cannot drift) | only specs that *have* such a const (the 8) | specShim surfaces the export; harness reads it | **Enhancer** — pair with #1 for the 8 network specs to avoid duplicating the regex in the manifest |
| 3 | Parse the spec *source* for the `waitForResponse` regex | fragile | 8 | none | **Rejected** — regex-in-source parsing is brittle (multiple predicates; the `*/`-in-comment class of CI gotcha) |
| 4 | Convention: block the target's own API subdomain / deepest XHR | none | unreliable | none | **Rejected** — blunt; would also starve the doc / third parties |

**Recommended build (v1):** Option 1 (declared `redtest_anchor`) as the source of record + the
**spec-contract** (gate → `expect().toBeTruthy()`); optionally Option 2 later to eliminate duplication for
network specs.

### Coverage this buys (of the 17 browser monitors)

- **Tier A — route-block-red-testable now, ~8 monitors** (the network-anchored: `meals2go-browse-menu`,
  `meals2go-catering-browse`, `meals2go-homepage`, `meals2go-cheese-pizza-cart`, `search-autocomplete`,
  `amore-reservations`, `nextdoor-reservations`). Anchor pattern already in-spec; needs the declared source
  + the gate→`expect()` fix. **Clean, deterministic red.**
- **Tier B — route-block-red-testable with a per-spec declared sub-resource anchor, a SUBSET of the 9 DOM
  specs** (`search-product`, `shop-category-browse`, `recipe-nav`, `recipe-search` — where the asserted
  visible text comes from a blockable XHR). Needs one-time per-spec recon to identify the anchor; then the
  same mechanism applies. Not free, but declarable.
- **Tier C — NOT route-block-able** (`homepage-load`, `dashboard-homepage`, `store-locator`,
  `nextdoor-homepage`, `amore-menu` — SSR/static-DOM assertions with no single blockable request). These
  need a **new fault kind** (`selector-fail` / assertion-inversion — e.g. block the JS bundle so the
  asserted element never renders, or fulfill the anchor with 200-but-empty) which does **not** exist today,
  or the already-built **attested-manual** tier (`recordAttested`, the weaker proof).
- **`b2c-login-test`** is an on-demand InfoSec *classifier instrument* (green only on `COMPLETED`; disabled),
  not a health monitor — exclude from the auto-sweep.

So route-block honestly unblocks **~8 immediately** and **up to ~12** with per-spec declared anchors — not
a blanket 17. The remaining ~3–5 SSR/static specs are the real residue for a future fault kind or attestation.

### Q3 flag — ssl/dns/tcp/ping have NO fault path (out-of-scope-by-design)

The `Fault` union is `bad-url | route-block` only. `ssl` (cert), `dns` (record), `tcp`/`ping`, and
`multistep` — the remaining `33 − 8 http − 17 browser = 8` monitors — have **no fault variant**. A
`bad-url`-style "bad-target" could technically be synthesized (an expired-cert host for ssl, an NXDOMAIN
for dns) but it would test infra reachability, not a rich assertion, and these checks' assertions are thin.
**Recommend: ssl/dns/tcp/ping stay out-of-scope-by-design for the auto red-test sweep**; the scorecard
should render them `not-applicable` (a distinct state from `not-red`/`inconclusive`) so their absence isn't
read as a coverage failure.

---

## What this makes build-ready (for D1-v2 PR2)

1. **Runner:** add a `checks.redtest_anchor text` column + reconcile field-split (mirror #216
   `rewrite_from_origin`); the scheduled sweep, for a `kind='browser'` check with a non-null
   `redtest_anchor`, calls the *existing* `runBrowserRedTest(check, { kind: 'route-block', pattern:
   check.redtest_anchor })`. No harness code — it's built.
2. **Monitors (this repo):** (a) add `redtest_anchor` to `manifest.schema.json` (optional string) and
   declare it on the 8 network-anchored entries (the value is the existing anchor regex source); (b) the
   **spec-contract fix** — convert the 8 specs' `if (!resp) throw new Error(...)` gates to
   `expect(resp, '…').toBeTruthy()` so a blocked anchor classifies as red, not inconclusive.
3. **Scope Tier B** (declared DOM anchors) as a follow-up (per-spec recon) and Tier C (SSR/static) as
   needing a new `selector-fail` fault or attestation — do NOT block PR2 on them.
4. **ssl/dns/tcp/ping:** render `not-applicable`, out-of-scope-by-design.

**Caveat (INFERRED):** the Tier-B "which XHR to block" per DOM spec is not verified here (it needs a live
recon pass per spec from the allowlisted egress); Tier A's anchors are OBSERVED in-spec. The spec-contract
fix's redness is INFERRED from the classifier + shim semantics (`specShim.ts:156-161`, `redTest.ts
classifyRedTest`) — verifiable by running `runBrowserRedTest` against one converted spec once PR2 lands.
