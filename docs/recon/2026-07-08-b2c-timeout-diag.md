# Recon — b2c-login-test timeout OTHER (run #915902) has no OTHER-DIAG + determinism read — 2026-07-08

**Two consecutive sandbox OTHER runs, different signatures:**
- #915736 (14:28): `OUTCOME=OTHER` "token event observed but no post-login anchor rendered" — motivated #57.
- #915902 (14:50): `OUTCOME=OTHER` "no terminal signal within 45s (timeout)" — the #57 OTHER-DIAG line did
  **not** appear in its output.

Establish why OTHER-DIAG is absent, instrument the timeout branch, and read determinism honestly.
Repos: `synthwatch-monitors` (spec) + `synthwatch` (trace_signals). Branched from `origin/main` @ `f8749f8`.
Evidence contract: cite `file:line`; OBSERVED vs INFERRED separated.

---

## STEP 1 — why no OTHER-DIAG on #915902 (two reasons; reason B is definitive)

### Reason B — the timeout branch was never instrumented (OBSERVED, code-provable, decisive)

The #57 capture is gated to the **token-but-no-anchor branch only**. On `origin/main` (pre-this-PR):

- `captureTokenNoAnchorDiag(...)` is called in exactly one place — the completed-branch anchor-timeout catch
  (`b2c-login-test.spec.ts:284`), and `verdict.diag` is only set there (`:288`).
- The `timeoutSentinel` returns `{ code: 'OTHER', detail: 'no terminal signal within 45s (timeout)' }` with
  **no `diag`** (`:310-313`).
- The final emitter is `if (verdict.diag) console.log('… OTHER-DIAG …')` (`:475`).

**So a `timeout-no-terminal-signal` OTHER carries no `diag` → OTHER-DIAG never emits for it, regardless of
deploy state.** #915902's signature is exactly that branch (no token event fired). This alone explains the
absence and is the gap → STEP 2.

### Reason A — deploy timing (indeterminate from static analysis; secondary)

- **OBSERVED:** #57 merged to main at **2026-07-08T18:48:36Z** (`gh pr view 57 → mergedAt`; merge commit
  `f8749f8`). Run #915902 was at 14:50 → **18:50 UTC** if the run clock is ET (UTC-4), i.e. only **~1.4 min
  after the merge**. (If the run clock were UTC, #915902 at 14:50 UTC would be ~4 h *before* the merge, and
  #57 was simply not deployed — an even simpler answer.)
- **OBSERVED (mechanism):** the runner has no long spec-cache TTL — each run does a conditional GET
  (`If-None-Match: <commit-SHA etag>`) against the spec on main and recompiles on a 200
  (`runner/specfetch/specCache.ts:131-190`, `getCompiledSpec`). So a run that starts after the merge
  propagates picks up #57 on that run; a run within seconds of the merge may still 304 to the pre-#57
  compile.
- **NOT determinable here:** whether #915902 actually executed the #57 spec. The authoritative signal is the
  run's `spec_provenance.executed_sha256` / `resolved_etag` / `cache_fetched_at` (`runs.spec_provenance`,
  migration 0047; written before execution) — a **prod DB read** I did not perform from this analysis
  session (and shouldn't). Compare `executed_sha256` to #57's compiled-spec hash to settle it.

**Bottom line for STEP 1:** reason **B is definitive** — even a fully-deployed #57 would not have emitted
OTHER-DIAG for a timeout. Reason A may compound it (the merge was ~1–2 min before the run) but doesn't need
resolving: the fix is the same either way → instrument the timeout branch.

---

## STEP 2 — instrument the timeout branch (built here)

Generalized the #57 capture into one shared, redaction-safe `captureStructuralDiag(page, situation, opts)`
used by **both** OTHER branches, and wired it into the `timeoutSentinel` catch so a timeout now sets
`verdict.diag` → the existing emitter prints `[b2c-login-test] OTHER-DIAG {…}` for it too.

Added two probes tuned to a stuck-at-a-wall timeout (a timeout with no token event is more consistent with
an interstitial/hang than the token-but-no-anchor case):

- `challengePresent` — a late/partial Akamai/challenge interstitial (`getByText(/access denied|pardon the
  interruption|reference #|unusual traffic|verify you are (a )?human|…|checking your browser/i)`).
- `spinnerPresent` — a stuck loading state (`[role="progressbar"], [aria-busy="true"], [class*="spinner" i],
  [class*="loading" i]`).

A timeout now emits, e.g.:

```
[b2c-login-test] OTHER-DIAG {
  "situation": "timeout-no-terminal-signal",
  "finalUrl": "<host/path>",
  "anchorsTried": ["awaited: akamai-block | token-event+post-login-anchor | otp/phone | creds-error (none fired in budget)"],
  "found": { "signInFormPresent": …, "b2cErrorPresent": …, "otpPresent": …, "challengePresent": …,
             "spinnerPresent": …, "accountAffordance": …, "navRegionPresent": …, "counts": {…},
             "visibleControls": ["Sign In", "‹control›", …] },
  "likelyCause": "stuck loading (spinner up at the budget …) | never advanced past the sign-in form … | stuck at an Akamai/challenge interstitial … | …"
}
```

`likelyCause` maps the stuck state to an action: spinner → backend hang; sign-in form still up → submit
didn't take / no token; challenge → intermittent bot wall (widen `blockByDom`); B2C error / OTP present but
unmatched → widen those matchers; else blank/partial (read `finalUrl` + `visibleControls`).

### Redaction — preserved and confirmed (sensitive=true; audit-#219 invariants)

Same guarantees as #57, verified for the new fields: URLs via `safeLoc()` (host+path, drops token-bearing
query/fragment); labels via `safeLabel()` (greetings → `‹greeting›`, unknown → `‹control›`, known nav labels
pass); the new `challengePresent`/`spinnerPresent` are **booleans** from `getByText`/CSS-class probes — no
raw text emitted; **no `page.content()`, no `inputValue()`, no cred/token ever logged** (audited: the only
two `console.log`s remain the non-secret OUTCOME line and the PII-filtered OTHER-DIAG line). Runner redactor
is the backstop.

