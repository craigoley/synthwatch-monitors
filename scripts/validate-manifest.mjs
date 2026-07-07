#!/usr/bin/env node
// Validate manifest.json against the schema AND the filesystem:
//  - manifest.json validates against manifest.schema.json (ajv, draft-07) — this is
//    what enforces additionalProperties:false (typo'd keys), name length, interval
//    minimum, tag/redact_patterns types, and the sensitive→redact_patterns conditional
//  - every manifest entry's `script` file must exist
//  - every spec file under monitors/ must have a manifest entry (no orphans)
//  - ids must be unique and match the id pattern
// This CI gate keeps the registry honest: a script with no manifest entry won't
// be discoverable; a manifest entry with no script would break sync.
// (The hand-rolled checks below overlap the schema on purpose: they produce
// friendlier per-monitor messages; the schema is the authoritative superset.)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv from 'ajv';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const errors = [];

// ★ Execute the schema for real. Before this, manifest.schema.json was referenced by
// $schema (editor hints only) and nothing ran it — additionalProperties:false was decorative.
const schema = JSON.parse(readFileSync(join(root, 'manifest.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);
if (!validateSchema(manifest)) {
  for (const e of validateSchema.errors ?? []) {
    errors.push(`Schema violation at ${e.instancePath || '/'}: ${e.message}`);
  }
}

const idPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const seen = new Set();
for (const m of manifest.monitors ?? []) {
  if (!m.id || !idPattern.test(m.id)) errors.push(`Invalid or missing id: ${JSON.stringify(m.id)}`);
  if (seen.has(m.id)) errors.push(`Duplicate id: ${m.id}`);
  seen.add(m.id);
  if (!m.name) errors.push(`Monitor ${m.id} missing name`);
  if (!m.script || !/^monitors\/.+\.spec\.ts$/.test(m.script)) errors.push(`Monitor ${m.id} has invalid script path: ${m.script}`);
  if (m.kind !== 'browser') errors.push(`Monitor ${m.id} has unsupported kind: ${m.kind}`);

  // B10 trace-redaction: a sensitive monitor MUST declare valid redact_patterns before it can ship.
  if (m.sensitive !== undefined && typeof m.sensitive !== 'boolean') {
    errors.push(`Monitor ${m.id} sensitive must be a boolean`);
  }
  if (m.redact_patterns !== undefined) {
    if (!Array.isArray(m.redact_patterns) || !m.redact_patterns.every((p) => typeof p === 'string')) {
      errors.push(`Monitor ${m.id} redact_patterns must be an array of strings`);
    } else {
      for (const p of m.redact_patterns) {
        try {
          // INTENTIONAL non-literal RegExp: `p` is a redact_pattern — a regex BY DESIGN (authored per
          // monitor). Constructing it here is exactly how we validate it COMPILES, so a broken pattern is
          // caught before a sensitive monitor ships. Do NOT "harden" this with escapeRegExp: escaping would
          // make every string a valid literal, silently defeating this validation (an invalid regex like
          // `[unclosed` would pass) and weakening the B10 redaction gate. detect-non-literal-regexp is a true
          // false-positive here (unlike the dashboard's check-enum-coverage.mjs, where the interpolants are
          // literal identifiers and ARE escaped — craigoley/synthwatch-dashboard#207).
          // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- validating a by-design user regex; escaping would break the validation.
          new RegExp(p);
        } catch {
          errors.push(`Monitor ${m.id} redact_patterns: invalid regex ${JSON.stringify(p)}`);
        }
      }
    }
  }
  // ★ THE GATE: redaction REQUIRED before a sensitive monitor can be enabled.
  if (m.sensitive === true && (!Array.isArray(m.redact_patterns) || m.redact_patterns.length === 0)) {
    errors.push(`Monitor ${m.id} is marked sensitive but declares no redact_patterns — B10 requires redaction before enable`);
  }
}

for (const m of manifest.monitors ?? []) {
  if (!m.script) continue;
  try { statSync(join(root, m.script)); }
  catch { errors.push(`Manifest references missing file: ${m.script} (monitor ${m.id})`); }
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}
const scripts = walk(join(root, 'monitors')).map((p) => relative(root, p));
const manifestScripts = new Set((manifest.monitors ?? []).map((m) => m.script));
for (const s of scripts) {
  if (!manifestScripts.has(s)) errors.push(`Orphan script (no manifest entry): ${s} -- add it to manifest.json`);
}

if (errors.length) {
  console.error('Manifest validation FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`Manifest OK: ${manifest.monitors.length} monitor(s), ${scripts.length} script(s), all bound.`);
