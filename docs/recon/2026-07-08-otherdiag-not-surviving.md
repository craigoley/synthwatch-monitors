# Recon — why OTHER-DIAG never reaches trace_signals.console + the SignalR signal — 2026-07-08

Three b2c-login-test OTHER runs (915736 / 915902 / 916069; SPEC-INTEGRITY SHAs 21b28da3 / 8ec56ae2 /
8b66bc92) — the OTHER-DIAG block from #57/#58 appears in **none** of their persisted
`trace_signals.console`. The console shows only site error/warning noise + `droppedInfoLog: 192`. Find why
the diag isn't surviving, fix it, and assess the SignalR signal (without asserting causation).

Repos: `synthwatch-monitors` (spec) + `synthwatch` (trace_signals capture). Branched from `origin/main` @
`1695324`. Evidence contract: cite `file:line`; OBSERVED vs INFERRED separated; premises verified, not
assumed.

---

## STEP 1 — why no OTHER-DIAG in trace_signals.console

### 1.1 Deploy state (indeterminate from here — and MOOT, given 1.2)

- The three values are **not git commit SHAs** — `git cat-file -t 21b28da3|8ec56ae2|8b66bc92` → "Not a
  valid object name". They are each run's **`executed_sha256`** (the sha256 of the *compiled* spec JS, the
  SPEC-INTEGRITY line; `runs.spec_provenance.executed_sha256`, migration 0047).
- Timeline (OBSERVED): #57 merged `2026-07-08T18:48:36Z`, #58 merged `2026-07-08T19:06:32Z`. The runs at
  14:28 / 14:50 (ET = 18:28 / 18:50 UTC) place 915736 **before** #57 (consistent with the task's note that
  21b28da3 = pre-#57) and 915902 ~1.4 min after the #57 merge (before #58). 916069's timestamp wasn't
  given.
- **Not determinable from static analysis:** which spec version each `executed_sha256` corresponds to —
  that needs reproducing the runner's exact esbuild compile of each historical spec and hashing (not
  reproducible here), or reading `spec_provenance` and comparing to the #57/#58 compiled hash (a prod DB
  read I did not do).
- **Why it's moot:** even a run that executed the newest post-#57/#58 spec could **not** have emitted
  OTHER-DIAG into `trace_signals.console` — see 1.2. So the deploy question doesn't need resolving; the
  survival bug dominates it.

### 1.2 ★ Root cause: the spec's `console.log` is NODE-side and never enters the trace at all

The task's hypothesis (emitted at info level → dropped by the sensitive-console filter) is *close* but the
mechanism is deeper. Two facts, both OBSERVED:

1. **`trace_signals.console` is extracted from BROWSER-PAGE console events only.** `extractConsole`
   (`runner/traceSignals.ts:237-280`) walks the Playwright **trace zip** for `root.type === 'console'`
   events — i.e. page console messages captured by `context.tracing`. It then keeps only
   `level === 'error' || 'warning'` and counts the rest as `droppedInfoLog` (`:256-257`). The SignalR
   errors and the "192 dropped info logs" are the **commerce SPA's own page console** — NOT the spec's.
2. **The spec's `console.log(...)` runs in the runner's NODE process, not the page.** The spec fn is
   invoked as `specToFlow(tests[0].fn, page)` in-process (`runner/index.ts:1011`); a bare `console.log` is
   a Node call to runner stdout. Playwright tracing does **not** record Node console. Confirmed there is
   **no Node→page console bridge**: no `page.on('console')` forwarder anywhere (`metrics.ts`/
   `browserMarker.ts` only use `page.on('response')`); no console override in `specShim.ts`.

**Therefore the OTHER-DIAG (and the OUTCOME line) never enter the trace, so they can NEVER appear in
`trace_signals.console` at any level.** A mere `console.log → console.warn` change *in Node* would not help
— the level filter never even sees a Node log. This also means #57/#58 were built on an unverified premise
("a spec `console.log` lands in trace_signals.console"). That premise is false; this is the survival bug.

**Second premise correction:** `trace_signals.console` is **not** the only persisted channel for a
sensitive monitor. `runs.error_message` also survives, redacted — `scrubError` (`runner/redact.ts`) applies
the redactor and **keeps the readable, scrubbed text**, only falling back to a generic placeholder if
nothing survives (`hasDiagnostic` check). It is applied for both `fail` and `error` status
(`index.ts` sensitive branch). So the thrown Error's text persists (redacted) in `error_message`.

### 1.3 The fix (this PR) — write the diag to channels that actually persist

The diag now goes to **both** persisted+redacted channels (plus Node stdout for local deep-dives), all
carrying only redaction-safe content:

