# Runbook — `wegmans-full-shop-flow` first-fire validation — ★ ARCHIVED (HISTORICAL)

> ★ **VALIDATION COMPLETE — HISTORICAL (as of 2026-07-09). This is a record of a one-time
> validation phase that is OVER.** `wegmans-full-shop-flow` (check `id=355`) is now
> **enabled, scheduled, and passing** — the 8 net-new steps below were validated and the
> `NET-NEW` markers resolved (#101). **This runbook no longer describes current state.**
> ★ For the monitor's **LIVE** status (enabled / interval / recent runs) go to the
> **dashboard**, never this doc — a hand-typed DB snapshot rots the moment the DB moves
> (this one did: it said `enabled=false, interval=900`; reality is `enabled=t, interval=1800`).
> Kept for the validation *narrative* (the diagnose-from-`OTHER-DIAG` loop), not its state.
>
> _Verified 2026-07-09 — NO AUTOMATED CHECK. Distrust any state claim here if the DB disagrees._

**Monitor (at validation time):** `wegmans-full-shop-flow` (check `id=355`, `sensitive=true`).
**Goal (then):** drive the 8 net-new UNVERIFIED selector steps to green + clean teardown across several
on-demand sandbox fires, correcting each selector from `OTHER-DIAG` evidence, BEFORE the monitor is ever
scheduled.

**Why this runbook exists:** the shop-flow spec (#61) reuses live-proven selectors for login/search/diag but
authors 8 net-new authenticated selectors that could NOT be live-verified during authoring (no test creds
in a Claude session, Akamai IP-block, personal-session risk). Each failing step self-emits a redacted
structural diagnostic; this runbook is the loop that turns that diagnostic into corrected selectors.

**Do NOT run monitors from a workstation/Claude session** — validation fires are **sandbox on-demand runs
triggered by the platform** against the allowlisted egress. This doc is SELECT-only + trigger instructions;
it executes nothing against live Wegmans.

---

## Live state — NOT in this doc (deleted on purpose)

★ A hand-typed DB snapshot lived here and rotted (it claimed `enabled=false, interval=900`; reality moved
to `enabled=t, interval=1800`). It is **deleted, not updated** — mirroring live state in prose with no gate
just re-arms the same fuse. For the monitor's current `enabled` / `interval` / `check_locations` / recent
runs, read the **dashboard** (or `SELECT … FROM checks WHERE source_key='wegmans-full-shop-flow'`), which is
the source of truth. (A doc-build step could *generate* this table from the DB — see the audit; until then,
there is deliberately no state table here to go stale.)

---

## STEP 0 — set the runner secrets (MANDATORY; the current blocker)

The first fire proved the flow dies at `requireSecret('SHOP_TEST_USER')` before reaching any net-new
selector. Set these ACA-job secrets (same path as the B2C secrets), then every fire can actually reach the
browser flow:

- `SHOP_TEST_USER`, `SHOP_TEST_PASS` — the shared test-account credentials the spec reads.
- `VERCEL_BYPASS_TOKEN` — the flow injects it host-scoped on `myaccount.wegmans.com` (login redirect).

**Falsifier that STEP 0 worked:** the next sandbox fire's `error_message` no longer contains
`required secret env … not set`; it progresses to `[full-shop-flow] STEP-FAIL <step> …` (a real step).

---

## STEP 1 — confirm materialized + disabled (already true; re-verify before each cycle)

```
source ~/.synthwatch.env
psql "$DATABASE_URL" -c "SELECT id, enabled, sensitive, interval_seconds FROM checks WHERE source_key='wegmans-full-shop-flow';"
```
Expect `enabled=f`. **It must stay disabled through the entire validation loop** — a scheduled run against
unverified teardown selectors could leave a dirty cart. Do not flip `enabled` until the go/no-go gate.

---

## STEP 2 — fire ONE on-demand sandbox run (platform-triggered)

Trigger a sandbox run of `wegmans-full-shop-flow` from the dashboard/API "Run now" against the allowlisted
egress (a sandbox run is single-attempt — `#230` — so you read the TRUE first-attempt state, no warmed
retry masking). One run per cycle; read it fully before the next.

---

## STEP 3 — read the latest run's diagnostic

For a sensitive monitor the raw trace zip + screenshots are NOT persisted — the diag lives in **two**
redacted channels: `runs.error_message` (always) and `runs.trace_signals->'console'` (the page-console
`OTHER-DIAG`, present once the flow reaches the browser). Read both:

```
source ~/.synthwatch.env
psql "$DATABASE_URL" -x -c "SELECT status, retry_count, sandbox, started_at, error_message FROM runs WHERE check_id=(SELECT id FROM checks WHERE source_key='wegmans-full-shop-flow') ORDER BY started_at DESC LIMIT 1;"
psql "$DATABASE_URL" -c "SELECT jsonb_pretty(trace_signals->'console') FROM runs WHERE check_id=(SELECT id FROM checks WHERE source_key='wegmans-full-shop-flow') ORDER BY started_at DESC LIMIT 1;"
```

The funnel is the step name in the message: `[full-shop-flow] STEP-FAIL <step> url=<host/path>
f=li…sgn…cart…chk…ful…slot…oos… c=[<PII-filtered controls>] …`. That names **which** step broke, the URL it
was on, structural booleans, and the visible control labels.

**Reading the flags** (`f=…` in the compact diag): `li`=loggedIn, `sgn`=signInFormPresent, `cart`=cartPresent,
`chk`=checkoutPresent, `ful`=fulfillmentModalPresent, `slot`=timeslotPresent, `oos`=itemUnavailable. `1`=present,
`0`=absent. `c=[…]` are visible link/button labels, PII-filtered (`‹greeting›`/`‹control›` mask account
names/unknown labels).

---

## STEP 4 — map the diag to the corrected selector

Per-step selector map with **how far the diag alone gets you** (from recon 2026-07-09):

| # | step | current selector (`monitors/wegmans/full-shop-flow.spec.ts`) | correct-from-diag? |
|---|---|---|---|
| 1 | **add-to-cart** | `getByRole('button', /add to cart/).or(button[class*="add"][class*="cart"])`; pickup fallback `/pickup/` | **Diag-fixable** — `c=[…]` surfaces the real add/pickup label; `ful=1` means a fulfillment modal intercepted |
| 2 | **verify-cart-4** | `[class*="cart-item" i], [data-testid*="cart-item" i], li[class*="item" i]` count ≥4 | ★ **Needs live DOM** — `cart=1` confirms the cart rendered, but the exact line-item class/testid isn't in the diag; prefer wiring a cart **network anchor** (mirror `meals2go-cheese-pizza-cart`'s cart-items API assertion) once the cart API is seen in `trace_signals->'network'` |
| 3 | **checkout-pickup** | `getByRole('button', /checkout\|proceed/)` then `/pickup/` (button/radio/text) | **Diag-fixable** — `chk`/`ful` booleans + `c=[…]` labels |
| 4 | **timeslots-render** | `[class*="timeslot" i], [class*="time-slot" i], [data-testid*="slot" i]` OR `getByRole('button', /\d{1,2}(:\d{2})?\s?(am\|pm)/)` count ≥1 | ★ **Partly needs live DOM** — `slot=1` confirms presence; the `am/pm`-name role path is diag-hintable, but the container class/testid needs a DOM read |
| 5 | **select-slot** | same slot locator `.first().click()` + place-order guard (never clicks place-order) | **Follows #4** — once the slot selector is right, this is the same locator |
| 6 | **return-cart** | `/shop/cart` + `[class*="cart" i], [data-testid*="cart" i]` present | **Needs live DOM** for the exact container, but low-risk (presence-only; `cart` boolean already confirms it) |
| 7 | **clear-cart** (teardown) | remove loop `getByRole('button', /^remove$\|remove item\|delete item/)` + bulk `/clear cart\|empty cart\|remove all/`; **asserts empty → RED on dirty** | **Diag-fixable** — the remove/clear labels surface in `c=[…]`; the assert-empty makes a bad teardown go red, not silent |
| 8 | **logout** (teardown) | `loggedInAffordance` menu → `getByRole(link/button/menuitem, /sign ?out\|log ?out/)` | **Diag-fixable** — affordance is the proven `LOGGED_IN_AFFORDANCE_RX`; the sign-out label surfaces in `c=[…]` |

**Bottom line:** ~5–6 steps (add-to-cart, checkout-pickup, select-slot-once-#4-lands, clear-cart, logout)
are correctable from diag evidence alone; **~2–3 class/`data-testid` structural selectors (verify-cart-4,
timeslots-render container, return-cart container) likely need a live DOM read** from an allowlisted /
test-account authoring session — the diag confirms the element is *present* but not its exact selector. For
`verify-cart-4`, the strongest fix is a **cart network anchor** (read the cart API URL from
`trace_signals->'network'` on a fire that reaches the cart, then assert it like the meals2go cart spec)
rather than a DOM count.

Apply the corrected selector as a normal monitors PR (Craig merges). It re-materializes as a `changed`
drift → apply (see Q1 findings for the reconcile path).

---

## STEP 5 — re-fire and loop

Repeat STEP 2→4 until the run advances past the fixed step to the NEXT `STEP-FAIL`, then fix that one.
Order matches the funnel: login → add-milk/eggs/bread/bananas → verify-cart-4 → checkout-pickup →
timeslots-render → select-slot → return-cart → clear-cart → logout. **A green run means all 8 net-new steps
passed AND teardown left the cart empty** (clear-cart asserts empty; a dirty cart goes red, so green ⇒
clean teardown).

---

## GO / NO-GO gate for scheduling

Do **NOT** set `enabled=true` / wire cron until ALL of:

1. **All 8 net-new steps green** across **several** (≥3) consecutive on-demand fires — not one lucky pass.
2. **Clean teardown every time** — `clear-cart` reaches empty (no `… item(s) remain — teardown incomplete`
   in `error_message`); no fire leaves a full cart / live session for the next.
3. **Region posture corrected** — drop `westus2` from `check_locations` for `id=355` so only
   `eastus2 + centralus` remain (the recorded posture); currently all 3 are assigned:
   ```
   psql "$DATABASE_URL" -c "SELECT check_id, location FROM check_locations WHERE check_id=355;"
   ```
4. **Both regions offset-fire with no collision** — with `eastus2 :00/:30` + `centralus :15/:45` (the
   dashboard-owned offset cron) plus the spec's `RUN_CAP_MS` guard, fire both regions and confirm they
   never mutate the shared account concurrently (no run corrupts another's cart).
5. **Craig sets the final cadence/region posture** — this is a heavy authenticated browser flow; cadence +
   region count drive cost. Interval `900s` is declared but the cron/regions are dashboard-owned.

Only then flip `enabled=true`.

---

## #230 note (already discharged)

The shop-flow's first sandbox fire (`status=error, sandbox=t, retry_count=1`) is the post-`#230` sandbox
FAILURE that empirically proves the no-retry guard fires (single attempt on failure, not 3). No action —
just be aware every validation fire is single-attempt, so the diag you read is the TRUE first-attempt state.
