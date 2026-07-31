# Why the gates exist — `craigoley/synthwatch-monitors`

**This file exists to stop a new team deleting the CI gates as friction.**

Only 2 workflows here, and a single required check called **`Check`** — but that one job carries seven
steps, and this repo has a property the others do not:

> ★ **The code in this repo is EXECUTED BY THE RUNNER IN PRODUCTION, at runner privilege, against
> authenticated Wegmans sessions.** A merged spec runs live within minutes. There is no deploy step to
> catch anything in between.

That is why the gates here are about **what will happen at runtime in a different repo**, not about style.

Companion: the runner's
[`GATES.md`](https://github.com/craigoley/synthwatch/blob/main/docs/handover/GATES.md).

---

## ⚠️ Read this first — three gates exist but DO NOT RUN IN CI

`package.json` defines a composite `npm run check` that includes three monitor-correctness gates:

```
check:clear-cart-gate · check:cart-count-gate · check:cart-identity-gate
```

**`.github/workflows/check.yml` does not call `npm run check`.** It invokes the individual scripts
(`validate:manifest`, `check:matchers`, `typecheck`, `playwright test --list`) step by step, so the three
gates above **never execute in CI**. Verified against the latest run: **zero** gate lines in the log.

This was introduced across PRs #118 / #119 / #120 — they were added to the composite script on the
assumption that CI ran it. **They currently protect a local `npm run check` only.**

**Fix (one line, not done here because this change is documentation-only):** add a step to `check.yml`
running the three gates — or replace the individual steps with `npm run check`, taking care that the
matcher gate still receives its live `SHIM_SOURCE`.

★ **Until that lands, treat the cart gates as unenforced.** This is the exact class the gates themselves
exist to prevent — a check that looks present and asserts nothing — so it is recorded here rather than
quietly fixed.

---

## How to read the ranking

| Rank | Meaning | Safe to disable under pressure? |
|---|---|---|
| **P0 — LOAD-BEARING** | Removing it re-opens a specific, dated incident. | **No.** |
| **P1 — LOAD-BEARING** | Guards a class that has bitten, but quieter. | Only with a named owner. |
| **P2 — NICE-TO-HAVE** | Recoverable, visible failure. | Yes, temporarily. |

**Branch protection here differs from the other three repos:** required status check = **`Check`**, and
**required approving reviews = 1**. This is the only repo that needs a human approval — appropriate,
given that merging runs code in production.

---

## The gates — all inside the single `Check` job

### 1. `CI shell-safety gate (no fail-open pipe-into-grep)` — **P1**

**Asserts:** no fail-open SIGPIPE antipattern in shell / workflow `run:` blocks.

**The bug (five instances org-wide; shellcheck and actionlint miss it):** a producer piped into an
early-closing consumer under `pipefail` — `printf … | grep -q P`, `cmd | head -N`. The producer takes
**SIGPIPE (141)**, `pipefail` propagates it, and a guard built on that exit **inverts** — a match reads as
"no match", flipping BLOCK→PASS. **Input-size-dependent:** passes every small-input test, fails only in
prod on a large input. Bit the runner at #155, #279, #283.

---

### 2. `Validate manifest (JSON schema via ajv + registry ⇄ scripts in sync)` — **P0**

**Asserts:** `manifest.json` validates against its schema; every manifest entry's `script` file exists;
every spec file has a manifest entry (**no orphans**); ids are unique.

**And the B10 enable gate:** a monitor marked `sensitive: true` **must declare `redact_patterns`**. A
sensitive-but-unwired entry is rejected here so it can never reconcile into the fleet.

**What went wrong:** reconcile is Git-authoritative — the manifest *is* the fleet's configuration. An
orphan spec is invisible to the platform; a manifest entry with no file breaks sync; and a `sensitive`
monitor without redaction would persist credentialed traces unscrubbed.

**Relaxing it:** no. It is the contract between this repo and the runner's reconcile.

---

### 3. `Fetch runner shim (live source of truth)` + 4. `Matcher allowlist + banned-pattern gate` — **P0**

**Asserts:** no spec uses an `expect()` matcher that the runner's `specShim.ts` does not implement.

**Why it is the sharpest gate in this repo.** Specs are authored against `lib/flow.ts` and run locally
with **real Playwright** — where every matcher works. In production the runner compiles them against a
**mini-shim** implementing only `SUPPORTED_MATCHERS`. So an unsupported matcher:

- **passes** `npx playwright test` locally,
- **passes** typecheck,
- and throws a `TypeError` **in a live production run**.

The gate fetches `specShim.ts` from runner `main` **live** so the allowlist cannot drift from the shim.
There is a committed snapshot fallback for local runs, which prints a loud warning and is deliberately
*restrictive* — never allow-all. **In CI a fetch or parse failure HARD-FAILS the job** rather than
silently falling back.

**Related, from the same class (runner #349):** the sandbox preview once died at
`Could not resolve "@playwright/test"` because only `../../lib/flow` was ever routed to the shim. The
lesson recorded there — *"a preview that compiles differently than production is a preview that lies"* —
is the same principle this gate enforces for matchers.

**Relaxing it:** never.

---

### 5. `Typecheck` — **P1**

`tsc --noEmit` over specs and `lib/`. Catches the ordinary errors; note it **cannot** catch the shim
divergence above, which is why gate 4 exists separately.

---

### 6. `Compile-check scripts (every spec parses + lists)` — **P0**

**Asserts:** `playwright test --list` — every spec parses and registers as a valid test.

**What went wrong:** a spec that fails to parse is not a failing monitor — it is a monitor that **does not
exist**, silently. Two real instances are in this repo's history: `test.describe is not a function` and
`test.step is not a function` (runs 994014 / 994195, 2026-07-17), where check 396's specs compiled against
the wrong surface and the check errored on every run without ever reaching the site.

**Relaxing it:** no — it is the difference between a red monitor and an absent one.

---

### 7. The three cart-correctness gates — **P1 · CURRENTLY NOT WIRED (see the warning above)**

Each guards a defect that made a monitor **wrong while green**. All three have must-go-red proofs.

| Gate | Asserts | The incident |
|---|---|---|
| `check:clear-cart-gate` | `baseline-clear-cart` cannot report "empty" without a positive, mounted-cart proof | The step was **359 pass / 0 fail — it had never failed**, because it short-circuited on an unwaited header-badge `0` (a pre-hydration read) and returned OK having navigated nothing and verified nothing: 966 ms against the teardown's 52 s. A step that cannot fail protects nothing. |
| `check:cart-count-gate` | selectors are exact-token scoped; the aria-label is the primary count signal; `null ≠ 0` | `li[class*="item"]` matched every nav `<li>` carrying Tailwind `tw:items-center` (**288×** in the failing trace), and `[class*="cart"] [class*="count"]` matched `cart-item-count` — a per-row **quantity stepper** — returning it as the cart's count. The aria-label was correct throughout; the asserted number was wrong for **34 consecutive runs**. |
| `check:cart-identity-gate` | `verify-cart-4` asserts SKU **identity** off the cart API, gates on render, and names no untested cause | The old assertion counted to 4 and never read an item, so a leftover could satisfy the threshold and a boosted-merchandise hijack could pass with the **wrong product** in the cart. Its failure text also blamed *"baseline clear-cart did not empty leftover items"* — a cause it never tested — which misdirected the whole diagnosis toward cart accumulation while the real defect was a selector. |

★ The last row is the one to internalise: **a failure message that names an untested cause is itself a
defect.** It cost a full diagnostic cycle. The gate now bans those three phrases outright.

**Companion red-tests** (`npm run redtest:*`) drive real Chromium against local fixtures and are the
behavioural proof; the gates are the cheap static invariants. Neither runs in CI today.

---

### `Auto-merge (trusted authors)` — **ORCHESTRATION**

Never blocking.

---

## ★ Holding a PR open

```bash
gh workflow disable "Auto-merge" -R craigoley/synthwatch-monitors
# …then re-enable…
```

**This repo has no `Claude review` workflow**, so the 15-minute `ci-gate` stall described in the other
repos' `GATES.md` **does not apply here** — there is no `ci-gate`, only `Check`.

**But it is also the hardest repo to force a merge in**, because branch protection requires **1 approving
review**. An agent cannot self-approve. If a PR here is green and unmerged, that is usually why — see
`gh api repos/craigoley/synthwatch-monitors/pulls/<n> --jq .mergeable_state` returning `blocked`.

Re-arm paths: `auto-merge.yml` on `pull_request: [opened, synchronize, reopened, ready_for_review]` — **any
new commit re-arms it** — plus a manual `gh pr merge --auto`.
**`gh pr view --json autoMergeRequest` is point-in-time, not durable.**

---

## What is safe to relax under real pressure

1. **`Typecheck`** (P1) — the compile-check still proves specs parse.
2. Nothing else.

**Never:** `Validate manifest`, the matcher gate (steps 3+4), `Compile-check scripts`.

The matcher gate is the one a new team will most want to remove — it fetches a file from another repo on
every run and can fail for network reasons. Removing it means an unsupported matcher passes local tests,
passes typecheck, merges, and throws in a **live authenticated production run**. Fix the fetch; do not
remove the gate.