**Verified (no live run):** `npm run check` green — ajv manifest (#44, 18/17 bound), matcher allowlist (#46;
**no new matchers**), typecheck, `playwright --list`.

---

## STEP 3 — determinism: an honest read (not a theory)

**What the two runs differ on (OBSERVED):** #915736 reached a **token event** (`isTokenEvent` — a B2C token
endpoint 200 / code-redirect / SelfAsserted-confirmed) then missed the post-login anchor; #915902 reached
**no terminal signal at all** in 45 s (no block, no token, no OTP, no creds-error). So the material
difference is upstream: #915902 **never got a token**.

**What is OBSERVABLE now:**
- The spec is **deterministic in code** — identical logic and identical 45 s classify budget for both runs
  (`classify(page, 45_000)`); no config/timeout difference between them. So the divergence is in the
  **site/network behavior**, not the spec.
- **Client-side session is NOT reused across runs** — the runner creates a fresh `browser.newContext()` per
  run (`runner/index.ts` executeBrowser), so cookies/storage don't carry over. Any between-run effect would
  have to be **server-side** (the B2C account's state after #915736 obtained a token) or **environmental**
  (B2C/Akamai latency/load), not client session reuse.

**What the evidence supports (and what it does NOT):** two runs with two signatures are consistent with
EITHER (a) genuine run-to-run **non-determinism** in the B2C/Akamai flow (variable latency; an intermittent
pre-token hang or bot-wall), OR (b) a **between-run effect** (server-side account state after the first
token, or transient backend slowness). **Two data points cannot distinguish these**, and I will not build a
login-flow theory from them. Notably I also could not retrieve the surviving `trace_signals` for either run
(prod DB; not queried here), so the "what was #915902 stuck on" question is genuinely unanswered by existing
telemetry — which is the whole reason for STEP 2.

**What the instrumented re-run settles:** once STEP 2 is deployed, the next timeout's OTHER-DIAG shows the
stuck state directly. Repeated over a few fires it distinguishes the hypotheses:
- consistently `signInFormPresent` at timeout → the submit/interaction never advances (not the site being
  slow) — a spec/interaction bug;
- consistently `spinnerPresent` / a specific `finalUrl` → a backend hang at a known step;
- `challengePresent` sometimes → an intermittent bot wall (`blockByDom` too narrow or the challenge is late);
- signatures that **vary run-to-run with no single stuck state** → genuine non-determinism (variable latency)
  — then the fix is budget/retry tuning, not a selector.

---

## Output summary

- **Deploy state of #57:** merged to main 18:48:36 UTC (~1–2 min before run #915902 if the run clock is ET);
  whether #915902 executed the #57 compile is indeterminate from static analysis (needs
  `runs.spec_provenance.executed_sha256`). **Moot for the symptom:** #57's OTHER-DIAG is token-but-no-anchor
  only, so a timeout never emits it regardless — that's the gap.
- **Timeout-branch instrumentation:** built — a shared redaction-safe `captureStructuralDiag` now fires on
  the timeout OTHER too, adding `challengePresent`/`spinnerPresent` to show what it was stuck on.
- **Determinism:** unresolved by two runs and un-retrievable from existing trace_signals; the code is
  deterministic and client session isn't reused, so the divergence is site/network-side. The instrumented
  re-run (deploy + re-fire) is what settles hang-vs-wall-vs-nondeterministic — stated, not theorized.