- **`trace_signals.console`** — emit a COMPACT copy INTO THE PAGE console:
  `await page.evaluate((m) => console.warn(m), verdict.diagCompact)`. That is a real browser console event
  at **`warning`** level → captured by tracing → kept by `extractConsole` → persists. The compact is
  ≤195 chars so the `text.slice(0,200)` cap (`traceSignals.ts`) does not truncate it.
- **`runs.error_message`** — the COMPACT diag rides the thrown Error, so `scrubError` keeps it (a TEXT
  column, no 200-char cap; the most robust channel, no runner change needed).
- **Node stdout** — the FULL JSON via `console.log` (unchanged) for runner/local logs.

The compact carries the discriminating fields that settle the question:
`[b2c OTHER-DIAG] tok-no-anchor url=<host/path> f=acct1sgn0err0chal0spin0otp0nav1 c=[My Account,…] cause1-stale-selector`
— the `acct` bit (account-affordance present) + `sgn` (sign-in form present) + `url` + `causeCode` are
exactly what distinguishes stale-selector from real-abort.

**Redaction preserved + confirmed** (sensitive=true): the compact is `safeLoc` URL (host/path, drops
token-bearing query) + boolean flags + `safeLabel`-filtered control names + a static causeCode — no
`page.content()`, no input values, no cred/token. `page.evaluate` passes only that compact string into the
page. The runner redactor scrubs both persisted channels as the backstop.

**Verified (no live run):** `npm run check` green — ajv manifest (#44, 18/17 bound), matcher allowlist
(#46; no new matchers — `page.evaluate`/`console.warn` are not matchers), typecheck, `playwright --list`.
Compact worst-case length = 184 ≤ 195.

*(Alternative considered — a RUNNER-side fix: capture the spec's Node console during execution, or exempt a
prefix in `extractConsole`. Rejected as heavier + cross-repo: the spec-side page-emit + error_message write
is self-contained in this repo, needs no runner deploy, and works with the existing filter.)*

---

## STEP 2 — the SignalR signal (assessed; causation NOT claimed)

**OBSERVABLE (every run):** the commerce app's real-time order hub fails consistently —
`wss://commerce-signalr-azsrs-prod.service.signalr.net/client/?hub=orders` → "Failed to start the
connection: … WebSockets failed" + "hooks:useOrdersSignalRService Error connecting SignalR". Repeatable
across all three runs (these are **page** console errors, which is why they survive into
`trace_signals.console` while our Node logs did not — corroborating 1.2).

**Is it plausibly causal for the missing post-login anchor?** Two hypotheses, and console errors **cannot**
decide between them:

- **Plausibly causal** — IF the post-login page's account affordance renders inside a component subtree
  that awaits the orders SignalR connection (e.g. an account/orders widget that suspends until the hub
  connects), then a hard SignalR failure could block that subtree from rendering → the anchor never
  appears → a real finding (SignalR failure blocks the post-login render on the preview env).
- **Plausibly incidental** — SignalR order-hub failures are common background noise on many storefronts;
  the account/nav chrome usually renders independently of the orders realtime hub. Then the anchor renders
  fine and the OTHER is a **selector** problem, with SignalR just concurrent noise.

**★ You cannot confirm causation from console errors alone.** What's OBSERVABLE is only "SignalR fails
every run." Whether the post-login **anchor's component tree depends on it** is NOT observable from the
console — it needs the DOM state at the failure moment, which is exactly what the fixed OTHER-DIAG now
captures. **Do not declare SignalR the root cause.**

**What the fixed diag settles (one re-fire, after deploy):**
- `acct=1` (account affordance present) despite the SignalR failure → SignalR is **incidental**; it's a
  **selector** problem (and `c=[…]` names the real label to fix the anchor to).
- `acct=0` with `sgn=0`/no error, on a logged-in URL, SignalR failing → consistent with **SignalR blocking
  the post-login render** → a real finding to pursue (does the account subtree await the orders hub?).
- `sgn=1` (bounced to sign-in) or `spin=1` (stuck loading) → a different story again (real partial login /
  hang), independent of the anchor-selector question.

---

## Output summary

- **Why OTHER-DIAG didn't survive:** not a level-drop of the spec's log — the spec's `console.log` is
  **Node-side and never enters the browser trace**, so it can't reach `trace_signals.console` at any level
  (the "192 dropped info logs" are the SPA's own page logs). Deploy state of the 3 runs is indeterminate
  from here and moot given this.
- **Fix:** write the (compact, redaction-safe) diag to channels that actually persist — a PAGE-console
  `console.warn` (→ `trace_signals.console`, ≤195 chars) and the thrown Error (→ redacted
  `runs.error_message`). Verified green; redaction preserved.
- **SignalR:** OBSERVABLE = it fails every run; NOT observable from console = whether the anchor's subtree
  depends on it. Not declared root cause. The fixed diag's `acct` boolean + `url` settle
  incidental-selector vs SignalR-blocks-render on one re-fire.
