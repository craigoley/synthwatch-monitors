// check-ci-wiring.mjs — every npm script must actually RUN IN CI.
//
// ★ WHY THIS EXISTS. Three gates (check:clear-cart-gate, check:cart-count-gate, check:cart-identity-gate)
//   were added across #118/#119/#120 to a composite `npm run check` — but .github/workflows/check.yml
//   invoked the individual scripts step-by-step and never called the composite. So the gates looked
//   present in package.json, passed locally, and asserted NOTHING in CI. Measured before the fix:
//   9 of 12 scripts unreachable from CI, including all four red-tests — the behavioural PROOFS for those
//   same gates. Gates dark, proofs dark, everything green.
//
//   That is precisely the class those gates exist to prevent, one level up: a check that looks present
//   and asserts nothing. Wiring the composite fixes the instance. THIS fixes the class — it fails the
//   build the moment a script becomes unreachable again.
//
// HOW: parse package.json's scripts, parse the workflow, compute which scripts CI reaches — directly via
//   `npm run X`, or transitively through a composite that CI does run — and fail on any script that is
//   defined but unreachable.
//
// ★ INTENTIONALLY-LOCAL scripts go in LOCAL_ONLY with a REASON. That list is the honest escape hatch:
//   it must be a deliberate, reviewed statement that a script is not meant to gate, never a place to
//   silence this guard. An empty list is the healthy state.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/check.yml';

/** Scripts deliberately NOT run by CI, each with the reason it is exempt. Keep empty if you can. */
const LOCAL_ONLY = {
  // e.g. 'dev:watch': 'interactive-only; nothing to assert in CI',
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
const wfRaw = readFileSync(join(root, WORKFLOW), 'utf8');

/**
 * ★ COMMENTS ARE STRIPPED BEFORE ANY ANALYSIS, and this is load-bearing in BOTH directions:
 *
 *  • A COMMENTED-OUT step must NOT count as reachable. Otherwise commenting a step out — the most
 *    natural way to disable a gate "temporarily" — leaves this guard reporting everything wired while
 *    nothing runs. That would make the guard actively misleading, which is worse than not having it.
 *  • A comment that merely NAMES a command must not trip the inline-duplication warning. This file's
 *    own header names `npx playwright test --list` while explaining the outage, and the first version
 *    of this guard flagged that prose as a duplication. A warning that fires on documentation is noise,
 *    and noise trains people to ignore the gate.
 *
 * Only full-line `#` comments are stripped: a `#` inside a run: block is usually shell, not YAML.
 */
const wf = wfRaw
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/**
 * The workflow's EXECUTABLE shell only — the contents of `run:` scalars and `run: |` blocks.
 *
 * ★ Scanning the whole YAML is wrong, and wrong in the direction that matters: a step NAMED
 *   "Run the gate suite (composite `npm run check`)" would mark `check` reachable on the strength of
 *   its own label. The first version of this guard did exactly that, and consequently reported 14/14
 *   healthy while the composite step was commented out — a wiring guard that could not detect
 *   un-wiring. Only what CI actually EXECUTES counts as an invocation.
 */
const runBlocks = (yaml) => {
  const lines = yaml.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, indent, rest] = m;
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      // Block scalar: consume the following lines that are indented deeper than the `run:` key.
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== '' && !lines[j].startsWith(indent + ' ')) break;
        out.push(lines[j]);
        i = j;
      }
    } else {
      out.push(rest);
    }
  }
  return out.join('\n');
};

/** `npm run <name>` — the only way a script gets invoked. */
const invocations = (text) => {
  const out = new Set();
  for (const m of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) out.add(m[1]);
  return out;
};

// Reachability = what the workflow invokes, plus everything those composites invoke, transitively.
const wfRun = runBlocks(wf);
const reachable = invocations(wfRun);
const frontier = [...reachable];
while (frontier.length) {
  const s = frontier.pop();
  for (const next of invocations(pkg[s] ?? '')) {
    if (!reachable.has(next)) {
      reachable.add(next);
      frontier.push(next);
    }
  }
}

const errors = [];
const warnings = [];

for (const [name, cmd] of Object.entries(pkg)) {
  if (reachable.has(name)) {
    // ★ Reachable but ALSO duplicated inline in the workflow = a drift trap: the workflow runs its own
    //   copy, so editing the npm script silently changes nothing in CI. Warn — it is not a hole today.
    if (cmd.trim() && wfRun.includes(cmd.trim())) {
      warnings.push(`${name}: its command is ALSO written inline in ${WORKFLOW} — edit one and CI follows the other. Prefer 'npm run ${name}'.`);
    }
    continue;
  }
  if (name in LOCAL_ONLY) continue;
  errors.push(`${name}: defined in package.json but NEVER RUNS IN CI (not invoked by ${WORKFLOW}, directly or via a composite it runs).`);
}

// A LOCAL_ONLY entry that IS reachable is stale bookkeeping — say so rather than letting the list rot.
for (const name of Object.keys(LOCAL_ONLY)) {
  if (!(name in pkg)) warnings.push(`LOCAL_ONLY lists '${name}', which no longer exists in package.json — remove it.`);
  else if (reachable.has(name)) warnings.push(`LOCAL_ONLY lists '${name}', but CI does run it — remove the exemption.`);
}

for (const w of warnings) console.warn(`  warning: ${w}`);

if (errors.length) {
  console.error(`ci-wiring gate FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\nFix: invoke it from the composite \`check\` (or \`redtest\`) in package.json, which ${WORKFLOW} runs —`);
  console.error(`or, if it genuinely must not gate, add it to LOCAL_ONLY in this file WITH A REASON.`);
  process.exit(1);
}

const n = Object.keys(pkg).length;
const exempt = Object.keys(LOCAL_ONLY).length;
console.log(`ci-wiring gate OK: ${n - exempt}/${n} npm scripts are reachable from ${WORKFLOW}${exempt ? ` (${exempt} exempt)` : ''}.`);
