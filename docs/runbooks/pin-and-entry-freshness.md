# Pin & entry freshness — `synthwatch-monitors`

> _Verified 2026-07-14 — NO AUTOMATED CHECK. This consolidates policy that also lives in the spec
> headers + failure messages (the load-bearing source of truth). **Distrust this doc if a spec
> disagrees** — the spec header/constant/failure-message is authoritative, not this consolidation._

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

