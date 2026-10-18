#!/usr/bin/env node
// Runs every test/*.test.js with Node's test runner. Lists the files itself because Node 20 (still supported) does not
// expand globs for --test, so `node --test "test/*.test.js"` would find nothing there (PR #32 review). Extra arguments
// (for example --test-name-pattern=promised) go to the runner. Exits with the runner's code; an empty list is a failure.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../test', import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => join(dir, f));
if (!files.length) { console.error('No test files found in test/.'); process.exit(1); }
// Timing tests run on their own, after the rest: the other files start many CLI and npm processes in parallel, and
// that load skews the perf ratios (80k vs 20k went from 4.8x alone to 5.7-7x under load; PR #32 CI flake). Same
// budgets, measured on a quiet machine. Both groups always run; the exit code fails if either failed.
const TIMED = new Set(['perf.test.js']);
const timed = files.filter(f => TIMED.has(f.slice(dir.length + 1))), rest = files.filter(f => !timed.includes(f));
const run = (list) => (list.length ? spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...list], { stdio: 'inherit' }).status ?? 1 : 0);
const a = run(rest), b = run(timed);
process.exit(a || b);
