#!/usr/bin/env node
// CI gate: matcher allowlist + banned-pattern greps (the CI form of CLAUDE.md rules).
//
// 1) EXPECT-MATCHER ALLOWLIST — every `.toXxx(` matcher used in monitors/ + lib/flow.ts
//    must appear in scripts/expect-matcher-allowlist.json. The runner's spec shim
//    implements a subset of @playwright/test's matchers; an off-list matcher passes
//    locally but fails at runtime in the runner (the check-80 toBeNull incident).
//    The allowlist file carries a marked SLOT to swap in the runner's real
//    implemented-matcher list when that lands.
//
// 2) BANNED PATTERNS (mechanized CLAUDE.md):
//    - page.waitForTimeout / waitUntil:'networkidle' — the fleet is hard-wait-free by
//      discipline; keep it that way mechanically.
//    - page.route() with a catch-all pattern ('**', '**/*', '*', /.*/) — a red-test's
//      route intercept must scope to the specific API URL, NEVER the main document
//      (the #35 deploy-marker lesson: a nav-document intercept starves the capture
//      that rides page.content()/main-doc headers).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const allow = new Set(
  JSON.parse(readFileSync(join(root, 'scripts/expect-matcher-allowlist.json'), 'utf8')).allowed,
);

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
      `${rel}:${line} uses expect matcher .${name}() which is NOT in scripts/expect-matcher-allowlist.json — ` +
        `the runner shim may not implement it (spec would pass CI, then fail at runtime in the runner). ` +
        `If the runner implements it, add it to the allowlist in the same PR.`,
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
console.log(`Matcher/pattern gate OK: ${files.length} file(s), allowlist [${[...allow].join(', ')}].`);
