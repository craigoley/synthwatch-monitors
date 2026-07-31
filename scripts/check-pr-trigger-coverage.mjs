// check-pr-trigger-coverage.mjs — a gate workflow must run on EVERY pull request, not just main-based ones.
//
// ★ WHY THIS EXISTS. check.yml carried `pull_request: branches: [main]`, so a PR targeting a NON-main base
//   — a stacked PR — got no gate job at all. The PR page showed one check, "Auto-merge (trusted authors):
//   skipping", which reads to a reviewer as "CI ran, nothing to do". Nothing had run. Observed on #124.
//
//   `main` requires the `Check` context plus a review, so nothing reached `main` ungated; the hole was the
//   INTERMEDIATE hop, where a stacked PR is reviewed and merged into its base with no run of its own. The
//   damage is to REVIEW, not to `main`: a reviewer trusts a page that asserted nothing.
//
//   That is the same class as #123 — a check that looks present and asserts nothing — one level up. #123
//   fixed gates that were defined but never invoked; this fixes gates that are invoked but never triggered.
//   Wiring reachability (check-ci-wiring.mjs) and TRIGGER reachability are different holes, and a workflow
//   can pass the first while failing the second.
//
// HOW: parse every workflow, and for each one that runs gate work on `pull_request`, require that its
//   trigger carry no base-branch filter. `push: branches: [main]` is untouched and correct — a post-merge
//   sweep genuinely only concerns `main`.
//
// ★ EXEMPT lists workflows that legitimately scope themselves to a main base, each WITH A REASON. An
//   exemption must be a deliberate reviewed statement, never a way to silence this guard.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = '.github/workflows';

/**
 * Workflows allowed to keep a base-branch filter on `pull_request`, each with the reason. EMPTY is the
 * healthy state, and it is currently empty — that is a finding, not an oversight.
 *
 * The obvious candidate was auto-merge.yml: it is not a gate, it MERGES, and auto-merging a stacked PR
 * into its base would skip the review its base PR still owes. But it already scopes itself the RIGHT way
 * — `if: github.event.pull_request.base.ref == 'main'` on the job — so it needs no trigger filter, and
 * this guard flagged the exemption as stale the moment it was written. That is the pattern to copy: scope
 * an ACTION with an `if:`, never with a trigger filter, because a trigger filter also removes the run
 * itself from the PR page and that is what makes an ungated PR look gated.
 */
const EXEMPT = {
  // e.g. 'some-workflow.yml': 'why a main-only base is correct here',
};

const files = readdirSync(join(root, WF_DIR)).filter((f) => /\.ya?ml$/.test(f));
const errors = [];
const warnings = [];
let checked = 0;

for (const f of files) {
  const raw = readFileSync(join(root, WF_DIR, f), 'utf8');

  // Strip full-line comments FIRST. This header, and check.yml's own, DISCUSS `branches: [main]` in prose
  // while explaining the outage — a guard that fires on the documentation of the bug it prevents is noise,
  // and noise trains people to ignore the gate. (Same reasoning as check-ci-wiring.mjs.)
  const yaml = raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  // The `on:` block: from the `on:` key to the next top-level key. Bare `on:` is YAML 1.1's `true`, so
  // match the literal text rather than trusting a parser's key coercion.
  const onStart = yaml.search(/^on:\s*$|^on:\s*\S/m);
  if (onStart === -1) continue;
  const after = yaml.slice(onStart);
  const onBlock = after.slice(0, after.search(/\n(?=[A-Za-z_])/) === -1 ? undefined : after.search(/\n(?=[A-Za-z_])/) + 1);

  const prMatch = /^\s{0,2}pull_request(_target)?:\s*$|^\s{0,2}pull_request(_target)?:\s*\S.*$/m.exec(onBlock);
  if (!prMatch) continue; // not a PR-triggered workflow — nothing for this guard to say

  checked++;

  // The pull_request sub-block: everything indented under it, up to the next same-or-less-indented key.
  const prStart = onBlock.indexOf(prMatch[0]);
  const rest = onBlock.slice(prStart + prMatch[0].length);
  const endRel = rest.search(/\n\s{0,2}[A-Za-z_-]+:/);
  const prBlock = endRel === -1 ? rest : rest.slice(0, endRel);

  const hasFilter = /^\s+branches(-ignore)?:/m.test(prBlock);
  const reason = EXEMPT[f];

  if (hasFilter && !reason) {
    errors.push(
      `${f}: its \`pull_request\` trigger carries a base-branch filter, so it does NOT run on a PR ` +
        `targeting a non-main base. A stacked PR then shows a page with no gate run on it and reads as ` +
        `gated. Remove the \`branches:\` filter (leave \`push: branches: [main]\` alone), or add ${f} to ` +
        `EXEMPT in this file WITH A REASON.`,
    );
  }
  if (!hasFilter && reason) {
    warnings.push(`EXEMPT lists '${f}', but its pull_request trigger has no base filter — remove the exemption.`);
  }
}

for (const name of Object.keys(EXEMPT)) {
  if (!files.includes(name)) warnings.push(`EXEMPT lists '${name}', which no longer exists in ${WF_DIR} — remove it.`);
}

for (const w of warnings) console.warn(`  warning: ${w}`);

if (errors.length) {
  console.error(`pr-trigger-coverage gate FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const exempt = Object.keys(EXEMPT).length;
console.log(
  `pr-trigger-coverage gate OK: ${checked} PR-triggered workflow(s) run on EVERY base` +
    `${exempt ? ` (${exempt} exempt: ${Object.keys(EXEMPT).join(', ')})` : ''}.`,
);
