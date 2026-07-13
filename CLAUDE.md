# synthwatch-monitors — Claude rules

Rules Claude should follow when working in this repo. This repo holds Playwright monitor
scripts (monitors-as-code) that SynthWatch syncs and runs against production sites
(wegmans.com, meals2go.com, Amore/Next Door). Adding/fixing a monitor is a reviewed PR here.

## Lessons from 2026-07-02

- **Must-go-red is the whole point of a monitor.** Never assert a page-wide `getByText`/`visibleText`
  that matches always-present header/footer/nav chrome — it passes regardless of the journey and can
  never go red (false confidence). Scope every signal to a post-action artifact that is ABSENT on
  failure: an opened `dialog`/detail container, a network-200 gate, or a structural URL pattern.
  *(from #25, #26, #29, #33, #35 — five separate false-positive fixes in one window)*
- **Verify SPA mutations over the network, not the DOM.** For add-to-cart / async actions with no
  reliable UI feedback, assert the mutation API returns 200 with a non-empty body
  (`waitForResponse` on `.../cart-items` POST → `cartItems.length > 0`), not a cart badge/toast.
  *(from #25, #28 — the Angular meals2go cart renders no reliable badge)*
- **Anchor on first-party API responses, and pick the right wait primitive.** Use
  `waitForResponse(...status===200)` when the response is reliably observable headless (Algolia
  `/queries`, wegapi `kitting/.../menus`, `app-config/client/kv` in-browser). Use `waitForRequest`
  when the response errors headless — the OpenTable loader responds `net::ERR_HTTP2_PROTOCOL_ERROR`
  headless, so both reservation specs wait on the request firing. *(from #30/#31 + browse-menu/#35)*
- **Bypass racy autocomplete by navigating directly to the results URL.** Typing + Enter can submit a
  highlighted suggestion instead of the typed text (the "ginger sparkling waterloo" flake); go
  straight to `/shop/search?query=…`. A separate typeahead monitor may type-only and NEVER submit.
  *(from search-product + search-autocomplete #32)*
- **Filter duplicate DOM elements to visible before `.first()`.** Sticky+desktop copies and `sr-only`
  a11y labels create hidden duplicates; clicking one → pointer-intercept/30s timeout. Use
  `.filter({ visible: true })`, scope to a real container, or target by `href`. *(from #19 duplicate
  thin-crust tab id, #26 sr-only span under the sticky header)*
- **Scope a red-test's `page.route` intercept to the API URL pattern ONLY — never the main document.**
  A nav-document intercept starves the deploy-marker capture that rides `page.content()`/main-doc
  headers. Route only the specific backend call to fail. *(from #35 meals2go-homepage red-test; re-applied in the catering red-test)*
- **`*/` inside a `/* */` or JSDoc comment breaks `tsc`.** Never write a regex index path like
  `indexes/*/queries` in a comment — phrase it `indexes/<index>/queries` and keep the real regex in
  code. CI runs `--list` which will catch a parse break, but this fails typecheck first.
  *(from ANALYSIS-monitors-state — banked CI gotcha)*
- **A monitor = a `.spec.ts` under `monitors/` AND a `manifest.json` entry with a unique, never-reused
  `id`.** Run `npm run check` (validate-manifest 1:1 sync + typecheck + `playwright --list`) before
  pushing. Ids are load-bearing (SynthWatch binds config to them) — never repurpose one. *(from README/validate-manifest + every feat PR)*
- **Ship new monitors `enabledByDefault: false` (catalog-only); Craig enables after one verified-clean
  run.** Recon anchors captured from a local/residential IP do NOT prove datacenter-egress
  reachability — Akamai/APIM behave differently by source IP. State that limitation in the PR.
  *(from #30, #40 + the July-2 backbone-api recon)*
- **meals2go monitors are `sensitive=false`.** The pages carry a short-lived guest
  `Authorization: Bearer` on wegapi calls, but it protects nothing (reclassified #34). The kitting
  menus API does NOT require that Bearer — the static `Ocp-Apim-Subscription-Key` alone returns 200.
  Any future variant that logs in or carries account/payment data must be `sensitive=true` +
  `redact_patterns` from the FIRST commit (the manifest gate enforces redact_patterns when sensitive).
  *(from #16, #27, #34 + backbone-api recon)*
- **Recon/probe scaffolding stays in gitignored `scratch/` and never lands in this public repo.** B2C
  login probes and `ANALYSIS-*.md` are gitignored for a reason; a stray `git add -A` must not publish
  them. Once the DOM/network is known, strip the recon harness from the shipped spec
  (behavior-preserving — the cart spec went 918→356 lines). *(from #38, #36)*
- **Assert capability, not a specific item, against sites you don't control.** Click "the first recipe
  card" / "any ginger-sparkling product", assert a `/recipes/<cat>/<slug>` shape + an
  ingredients/directions section — not a named dish or SKU — so catalog reordering is selector-drift,
  not a false outage. *(from #29 + recipe-nav/search resilience notes)*
- **Shared helpers go INSIDE the SHARED-WITH-RUNNER-SPECSHIM markers; a second lib/* module
  (lib/patterns) will NOT resolve at runtime, by design.** The runner esbuild-aliases ONLY the
  spec's `lib/flow` import to its vendored specShim; any other `lib/*` import compiles locally
  but is dead at runtime. To add a shared helper: put it inside the markers in `lib/flow.ts`,
  mirror it into the runner's `specfetch/specShim.ts`, and bump its LIBFLOW-VENDOR-SHA (the
  runner's parity CI enforces this). *(from the 2026-07-04 runner recon session — verbatim)*

## Lessons from 2026-07-13

- **Host-gate matchers must accept the real prod host.** The production Wegmans commerce API is
  `api.digitaldevelopment.wegmans.cloud` (`.cloud`, the Digital team's PRODUCTION APIM — not a dev env)
  and `*.azure-api.net` — a `/(^|\.)wegmans\.com$/`-only gate REJECTS real 200 writes and logs
  `cartWrite=n` (a false negative that blinds the monitor to its own success). Derive host with
  `.hostname`, not `.host` (a `:port` breaks the `$` anchor). Sweep EVERY matcher, not just the one that
  bit. *(from #81, #93)*
- **Never `waitForLoadState('networkidle')` on a Wegmans/ad-heavy page** — persistent
  astutebot/emplifi/LaunchDarkly/Bazaarvoice sockets mean it NEVER idles, so it pays its full timeout on
  every run (a SETTLE, not an assertion; a step whose avg ≫ p50 is this signature). `waitForTimeout` is
  banned fleet-wide. Distinguish a timeout CEILING (free unless hit — keep the 45s token / 60s login /
  20s step / 30s nav) from a SETTLE that pays every run (waste); never "optimize" a ceiling. *(from #82, #96)*
- **An authenticated login gate must assert the real "Hello, <name>" greeting**, not a generic
  `/account|orders|sign ?out/i` affordance that is ALSO present logged-OUT — that false-green shopped
  UNAUTHENTICATED for weeks. The post-login redirect is slow: give the greeting a generous CEILING (60s,
  free unless hit); the token-event `waitForResponse` already proved auth, so a slow paint must not red a
  login that succeeded. *(from #79, #88)*
- **A React/SPA "Add to Cart" click can no-op silently** — correct button, handler not yet wired, or an
  overlay (emplifi chat / cookie banner, NOT covered by `dismissInterstitials`) intercepts the click.
  Assert the mutation (cart-write 200 OR the in-place stepper transform), and ladder click strategies
  (locator → precise-center → raw-pointer → dispatch-events → force), stopping at the first that commits.
  Target the MAIN product buy-box button, not a recommended item's "add to list". *(from #70–#77, #85–#87)*
- **The Wegmans cart app is at `https://www.wegmans.com/cart`.** `/shop/cart` is a dead 231-byte JSON
  shell that mounts no cart route (no ⋮ menu, no line items, no badge) — using it was the root cause of
  the "0-for-3 Empty My Cart". Used by verify-cart-4 and clearCart. *(from #89)*
- **Diagnostics must survive to a PERSISTED channel.** A sensitive monitor's trace keeps ONLY the browser
  console (network + trace zip are stripped for redaction), and Node `console.log` is NOT traced at all.
  Emit diag to the thrown `error_message` AND the page console (`page.evaluate((m) => console.warn(m), …)`),
  never Node stdout alone — or the diagnostic you added never survives the run. *(from #59, #90, #91)*
- **In the fulfillment-scoped cart flow, per-item direct-URL nav (`/shop/product/<id>`) breaks the
  store/session context** established earlier (a changestore PUT + repeated service_options POSTs between
  adds), regressing a 4-add flow to 1 item. Stay IN-CONTEXT: `search (/shop/search?query=…)` +
  select-from-results for every item — do NOT hard-navigate to pinned product URLs. *(from #83 → #84)*
- **A redundant/vestigial step isn't free — its spurious failure triggers expensive failure-only paths.**
  `return-cart` re-checked what verify-cart-4 + the teardown clear already covered, and its mid-checkout
  failure forced the sensitive+FAILED redacted-trace rebuild that OOM'd the runner's finalization
  (stranding the run at `running`). Remove steps that duplicate coverage. *(from #92)*
- **Fleet assertion hazards (a browser verdict is just "the spec didn't throw" — no runner backstop):**
  an http check with `assertions=[]` is status-code-ONLY (the body is never read, so a 200 serving a
  degraded/error body PASSES) — add a `body`/`json_path` assertion; and a monitor at 100% pass over 30
  days paired with a weak assertion is the profile of one that asserts NOTHING (the shop-flow's exact
  profile) — audit it for must-go-red. *(from the 2026-07-12 Fleet Assertion Audit + #94, #95)*
- **Authenticated monitors read creds via `credential(role)`** (model-B, UI-set, live) — a dead ACA-env
  secret reads stale/empty and the flow silently runs unauthenticated. Migrate any hand-rolled or
  env-based cred source to `credential()`, and remove the env fallback so a stale secret can't mask it.
  *(from #64, #65, #66)*
