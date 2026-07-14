# Recon — b2c-login-test OUTCOME=OTHER (run #915736) diagnosis + telemetry fix — 2026-07-08

**Run:** b2c-login-test sandbox run #915736 (Jul 8 14:28) → `OUTCOME=OTHER`, detail *"token event observed
but no post-login anchor rendered (partial/aborted login)."* Akamai CLEARED (header applied, not
bot-blocked). A token was acquired; the spec's post-login anchor didn't render. Two candidate causes:
(1) stale/wrong post-login anchor **selector** (login worked → spec fix), (2) login genuinely **aborts**
post-token (redirect/interstitial/partial session → real finding).

Repos: `synthwatch-monitors` (the spec) + `synthwatch` (runner trace capture). Branched from `origin/main`
@ `71fdbc1`. Evidence contract: every claim cites `file:line`; OBSERVED vs INFERRED separated.

---

## STEP 1 — read what exists, then adjudicate

### 1a. How sensitive-monitor traces are stored — and what is (isn't) recoverable

**OBSERVED — a sensitive monitor persists NO DOM snapshot / screenshot / trace zip.** b2c is
`sensitive: true` (`manifest.json`), and the runner's B10 path:

- `const persist = tracePersistPlan(sensitive, status)` — a function of `sensitive` + `status`, **not**
  `sandbox` (`runner/index.ts:~576`). So a sandbox run does **not** re-enable trace persistence.
- Sensitive ⇒ **screenshot NEVER stored** (`index.ts:~581-583`, "a rendered page shows … logged-in PII")
  and **NO raw trace zip** — "a sensitive monitor stores NO raw trace zip — neither the per-run failure
  zip nor the permanent success-trace baseline (both carry the full session-bearing DOM/network)"
  (`index.ts:~607-611`; migration `0046_sensitive_trace_redaction.sql`; `db/schema.sql:90-91`).
- The **only** thing kept is redacted `trace_signals` = network requests (`url`/`method`/`status`) +
  console messages (`messageType`/`text`), scrubbed by the monitor's redactor. `runner/traceSignals.ts`
  has **no DOM/snapshot field** (interfaces `TraceRequest`, `Mutation`, `ConsoleMessage`, `NetworkSummary`
  — network + console only).

**So the task's premise — "b2c is sensitive so the trace has DOM snapshots but redacted secrets" — is
FALSE, and that falseness IS the gap.** For run #915736 the recoverable evidence is only: the redacted
network URLs + the console line `[b2c-login-test] OUTCOME=OTHER :: token event observed but no post-login
anchor rendered …` (and a genericised `error_message`). No DOM, no screenshot, no rendered final page.

*(I did not query the live prod DB for #915736's row from this analysis session — it's prod, and it isn't
needed: the quoted OTHER detail is byte-for-byte the spec's static string (1b), which proves the run
captured nothing richer than that string.)*

### 1b. What the spec's post-login anchor waits for, and what it captured on miss

**OBSERVED** (`monitors/wegmans/b2c-login-test.spec.ts`, pre-fix):

- The "logged-in" anchor (`:183-186`): a **visible** `link` OR `button` whose accessible name matches
  `/sign ?out|log ?out|my account/i` (link) or `/sign ?out|log ?out|account|hi,? /i` (button), waited for
  15 s after the token event (`:188`).
- On miss, the OTHER branch returned a **static string only** (`:190-192`):
  `{ code: 'OTHER', detail: 'token event observed but no post-login anchor rendered (partial/aborted login)' }`
  — **no final URL, no DOM, no elements-seen, no token-event detail.**

**What the trace shows was actually on the page instead: UNKNOWN.** There is no DOM snapshot (1a), and the
spec recorded nothing beyond the static string.

### 1c. ★ Adjudication

**The evidence is TOO THIN to adjudicate cause 1 vs cause 2 — the telemetry gap is confirmed.** Both causes
produce the identical recoverable signature: *token event seen → 15 s anchor wait times out → the same
static OTHER string.* Distinguishing them needs to know **what rendered after the token** — a logged-in
page whose account affordance falls outside the anchor regex (cause 1: e.g. an icon-only account button, a
"Welcome"/greeting control, or a label like "My Wegmans" the regex misses), **versus** a sign-in bounce /
B2C error / off-domain redirect / blank partial page (cause 2). None of that is recoverable:

- No DOM snapshot / screenshot (sensitive, 1a).
- The spec captured no URL / elements / token detail (1b).
- `trace_signals` network URLs *might* weakly hint at a post-token redirect, but cannot show whether a
  logged-in affordance rendered under a different selector — so they cannot separate the two causes.

