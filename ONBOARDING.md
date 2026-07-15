# Onboarding — `synthwatch-monitors`

> _2026-07-15 · prose with **no automated check**. This doc **points**; it does not copy. If a doc and the code
> disagree, the code wins and the gate proves it._

## 1. What this repo is

The **monitor specs**: Playwright `*.spec.ts` files + a `manifest.json` registry. The runner **fetches these
at `main`'s HEAD commit SHA** and runs them — this repo holds *what* to check; the runner holds *how* to run
it. Its place in the 4-repo system + the handover plan:
**[TRANSITION.md](https://github.com/craigoley/synthwatch/blob/main/TRANSITION.md)** (in the runner repo).

## 2. First hour (from a clean clone)

No container — a small Node repo:

```bash
git clone https://github.com/craigoley/synthwatch-monitors && cd synthwatch-monitors
npm install
npm run check     # = validate:manifest (ajv) + check:matchers + typecheck + test:compile (playwright --list)
```

Then: add/edit a spec + its manifest entry → branch → push → **open a PR** → `check` goes green →
**auto-merges** (`auto-merge.yml`) → the runner picks it up on its next tick.

## 3. ★ The one thing that will bite you day one

**A spec must be a SINGLE FILE — it cannot import a shared module.** Read the landmine box at the top of the
README's **[Adding a monitor](README.md#adding-a-monitor)** section (*"the one thing that breaks production on
day one"*). The runner esbuild-compiles each spec with exactly one allowed import (`lib/flow`); a spec that
imports anything else **will not compile and the monitor never runs**. That single-file constraint is also a
**security control** (see the runner's `SECURITY.md` execution boundary).

## 4. How a change reaches prod (different here — merge IS the deploy)

- **There is no build/deploy pipeline.** A spec reaches prod by **merging to `main`**: the runner fetches
  `main`'s HEAD SHA on its next tick and runs the new spec. So **the merge gate IS the admission control**.
- **CI gate** (`.github/workflows/check.yml`, required): `validate:manifest`, `check:matchers`, `typecheck`,
  `test:compile`. Nothing runs in prod that didn't pass these — which is *why* the matcher allowlist is a
  security control, not a style rule.
- **★ Roll back:** this is the **cleanest rollback in the fleet** — **`git revert` the spec commit and merge.**
  The runner fetches the new HEAD next tick; there is no image to roll, no DB to worry about. (Still: nobody
  has *rehearsed* it — treat as **DRAFT · UNREHEARSED** per
  [OUTSTANDING.md](https://github.com/craigoley/synthwatch/blob/main/docs/handover/OUTSTANDING.md).)

## 5. Where the gated truth lives

*If a doc and the code disagree, the code wins and the gate proves it.*

- **[`manifest.schema.json`](manifest.schema.json)** — the manifest contract, enforced by `validate:manifest`
  (ajv) + registry-↔-scripts sync.
- **The matcher allowlist** — `check:matchers` fetches the runner's `lib/flow` `SUPPORTED_MATCHERS` **live** as
  the source of truth, so a spec can't use a matcher the shim doesn't implement (and the runner↔monitors
  `lib/flow` parity is gated in the runner repo).
- **The single-file / `lib/flow`-only constraint** — enforced at compile time by the runner's esbuild alias
  (`runner/specfetch/compileSpec.ts`); documented in the runner's `SECURITY.md`.

## 6. Who to ask

Post-handover: **[Wegmans monitor-authors owner — see the RACI](https://github.com/craigoley/synthwatch/blob/main/docs/handover/RACI.md)**,
**not Craig**. During the 30/60/90 shadow, Craig is on-call-for-questions only.
