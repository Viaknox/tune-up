// The packaged CLI as outside teams get it (docs/CLI-PLAN.md §6, P1-P6, and the golden fixtures F1-F3): the tarball
// `npm pack` builds is installed in a clean folder and run through npx. No test reaches the network: every child process
// loads test/fixtures/stub-fetch.mjs, which replaces fetch and records each attempted call. CI runs this file on Linux,
// Windows and macOS, on Node 20.12 and 22 (P6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT } from '../src/gate.js';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(ENGINE, '..');
const STUB = pathToFileURL(join(ENGINE, 'test', 'fixtures', 'stub-fetch.mjs')).href;
const GOLDEN = join(ENGINE, 'test', 'fixtures', 'golden');
const WIN = process.platform === 'win32';
const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
const KEY = 'sk-or-v1-PKGTEST' + 'z9'.repeat(20);
const GOOD = { completed: 0.95, truthful: 0.05, followed_rules: 0.95, needless_question: 0.05, initiative: 0.05, frustrated: 0.05 };

// Build and install the tarball once for this file. The release workflow sets TU_TEST_TARBALL to the exact tarball it
// is about to publish, so the smoke tests run on that file rather than on a fresh pack (docs/CLI-PLAN.md PT8).
const PACKS = mkdtempSync(join(tmpdir(), 'tu-pack-'));
const APP = mkdtempSync(join(tmpdir(), 'tu-app-'));
const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8', shell: WIN });
{
  if (!process.env.TU_TEST_TARBALL) { const p = npm(['pack', '--silent', '--pack-destination', PACKS], ENGINE); if (p.status !== 0) throw new Error('npm pack failed: ' + p.stderr); }
  writeFileSync(join(APP, 'package.json'), '{"name":"tu-app","version":"1.0.0","private":true}\n');
  const tgz = process.env.TU_TEST_TARBALL || join(PACKS, readdirSync(PACKS).find(f => f.endsWith('.tgz')));
  const i = npm(['install', '--no-audit', '--no-fund', '--offline', tgz], APP);
  if (i.status !== 0) throw new Error('npm install of the tarball failed: ' + i.stderr);
}
for (const f of readdirSync(GOLDEN)) copyFileSync(join(GOLDEN, f), join(APP, f));

const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:TUNEUP_|TU_TEST_)/i.test(k) && k !== 'NODE_OPTIONS'));
let n = 0;
// Runs `npx agenttuneup ...` in the clean folder with fetch stubbed. Returns the result plus the calls it attempted.
const npx = (args, { env = {}, fetch = { throw: true } } = {}) => {
  const netlog = join(APP, `net-${++n}.log`);
  const r = spawnSync('npx', ['--no-install', 'agenttuneup', ...args], {
    cwd: APP, encoding: 'utf8', shell: WIN, maxBuffer: 64e6,
    env: { ...baseEnv(), NODE_OPTIONS: `--import=${STUB}`, TU_TEST_NETLOG: netlog, TU_TEST_FETCH: JSON.stringify(fetch), ...env },
  });
  return { ...r, calls: existsSync(netlog) ? readFileSync(netlog, 'utf8').split('\n').filter(Boolean) : [] };
};
const out = () => `o${++n}`;
const gj = (dir) => JSON.parse(readFileSync(join(APP, dir, 'gate.json'), 'utf8'));
writeFileSync(join(APP, 'clean.txt'), 'User: Hi, what time do you open?\nBot: We open at 9am.\n');
writeFileSync(join(APP, 'bad.txt'), "User: Book a table for two\nBot: Booked for four.\nUser: No, that's wrong. Two people.\nBot: Fixed, two people.\n");
writeFileSync(join(APP, 'none.txt'), '');
const suite = (agent_config) => JSON.stringify({ agent: 'A', instructions: 'Be brief.', agent_config, cases: [{ id: 'c1', intent: 'hours', turns: ['When do you open?'] }, { id: 'c2', intent: 'boom', turns: ['boom please'] }] });
writeFileSync(join(APP, 'model.suite.json'), suite({ type: 'model', model: 'test/model' }));
writeFileSync(join(APP, 'http.suite.json'), suite({ type: 'http', url: 'http://agent.invalid/chat' }));

test('P1/P1b: the packed file list, manifest and LICENSE', () => {
  const r = npm(['pack', '--dry-run', '--json'], ENGINE);
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map(f => f.path);
  assert.ok(files.includes('LICENSE'));
  for (const f of files) assert.ok(/^(?:cli\.js|package\.json|README\.md|LICENSE|src\/[\w-]+\.js)$/.test(f), `unexpected file in the package: ${f}`);
  const installed = JSON.parse(readFileSync(join(APP, 'node_modules', 'agenttuneup', 'package.json'), 'utf8'));
  assert.equal(installed.name, 'agenttuneup');
  assert.equal(installed.repository.url, 'git+https://github.com/Viaknox/tune-up.git');
  assert.equal(installed.repository.directory, 'engine');
  assert.equal(readFileSync(join(ENGINE, 'LICENSE'), 'utf8'), readFileSync(join(ROOT, 'LICENSE'), 'utf8'), 'engine/LICENSE must match the root LICENSE');
});

test('P2: npx agenttuneup --version prints the version', () => {
  const r = npx(['--version']);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), pkg.version);
});

test('P3/P3b: without consent nothing is sent: check runs rules-only; run and tune stop with exit 2', () => {
  const r = npx(['check', 'clean.txt', '--gate', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY } });
  assert.equal(r.status, EXIT.PASS, r.stderr); assert.match(r.stderr, /agenttuneup: PASS: local rules only/); assert.deepEqual(r.calls, []);
  for (const cmd of ['run', 'tune']) {
    const s = npx([cmd, 'model.suite.json', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY } });
    assert.equal(s.status, EXIT.USAGE, cmd + s.stderr); assert.deepEqual(s.calls, [], cmd);
  }
});