→ **STEP 1 cannot adjudicate from existing telemetry → build STEP 2. STEP 3 (corrected selector) does NOT
apply** — the login's success is unproven, so proposing a selector change would be a guess. (INFERRED
prior, not load-bearing: the anchor regex is moderately broad but role-restricted to visible link/button;
a real logged-in affordance outside it is entirely plausible — but unproven, hence the capture.)

---

## STEP 2 — close the telemetry gap (built here)

**Change:** on the token-but-no-anchor OTHER branch, the spec now captures a **redaction-safe structural
diagnostic** and emits it as one JSON console line (`[b2c-login-test] OTHER-DIAG {…}`) → lands in
`trace_signals.console` (the only channel that survives for a sensitive monitor), runner-redacted.

**What a future OTHER now says** (instead of just "no anchor rendered):

```
[b2c-login-test] OTHER-DIAG {
  "situation": "token-but-no-anchor",
  "finalUrl": "<host/path — query/fragment dropped>",
  "tokenEvent": "<host/path of the token response>",
  "anchorsTried": ["link|button name~/sign out|log out|my account|account|hi,/i"],
  "found": {
    "signInFormPresent": false, "b2cErrorPresent": false, "otpPresent": false,
    "accountAffordance": true, "navRegionPresent": true,
    "counts": { "links": N, "buttons": M, "forms": F, "inputs": I },
    "visibleControls": ["Account", "Orders", "Sign Out", "‹greeting›", "‹control›"]
  },
  "likelyCause": "cause-1 (logged-in chrome present under a different label → stale anchor selector) | cause-2 (bounced to sign-in / B2C error → real partial-login) | undetermined"
}
```

This directly discriminates the two causes: `signInFormPresent || b2cErrorPresent` ⇒ **cause 2**;
`accountAffordance` present with no sign-in form ⇒ **cause 1** (and `visibleControls` names the actual
label to fix the selector to). Implemented in `captureTokenNoAnchorDiag()` + wired into the completed
branch's anchor-timeout catch + the final reporter.

### ★ Redaction — the new capture honors sensitive=true (CONFIRMED)

Every field is safe **by construction**, within the audit-#219 invariant (DOM structure + URL + selector
names OK; secret/account values not):

- **URLs** (`finalUrl`, `tokenEvent`) go through `safeLoc()` → `host + pathname` only, **dropping the
  query/fragment** where `id_token`/`code`/`access_token` live. No token value.
- **`anchorsTried`** is a static selector string; **`found` booleans/counts** are structural.
- **`visibleControls`** passes every label through `safeLabel()`: a **greeting** (which carries the
  account holder's name — PII the runner redactor does NOT scrub, since its declared patterns are
  token/session-only) → `‹greeting›`; a known nav label (UI chrome, not PII) → passes; anything else →
  `‹control›`. So **no name/PII** is emitted.
- **No `page.content()`, no `inputValue()`, no username/password/token variable is ever logged** (audited:
  the only two `console.log`s are the non-secret OUTCOME line and this PII-filtered OTHER-DIAG line; the
  bypass token only ever rides a request header).
- The runner redactor (`makeRedactor(check.redact_patterns)`) remains the backstop over the console line.

**Verified (no live run):** `npm run check` green — ajv manifest (#44, 18/17 bound), matcher allowlist
(#46; no new matchers — the capture uses `page`/`Locator` methods only), typecheck, `playwright --list`
(spec parses). Redaction audit above.

---

## STEP 3 — corrected anchor: N/A (not adjudicated)

Not proposed. STEP 1 could not prove the login succeeded, so a selector change would be a guess. Once the
next on-demand run emits `OTHER-DIAG`, the `likelyCause` + `visibleControls` will say whether it is a stale
selector (cause 1 → then the corrected anchor is whatever `visibleControls` reveals) or a real partial
login (cause 2 → a genuine finding, not a spec bug).

## Output summary

- **Adjudicated cause:** UNADJUDICABLE from existing telemetry — the trace is too thin (sensitive ⇒ no DOM
  snapshot/screenshot; the spec's OTHER branch captured only a static string). The telemetry gap is the
  finding.
- **Telemetry improvement:** the token-but-no-anchor OTHER branch now captures a redaction-safe structural
  diagnostic (final URL, token-event host/path, anchors tried, what rendered instead + a cause hint),
  emitted to `trace_signals.console`. The next run self-diagnoses.
- **Corrected selector:** deferred until the enriched diagnostic proves cause 1.
- **Redaction:** preserved and confirmed (safeLoc URLs, PII-filtered labels, no raw DOM/values; runner
  redactor backstop).
