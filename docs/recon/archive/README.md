# docs/recon/archive — HISTORICAL INVESTIGATIONS (not current truth)

★ **These are dated records of one-time recon/diagnosis sessions — NOT authoritative, NOT
current state.** Each is stamped with the date and the `origin/main` SHA it was branched from.
Read them as history (why a decision was made, how a bug was diagnosed), never as the way things
work today.

★ **Their durable lessons have already been promoted to `CLAUDE.md`** (the repo's live,
code-adjacent rules) — nothing is lost by archiving them:

| lesson | now lives in |
|---|---|
| the single-file spec fetch (a new shared module won't compile in the runner) | `CLAUDE.md` (SHARED-WITH-RUNNER-SPECSHIM) + `README.md` "Adding a monitor" |
| `OTHER-DIAG` must go to a persisted channel — Node `console.log` is not traced | `CLAUDE.md` (diagnostics-survive rule) |
| host gates must accept the real prod host (`.cloud`/`azure-api.net`), not `.com`-only | `CLAUDE.md` (host-gate rule) |
| must-go-red — assert an artifact ABSENT on failure, never chrome | `CLAUDE.md` (must-go-red rule) |

If you're onboarding: read **`CLAUDE.md`** and **`README.md`**, not this folder.

_Verified 2026-07-14 — NO AUTOMATED CHECK. Distrust any of these files if the code disagrees._

## Contents
- `2026-07-07-codescan.md` — code-scanning backlog triage
- `2026-07-07-monitors.md` — monitors analysis backlog
- `2026-07-07-url-env-inference.md` — derive `environment` from a check's URL? (design input)
- `2026-07-08-b2c-other-diagnosis.md` — b2c-login OUTCOME=OTHER (run #915736) diagnosis
- `2026-07-08-b2c-timeout-diag.md` — b2c-login timeout OTHER (run #915902) diagnosis
- `2026-07-08-browser-redtest-anchor.md` — the red-test route-block anchor mechanism (D1-v2)
- `2026-07-08-otherdiag-not-surviving.md` — why OTHER-DIAG never reached `trace_signals.console`
