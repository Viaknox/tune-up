// Checks on CI and tooling files outside src/ (workflows, the mutation script). Kept out of gate.test.js, which the
// mutation check runs inside an engine-only copy where ../.github does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));

test('PR #32 review: the CI keeps one stable "engine" check that fails unless every test and pack-smoke cell passed', () => {
  const yml = readFileSync(fileURLToPath(new URL('../../.github/workflows/test.yml', import.meta.url)), 'utf8');
  assert.match(yml, /\n  engine:\n    if: always\(\)\n    needs: \[engine-matrix, pack-smoke\]\n/);
  assert.match(yml, /TESTS: \$\{\{ needs\.engine-matrix\.result \}\}\n\s+SMOKE: \$\{\{ needs\.pack-smoke\.result \}\}\n\s+run: '\[ "\$TESTS" = "success" \] && \[ "\$SMOKE" = "success" \]/);
});

test('P6: the packed CLI is tested on Linux, Windows and macOS, on Node 20.12 and 22', () => {
  const yml = readFileSync(fileURLToPath(new URL('../../.github/workflows/test.yml', import.meta.url)), 'utf8');
  const job = yml.slice(yml.indexOf('\n  pack-smoke:'));
  assert.match(job, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(job, /node: \['20\.12', '22'\]/);
  assert.match(job, /fail-fast: false/);
  assert.match(job, /run: node --test test\/cli-package\.test\.js/);
});

test('PR #32 review: the mutation check runs the unmutated baseline first and fails if it does not pass', () => {
  const src = readFileSync(join(ENGINE, 'scripts', 'mutate.mjs'), 'utf8');
  assert.match(src, /const base = run\(src, files, opt\.timeout\);\n\s+if \(base !== 'survived'\)/);
  assert.doesNotMatch(src, /node_modules\|scripts\|/, 'scripts/ must be copied into the mutation copy');
  assert.match(src, /cpSync\(gh, join\(dir, '\.github'\)/, 'the copy keeps .github next to engine/ so workflow tests run');
});

test('PR #32 review: test.yml is read-only and pins every action to a full commit SHA', () => {
  const yml = readFileSync(fileURLToPath(new URL('../../.github/workflows/test.yml', import.meta.url)), 'utf8');
  assert.match(yml, /\npermissions:\n  contents: read\n/);
  const uses = [...yml.matchAll(/uses: (\S+)/g)].map(m => m[1]);
  assert.ok(uses.length >= 4); for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});