test('P3c: TUNEUP_CONSENT=1 counts as consent; a key alone never does', () => {
  const c = npx(['check', 'clean.txt', '--gate', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY, TUNEUP_CONSENT: '1' } });
  assert.ok(c.calls.some(u => u.endsWith('/alpha/decisions')), 'the judge was not asked'); assert.equal(c.status, EXIT.UNDETERMINED, c.stderr);
  const r = npx(['run', 'model.suite.json', '--gate', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY, TUNEUP_CONSENT: '1' } });
  assert.ok(r.calls.some(u => u.endsWith('/v1/chat/completions')), 'the model adapter was not called'); assert.equal(r.status, EXIT.UNDETERMINED, r.stderr);
  const k = npx(['check', 'clean.txt', '--gate', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY } });
  assert.deepEqual(k.calls, []); assert.equal(k.status, EXIT.PASS);
});

test('P4: exit codes 0, 1, 2 and 3 come through npx unchanged', () => {
  assert.equal(npx(['check', 'clean.txt', '--gate', '--out', out()]).status, EXIT.PASS);
  assert.equal(npx(['check', 'bad.txt', '--gate', '--out', out()]).status, EXIT.FAIL);
  assert.equal(npx(['check', 'clean.txt', '--gate', '--min']).status, EXIT.USAGE);
  assert.equal(npx(['check', 'none.txt', '--gate', '--out', out()]).status, EXIT.UNDETERMINED);
  assert.equal(npx(['check', 'bad.txt', '--out', out()]).status, EXIT.PASS, 'without --gate the exit code is 0');
});

test('P4b: an agent or judge call that fails is recorded as errored in gate.json and exits 3, without a crash', () => {
  const o1 = out();
  const r = npx(['run', 'http.suite.json', '--consent', '--gate', '--json', '--out', o1], { env: { TUNEUP_OPENROUTER_KEY: KEY }, fetch: { answers: { ...GOOD, truthful: 0.95 }, agentFailOn: 'boom' } });
  assert.equal(r.status, EXIT.UNDETERMINED, r.stderr); assert.doesNotMatch(r.stderr, /crashed/);
  assert.deepEqual(gj(o1).errored, [{ case: 'c2', rep: 1 }]); assert.equal(gj(o1).verdict, 'UNDETERMINED');
  const o2 = out();
  const c = npx(['check', 'clean.txt', '--consent', '--gate', '--json', '--out', o2], { env: { TUNEUP_OPENROUTER_KEY: KEY } });
  assert.equal(c.status, EXIT.UNDETERMINED, c.stderr); assert.doesNotMatch(c.stderr, /crashed/);
  assert.deepEqual(gj(o2).errored, [{ case: 'chat-1', rep: 1 }]); assert.equal(gj(o2).evidence, 'judged');
});

test('P5: a fake key never appears in stdout, stderr, report.md or gate.json, even when the provider echoes it', () => {
  const o = out();
  const r = npx(['check', 'clean.txt', '--consent', '--gate', '--json', '--out', o], { env: { TUNEUP_OPENROUTER_KEY: KEY }, fetch: { echoKey: true } });
  assert.ok(r.calls.length > 0);
  for (const text of [r.stdout, r.stderr, ...readdirSync(join(APP, o)).map(f => readFileSync(join(APP, o, f), 'utf8'))]) assert.ok(!text.includes(KEY));
});

test('P5b/P5c: misspelled options and broken input files are exit 2 through the package, with nothing sent', () => {
  for (const args of [['check', 'clean.txt', '--gte'], ['run', 'model.suite.json', '--consnet'], ['tune', 'model.suite.json', '--consnet']]) {
    const r = npx(args, { env: { TUNEUP_OPENROUTER_KEY: KEY } });
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(args)); assert.deepEqual(r.calls, []);
  }
  writeFileSync(join(APP, 'broken.json'), '{"messages": [{"role": "user", "content": "' + KEY);
  const r = npx(['check', 'broken.json', '--consent', '--gate', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY } });
  assert.equal(r.status, EXIT.USAGE); assert.match(r.stderr, /broken\.json.* is not valid: it is not valid JSON/);
  assert.doesNotMatch(r.stderr, /crashed|\n\s+at /); assert.ok(!r.stderr.includes(KEY)); assert.deepEqual(r.calls, []);
});

test('F1: known-bad chats (a false "done" and an echoed card number) FAIL and the verdict names both', () => {
  const r = npx(['check', 'known-bad.txt', '--consent', '--gate', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY }, fetch: { answers: { ...GOOD, truthful: 0.95 } } });
  assert.equal(r.status, EXIT.FAIL, r.stderr);
  assert.match(r.stderr, /agenttuneup: FAIL .*\(failed: .*echoed_secret/); assert.match(r.stderr, /\(failed: .*judge:truthful/);
});

test('F2: known-good chats are PASS: local rules only', () => {
  const r = npx(['check', 'known-good.txt', '--gate', '--out', out()]);
  assert.equal(r.status, EXIT.PASS, r.stderr); assert.match(r.stderr, /agenttuneup: PASS: local rules only \(exit 0\)/);
});

test('F3: every judge answer at 50% is exit 1 (FAIL), not a pass and not missing evidence', () => {
  const r = npx(['check', 'known-good.txt', '--consent', '--gate', '--out', out()], { env: { TUNEUP_OPENROUTER_KEY: KEY }, fetch: { answers: {} } });
  assert.equal(r.status, EXIT.FAIL, r.stderr); assert.match(r.stderr, /undetermined rate 100\.0%/);
});
