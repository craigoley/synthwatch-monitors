#!/usr/bin/env node
// Validate manifest.json against the schema AND the filesystem:
//  - every manifest entry's `script` file must exist
//  - every spec file under monitors/ must have a manifest entry (no orphans)
//  - ids must be unique and match the id pattern
// This CI gate keeps the registry honest: a script with no manifest entry won't
// be discoverable; a manifest entry with no script would break sync.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const errors = [];

const idPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const seen = new Set();
for (const m of manifest.monitors ?? []) {
  if (!m.id || !idPattern.test(m.id)) errors.push(`Invalid or missing id: ${JSON.stringify(m.id)}`);
  if (seen.has(m.id)) errors.push(`Duplicate id: ${m.id}`);
  seen.add(m.id);
  if (!m.name) errors.push(`Monitor ${m.id} missing name`);
  if (!m.script || !/^monitors\/.+\.spec\.ts$/.test(m.script)) errors.push(`Monitor ${m.id} has invalid script path: ${m.script}`);
  if (m.kind !== 'browser') errors.push(`Monitor ${m.id} has unsupported kind: ${m.kind}`);
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
