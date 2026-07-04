#!/usr/bin/env node
// CI gate: matcher allowlist + banned-pattern greps (the CI form of CLAUDE.md rules).
//
// 1) EXPECT-MATCHER ALLOWLIST — every `.toXxx(` matcher used in monitors/ + lib/flow.ts
//    must be implemented by the runner's spec shim. The shim implements a SUBSET of
//    @playwright/test's matchers; an off-list matcher passes locally but fails at
//    runtime in the runner (the check-80 toBeNull incident).
//
//    SOURCE OF TRUTH (live): the shim single-sources its list in SUPPORTED_MATCHERS
//    (synthwatch@main runner/specfetch/specShim.ts). CI fetches that file and this
//    script parses the SUPPORTED_MATCHERS array from it (set SHIM_SOURCE=<path>).
//    FAIL-CLOSED: if the fetch or parse fails we NEVER allow everything — we fall
//    back to the committed snapshot in scripts/expect-matcher-allowlist.json
//    (restrictive; may lag the shim) and print a LOUD warning so the fallback is
//    visible in CI logs/annotations, not silent.
//
// 2) BANNED PATTERNS (mechanized CLAUDE.md):
//    - page.waitForTimeout / waitUntil:'networkidle' — the fleet is hard-wait-free by
//      discipline; keep it that way mechanically.
//    - page.route() with a catch-all pattern ('**', '**/*', '*', /.*/) — a red-test's
//      route intercept must scope to the specific API URL, NEVER the main document
//      (the #35 deploy-marker lesson: a nav-document intercept starves the capture
//      that rides page.content()/main-doc headers).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const fallback = JSON.parse(
  readFileSync(join(root, 'scripts/expect-matcher-allowlist.json'), 'utf8'),
).allowed;

/**
 * Parse SUPPORTED_MATCHERS out of the runner shim source. Mirrors the runner's own
 * scripts/check-expect-matchers.mjs: the shim declares
 *   export const SUPPORTED_MATCHERS = [ 'toBeVisible', ... ] as const;
 * We take the bracketed array that follows the identifier and extract its quoted
 * 'toXxx' string members ONLY (nothing outside the brackets — the ValueMatchers
 * interface below it also names matchers and must not leak in).
 * Returns null on any structural surprise → caller treats as parse failure.
 */
function parseSupportedMatchers(src) {
  const idIdx = src.indexOf('SUPPORTED_MATCHERS');
  if (idIdx < 0) return null;
  const open = src.indexOf('[', idIdx);
  if (open < 0) return null;
  const close = src.indexOf(']', open);
  if (close < 0) return null;
  const body = src.slice(open + 1, close);
  const names = [...body.matchAll(/['"](to[A-Z][A-Za-z]*)['"]/g)].map((m) => m[1]);
  const set = [...new Set(names)];
  // Sanity: a real shim list contains the two matchers lib/flow's vendored assertLoaded
  // needs, and is a plausible size. Anything else = the shim's shape changed → parse fail.
  if (!set.includes('toBeVisible') || !set.includes('toHaveURL')) return null;
  if (set.length < 5 || set.length > 40) return null;
  return set;
}

const LOUD = (msg) => {
  // ::warning:: renders as a GitHub Actions annotation; the banner covers local runs.
  console.error(`::warning title=Matcher gate fallback::${msg}`);
  console.error('!'.repeat(78));
  console.error(`!! MATCHER GATE FALLBACK: ${msg}`);
  console.error(`!! Enforcing the COMMITTED snapshot allowlist (restrictive, may lag the shim).`);
  console.error('!'.repeat(78));
};

let allow;
let allowSource;
const shimPath = process.env.SHIM_SOURCE;
if (shimPath && existsSync(shimPath)) {
  const parsed = parseSupportedMatchers(readFileSync(shimPath, 'utf8'));
  if (parsed) {
    allow = new Set(parsed);
    allowSource = `live shim (${shimPath})`;
  } else {
    LOUD(`SUPPORTED_MATCHERS could not be parsed from ${shimPath} — the shim's structure may have changed.`);
    allow = new Set(fallback);
    allowSource = 'COMMITTED FALLBACK (live parse FAILED)';
  }
} else {
  LOUD(
    shimPath
      ? `SHIM_SOURCE=${shimPath} does not exist — the runner-shim fetch failed.`
      : 'SHIM_SOURCE not set — no live runner-shim source provided (expected in local runs; CI fetches it).',
  );
  allow = new Set(fallback);
  allowSource = 'COMMITTED FALLBACK (no live shim source)';
}

// JS built-ins that match the `.toXxx(` shape but are not expect matchers.
const NOT_MATCHERS = new Set([
  'toString', 'toISOString', 'toJSON', 'toFixed', 'toPrecision', 'toExponential',
  'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toUpperCase',
  'toLowerCase', 'toDateString', 'toTimeString', 'toUTCString', 'toSorted',
  'toReversed', 'toSpliced', 'toWellFormed',
]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = [...walk(join(root, 'monitors')), join(root, 'lib/flow.ts')];
const errors = [];

const BANNED = [
  { re: /\bwaitForTimeout\s*\(/, why: "hard wait — the fleet is sleep-free; use an explicit expect or a network predicate (CLAUDE.md)" },
  { re: /waitUntil:\s*['"]networkidle['"]/, why: "networkidle is discouraged and flaky on chatty SPAs; anchor on a specific response instead" },
  { re: /\broute\s*\(\s*(['"`])(\*\*(\/\*)?|\*|\/\*\*?)\1/, why: "catch-all page.route() — scope a red-test intercept to the API URL pattern ONLY, never the main document (#35 rule)" },
];

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(root, f);
  const lines = src.split('\n');

  for (const m of src.matchAll(/\.(to[A-Z][A-Za-z]*)\s*\(/g)) {
    const name = m[1];
    if (NOT_MATCHERS.has(name) || allow.has(name)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    errors.push(
      `${rel}:${line} uses expect matcher .${name}() which the runner shim does not implement ` +
        `(allowlist source: ${allowSource}) — the spec would pass CI, then fail at runtime in the ` +
        `runner. Implement it in the shim's SUPPORTED_MATCHERS first, or use an implemented matcher.`,
    );
  }

  lines.forEach((text, i) => {
    for (const b of BANNED) {
      if (b.re.test(text)) errors.push(`${rel}:${i + 1} banned pattern: ${b.why}\n    > ${text.trim()}`);
    }
  });
}

if (errors.length) {
  console.error('Matcher/pattern gate FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  `Matcher/pattern gate OK: ${files.length} file(s), allowlist from ${allowSource}: [${[...allow].join(', ')}].`,
);
