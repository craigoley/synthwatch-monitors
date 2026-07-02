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
