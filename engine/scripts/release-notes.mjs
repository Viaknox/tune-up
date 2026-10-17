#!/usr/bin/env node
// Prints the engine/CHANGELOG.md section for one CLI version (the GitHub release notes), or with --compatibility only
// its "Compatibility:" line (the release approval summary). A release PR must add that section; without it, or without
// a Compatibility line, this exits 1 and the release stops (docs/CLI-PLAN.md S6).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function section(md, version) {
  const lines = md.split(/\r?\n/), head = `## ${version}`;
  const start = lines.findIndex(l => l === head || l.startsWith(head + ' '));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}
export function compatibility(text) {
  const m = /^Compatibility: *(\S.*)$/m.exec(text || '');
  return m ? m[1].trim() : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [version, flag] = process.argv.slice(2);
  const body = section(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  const compat = compatibility(body);
  if (!body || !compat) { console.error(`engine/CHANGELOG.md needs a "## ${version}" section with a "Compatibility:" line.`); process.exit(1); }
  console.log(flag === '--compatibility' ? compat : body);
}
