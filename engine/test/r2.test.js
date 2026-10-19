// R2: one evidence classifier (src/gate.js stateOf) for report.json, report.md and `tune` (docs/CLI-PLAN.md S9, tests
// X1-X5, checklist PG8/PG11/PG13/PG15, frontier-gate run 2026-10-19-r2-classifier). If one of these fails after your
// change, a "couldn't tell" answer or a missing run is being counted as a pass or as an improvement again: fix the
// change, not the test. src/tune.js must also have zero surviving mutants (npm run mutate:tune).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, gate } from '../src/gate.js';
import { buildReport, toMarkdown, regressions, REPORT_SCHEMA } from '../src/report.js';
import { checkReport, compare, fullyEvaluated, eligibility, pickBest, ReportError } from '../src/tune.js';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ENGINE, 'cli.js');
const STUB = pathToFileURL(join(ENGINE, 'test', 'fixtures', 'stub-fetch.mjs')).href;
const tmp = () => mkdtempSync(join(tmpdir(), 'tu-r2-'));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TUNEUP_/i.test(k)));
const cli = (args, fetchCfg) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 64e6,
  env: fetchCfg ? { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test', NODE_OPTIONS: `--import=${STUB}`, TU_TEST_FETCH: JSON.stringify(fetchCfg) } : cleanEnv() });

// Findings that give each state through the real classifier.
const OK = [{ bucket: 'done', code: 'judge:completed', ok: true }, { bucket: 'rules', code: 'judge:followed_rules', ok: true }];
const FAILED = [{ bucket: 'done', code: 'judge:completed', ok: false, detail: 'did not finish' }, { bucket: 'rules', code: 'judge:followed_rules', ok: true }];
const UNSURE = [{ bucket: 'done', code: 'judge:completed', ok: true, unsure: true }, { bucket: 'rules', code: 'judge:followed_rules', ok: true }];
const HELD = [{ bucket: 'rules', code: 'judge:held', ok: false, unsure: true, detail: 'unsure: we held back part of this chat to protect a secret' }];
const ERRORED = [{ bucket: 'rules', code: 'judge:error', ok: false, unsure: true }];
const FS = { ok: OK, failed: FAILED, undetermined: UNSURE, held: HELD, errored: ERRORED };
const suite = { agent: 'A', repeats: 2 };
const adapter = { name: 'http', observesTools: false };
// A report from a list of states, one per case-run, cases c1..cN with `reps` repeats each.
const rep = (states, { reps = 1, judgeModel = 'typesafe/jev-1.13' } = {}) => buildReport({ suite: { ...suite, repeats: reps }, instructions: 'x', adapter, judgeModel, evidenceLevel: 2,
  runs: states.map((s, i) => ({ case: `c${Math.floor(i / reps) + 1}`, rep: (i % reps) + 1, findings: FS[s].map(f => ({ ...f })), turns: [], ms: 0, tokens: 0, toolCalls: 0 })) });
const expectedOf = (r) => r.runs.map(x => ({ case: x.case, rep: x.rep }));

test('R2: report.json is tune-up/report@0.2 with a state per run, strict counts and a raw strict pass rate', () => {
  const r = rep(['ok', 'failed', 'undetermined', 'held', 'errored']);
  assert.equal(REPORT_SCHEMA, 'tune-up/report@0.2'); assert.equal(r.schema, REPORT_SCHEMA);
  assert.deepEqual(r.runs.map(x => x.state), ['ok', 'failed', 'undetermined', 'undetermined', 'errored']);
  assert.deepEqual(r.counts, { expected: 5, ok: 1, failed: 1, undetermined: 2, missing: 0, errored: 1 });
  assert.equal(r.pass_rate, 1 / 5, 'a raw fraction of ok out of expected, never rounded and never counting unsure');
  // The counts are the gate's counts: one classifier, one answer (checklist 9).
  assert.deepEqual(r.counts, gate(r.runs, { expected: expectedOf(r), judged: true }).counts);
  // Every run keeps its findings, so tune can re-classify it later (X5 refuses reports without them).
  assert.ok(r.runs.every(x => Array.isArray(x.findings) && x.findings.length));
  assert.ok(r.runs.every(x => !('passed' in x)), 'no lenient per-run pass flag is written');
});

test('R2 / PG15: the old lenient number is kept for one release, labelled legacy, in report.json only', () => {
  const r = rep(['ok', 'undetermined', 'held', 'failed']);
  assert.deepEqual(r.legacy, { pass_rate_lenient: 3 / 4, note: 'Deprecated: counted unsure answers as passes. Never used for any decision; removed in 0.3.' });
  const md = toMarkdown(r);
  assert.doesNotMatch(md, /lenient|legacy|75/, 'report.md shows one number only (Paul, 2026-10-19)');
});

test('R2 / X2: report.md headline says "couldn\'t tell" in words, never a percentage, and never PASSED for a held chat', () => {
  const held = toMarkdown(rep(['held']));
  assert.match(held, /\*\*Passed 0 of 1 run\*\* · 1 couldn't tell/);
  assert.doesNotMatch(held, /PASSED|Passed 1 of 1/);
  const mixed = toMarkdown(rep(['ok', 'ok', 'undetermined', 'failed']));
  assert.match(mixed, /\*\*Passed 2 of 4 runs\*\* · 1 couldn't tell · 1 failed/);
  const headline = mixed.split('\n').find(l => l.startsWith('**Passed'));
  assert.doesNotMatch(headline, /%/);
  assert.doesNotMatch(headline, /errored|missing/, 'errored and missing are named only when there are some');
  assert.match(toMarkdown(rep(['ok', 'errored'])), /\*\*Passed 1 of 2 runs\*\* · 1 errored/);
  assert.match(toMarkdown(rep(['ok', 'ok', 'ok'])), /\*\*Passed 3 of 3 runs\*\*\n/);
});

test('R2 / checklist 14: no report can show every part passing while a run failed', () => {
  const states = ['ok', 'failed', 'undetermined', 'held', 'errored'];
  for (let n = 0; n < 200; n++) {
    const pick = Array.from({ length: 1 + (n % 4) }, (_, i) => states[(n * 7 + i * 3) % states.length]);
    const r = rep(pick);
    if (r.runs.some(x => x.state === 'failed')) assert.ok(r.buckets.some(b => b.status === 'fail' || b.status === 'warn'), JSON.stringify(pick));
    if (r.buckets.every(b => ['pass', 'not_available', 'not_tested'].includes(b.status))) assert.ok(r.runs.every(x => x.state === 'ok'), JSON.stringify(pick));
  }
});

test('R2 / X1 + checklist 13: lift counts only failed -> ok; turning failures into "couldn\'t tell" is never lift', () => {
  const before = rep(['failed', 'failed', 'ok', 'ok'], { reps: 2 });
  const vaguer = rep(['undetermined', 'undetermined', 'ok', 'ok'], { reps: 2 });
  const c = compare(before, vaguer);
  assert.equal(c.lift, 0); assert.deepEqual(c.gains, []); assert.deepEqual(c.losses, []);
  assert.deepEqual(c.evidence, { to_ok: [], from_ok: [], to_unclear: ['c1#1', 'c1#2'] });
  assert.equal(eligibility({ attempt: 1, lift: c.lift, losses: c.losses, regressions: regressions(before, vaguer), after: vaguer }, { repeats: 2 }).eligible, false);
  // A real fix: failed -> ok is +1 each; ok -> anything else is -1 and a regression.
  const fixed = rep(['ok', 'ok', 'ok', 'failed'], { reps: 2 });
  const f = compare(before, fixed);
  assert.deepEqual([f.lift, f.gains, f.losses], [1, ['c1#1', 'c1#2'], ['c2#2']]);
  assert.deepEqual(regressions(before, fixed), ['c2#2']);
  // undetermined -> ok is an evidence change, not lift; ok -> undetermined is a loss and an evidence change.
  const e = compare(rep(['undetermined', 'ok']), rep(['ok', 'undetermined']));
  assert.equal(e.lift, -1); assert.deepEqual(e.gains, []); assert.deepEqual(e.losses, ['c2#1']);
  assert.deepEqual(e.evidence, { to_ok: ['c1#1'], from_ok: ['c2#1'], to_unclear: [] });
  // errored and missing after count as losses too.
  assert.equal(compare(rep(['ok', 'ok']), rep(['errored', 'ok'])).lift, -1);
});

test('R2: regressions are per case-run (ok before, not ok after), plus any new "Follows your rules" failure', () => {
  const before = rep(['ok', 'ok', 'failed', 'ok'], { reps: 2 });
  assert.deepEqual(regressions(before, rep(['ok', 'undetermined', 'ok', 'ok'], { reps: 2 })), ['c1#2']);
  assert.deepEqual(regressions(before, rep(['ok', 'ok', 'failed', 'ok'], { reps: 2 })), []);
  const leak = { bucket: 'rules', code: 'must_not_say', ok: false, detail: 'Revealed "HR"' };
  const after = rep(['ok', 'ok', 'failed', 'ok'], { reps: 2 }); after.failures.push({ case: 'c2', rep: 1, ...leak });
  assert.deepEqual(regressions(before, after), ['c2 (must_not_say: Revealed "HR")']);
});

test('R2 / checklist 21: tune refuses a report it cannot trust, with a reason it can print', () => {
  const r = rep(['ok', 'failed'], { reps: 1 }); r.suite_id = 'abc';
  const ctx = { suiteId: 'abc', expected: [{ case: 'c1', rep: 1 }, { case: 'c2', rep: 1 }] };
  assert.equal(checkReport(r, ctx), r);
  const bad = (mut, why) => { const x = structuredClone(r); mut(x); assert.throws(() => checkReport(x, ctx), (e) => e instanceof ReportError && why.test(e.message), why); };
  bad(x => { x.schema = 'tune-up/report@0.1'; }, /older report \(tune-up\/report@0\.1\).*fresh `run`/);
  bad(x => { delete x.schema; }, /older report.*fresh `run`/);
  bad(x => { x.schema = 'tune-up/report@0.3'; }, /newer report/);
  bad(x => { x.suite_id = 'zzz'; }, /different suite or settings/);
  bad(x => { x.runs.push(structuredClone(x.runs[0])); }, /twice/);
  bad(x => { x.runs.pop(); }, /missing c2#1/);
  bad(x => { x.runs[1].state = 'ok'; }, /c2#1 says ok, but its findings say failed/);
  bad(x => { x.counts.ok = 2; }, /counts do not match/);
  bad(x => { x.runs[0].findings = 'x'; }, /c1#1 has no findings/);
  bad(x => { x.pass_rate = 1; }, /pass_rate does not match/);
});

test('R2 / checklist 2, 7, 8: "verified" needs every after-run fully checked and at least 2 runs per test', () => {
  const before = rep(['failed', 'failed'], { reps: 2 });
  const att = (after, n = 1) => { const c = compare(before, after); return { attempt: n, lift: c.lift, losses: c.losses, regressions: regressions(before, after), after }; };
  const good = eligibility(att(rep(['ok', 'ok'], { reps: 2 })), { repeats: 2 });
  assert.deepEqual(good, { eligible: true, verified: true, reasons: [] });
  assert.equal(fullyEvaluated(rep(['ok', 'failed'])), true);
  for (const s of ['undetermined', 'held', 'errored']) {
    assert.equal(fullyEvaluated(rep(['ok', s])), false, s);
    const e = eligibility(att(rep(['ok', s], { reps: 2 })), { repeats: 2 });
    assert.equal(e.verified, false, s); assert.equal(e.eligible, false, s);
    assert.match(e.reasons.join(' '), /Not verified: incomplete evidence/, s);
  }
  // One run per test cannot tell a real gain from judge noise (Paul, 2026-10-19).
  const single = (opts) => eligibility(att(rep(['ok'], { reps: 1 })), { repeats: 1, ...opts });
  const b1 = rep(['failed'], { reps: 1 });
  const a1 = { attempt: 1, ...compare(b1, rep(['ok'], { reps: 1 })), regressions: [], after: rep(['ok'], { reps: 1 }) };
  assert.equal(eligibility(a1, { repeats: 1 }).eligible, false);
  assert.match(eligibility(a1, { repeats: 1 }).reasons.join(' '), /only 1 run per test.*--repeats 2.*--allow-single-repeat/);
  assert.equal(eligibility(a1, { repeats: 1, allowSingleRepeat: true }).eligible, true);
  assert.equal(single({}).verified, false);
  // No lift, or any regression, is never eligible.
  assert.equal(eligibility({ ...att(rep(['ok', 'ok'], { reps: 2 })), lift: 0 }, { repeats: 2 }).eligible, false);
  assert.equal(eligibility({ ...att(rep(['ok', 'ok'], { reps: 2 })), regressions: ['c1#1'] }, { repeats: 2 }).eligible, false);
});

test('R2 / checklist 20: the best attempt is picked the same way every time', () => {
  const a = (attempt, lift, failedAfter) => ({ attempt, lift, after: { counts: { failed: failedAfter } } });
  assert.equal(pickBest([a(1, 2, 1), a(2, 3, 2), a(3, 3, 2)]).attempt, 2, 'highest lift, then earliest attempt');
  assert.equal(pickBest([a(1, 3, 2), a(2, 3, 1)]).attempt, 2, 'same lift: fewer failures after wins');
  assert.equal(pickBest([a(4, 1, 0), a(3, 1, 0)]).attempt, 3);
  assert.equal(pickBest([]), null);
});

// ---- CLI: run, then tune, with the network stubbed (test/fixtures/stub-fetch.mjs) ----
const GOOD = { completed: 0.95, truthful: 0.95, followed_rules: 0.95, needless_question: 0.05 };
const BAD = { ...GOOD, completed: 0.05 };
const VAGUE = { ...GOOD, completed: 0.5 };
const WRITER = { revised_instructions: 'Answer questions about opening hours. Always state the exact opening time.', changes: ['c1: state the time'] };
function project({ repeats = 2 } = {}) {
  const d = tmp(), s = join(d, 'suite.json'), out = join(d, 'o');
  writeFileSync(s, JSON.stringify({ agent: 'A', instructions: 'Answer questions about opening hours.', repeats,
    agent_config: { type: 'http', url: 'http://agent.invalid/chat', body: { message: '{{message}}', system: '{{instructions}}' } },
    cases: [{ id: 'c1', intent: 'hours', turns: ['When do you open?'] }] }));
  return { d, s, out };
}
const runBaseline = (p, answers, extra = []) => { const r = cli(['run', p.s, '--consent', '--out', p.out, ...extra], { answers }); assert.equal(r.status, 0, r.stderr); return r; };
const tune = (p, cfg, extra = []) => cli(['tune', p.s, '--consent', '--out', p.out, ...extra], { writer: WRITER, ...cfg });

test('R2 / X5: tune refuses an R1 (report@0.1) baseline with exit 2 and asks for a fresh run; no lift is reported', () => {
  const p = project(); runBaseline(p, BAD);
  const f = join(p.out, 'report.json'); const r = JSON.parse(readFileSync(f, 'utf8'));
  r.schema = 'tune-up/report@0.1'; writeFileSync(f, JSON.stringify(r));
  const t = tune(p, { answers: GOOD });
  assert.equal(t.status, EXIT.USAGE, t.stderr); assert.match(t.stderr, /fresh `run`/);
  assert.equal(existsSync(join(p.out, 'attempt-1.json')), false, 'nothing was attempted');
  assert.equal(existsSync(join(p.out, 'tune-up.md')), false);
});

test('R2 / X4: tune --gate gates the best eligible attempt, exit 1 when every attempt was checked and none helped, exit 3 when attempts errored', () => {
  // An eligible attempt (failed -> ok on both runs): its after-report is gated with the run policy.
  const p = project(); runBaseline(p, BAD);
  const ok = tune(p, { answers: GOOD }, ['--gate', '--json']);
  assert.equal(ok.status, EXIT.PASS, ok.stderr); assert.match(ok.stderr, /agenttuneup: PASS \(judged\)/);
  const sel = JSON.parse(readFileSync(join(p.out, 'tune.json'), 'utf8'));
  assert.equal(sel.schema, 'agenttuneup/tune@0.1'); assert.equal(sel.selected_attempt, 1); assert.equal(sel.exit, EXIT.PASS);
  assert.deepEqual(sel.policy, { min: 100, max_undetermined: 0, allow_rules_fail: false });
  assert.match(sel.why, /lift \+2/);
  assert.deepEqual(JSON.parse(readFileSync(join(p.out, 'gate.json'), 'utf8')).counts, JSON.parse(readFileSync(join(p.out, 'attempt-1.json'), 'utf8')).after.counts);
  // Every attempt fully checked, none helped: exit 1.
  const q = project(); runBaseline(q, BAD);
  const none = tune(q, { answers: BAD }, ['--gate']);
  assert.equal(none.status, EXIT.FAIL, none.stderr); assert.match(none.stderr, /no attempt improved/i);
  // The only attempt errored (judge down): exit 3, never 0 or 1.
  const e = project(); runBaseline(e, BAD);
  const err = tune(e, { decideThrow: true }, ['--gate']);
  assert.equal(err.status, EXIT.UNDETERMINED, err.stderr);
  // Mixed: one attempt checked and not better, a later one errored: still exit 3 (not every attempt was checked).
  const m = project(); runBaseline(m, BAD);
  assert.equal(tune(m, { answers: BAD }).status, 0);
  assert.equal(tune(m, { decideThrow: true }, ['--gate']).status, EXIT.UNDETERMINED);
});

test('R2 / X1 end to end: a fix that only makes the answers vaguer shows no lift and is never proposed', () => {
  const p = project(); runBaseline(p, BAD);
  const t = tune(p, { answers: VAGUE }, ['--gate']);
  assert.notEqual(t.status, EXIT.PASS, t.stderr);
  const a = JSON.parse(readFileSync(join(p.out, 'attempt-1.json'), 'utf8'));
  assert.equal(a.schema, 'agenttuneup/attempt@0.2'); assert.equal(a.lift, 0); assert.equal(a.verified, false);
  assert.deepEqual(a.evidence.to_unclear, ['c1#1', 'c1#2']);
  const md = readFileSync(join(p.out, 'tune-up.md'), 'utf8');
  assert.doesNotMatch(md, /Best proposed tune-up/); assert.match(md, /Not verified: incomplete evidence/);
  assert.match(md, /2 run\(s\) went from failed to couldn't tell/);
});

test('R2 / checklist 7: with one run per test, tune proposes nothing unless --allow-single-repeat is given', () => {
  const p = project({ repeats: 1 }); runBaseline(p, BAD);
  const t = tune(p, { answers: GOOD });
  assert.equal(t.status, 0, t.stderr);
  assert.doesNotMatch(readFileSync(join(p.out, 'tune-up.md'), 'utf8'), /Best proposed tune-up/);
  assert.match(readFileSync(join(p.out, 'tune-up.md'), 'utf8'), /--allow-single-repeat/);
  const q = project({ repeats: 1 }); runBaseline(q, BAD);
  const t2 = tune(q, { answers: GOOD }, ['--allow-single-repeat', '--gate']);
  assert.equal(t2.status, EXIT.PASS, t2.stderr);
  assert.match(t2.stderr, /agenttuneup: PASS \(judged\) \[loosened: --allow-single-repeat\]/, 'the override is printed like any loosening');
  assert.match(readFileSync(join(q.out, 'tune-up.md'), 'utf8'), /Best proposed tune-up: attempt 1/);
  // The override is a tune option only.
  assert.equal(cli(['run', q.s, '--consent', '--allow-single-repeat', '--out', q.out], { answers: GOOD }).status, EXIT.USAGE);
});

test('R2 / checklist 3: tune --gate needs a fully checked baseline that meets --max-undetermined', () => {
  const p = project(); runBaseline(p, VAGUE);
  const t = tune(p, { answers: GOOD }, ['--gate']);
  assert.equal(t.status, EXIT.USAGE, t.stderr); assert.match(t.stderr, /baseline/);
  assert.equal(existsSync(join(p.out, 'attempt-1.json')), false, 'refused before anything was sent');
  const q = project(); runBaseline(q, VAGUE);
  assert.notEqual(tune(q, { answers: GOOD }, ['--gate', '--max-undetermined', '100']).status, EXIT.USAGE);
});

test('R2 / checklist 9: gate.json and report.json agree on the counts for the same run', () => {
  const p = project(); const r = cli(['run', p.s, '--consent', '--gate', '--json', '--out', p.out], { answers: VAGUE });
  assert.equal(r.status, EXIT.FAIL, r.stderr);
  const rep1 = JSON.parse(readFileSync(join(p.out, 'report.json'), 'utf8')), g = JSON.parse(readFileSync(join(p.out, 'gate.json'), 'utf8'));
  assert.deepEqual(rep1.counts, g.counts);
  const d = tmp(), chat = join(d, 'c.txt'); writeFileSync(chat, 'User: hi\nBot: We open at 9am.\n---\nUser: hi again\nBot: We open at 9am.\n---\njunk\n');
  const c = cli(['check', chat, '--json', '--out', join(d, 'o')]);
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'o', 'report.json'), 'utf8')).counts, JSON.parse(readFileSync(join(d, 'o', 'gate.json'), 'utf8')).counts);
});

test('R2 / checklist 6: a secret in a held chat never reaches report.json', () => {
  const d = tmp(), chat = join(d, 'c.txt'), priv = join(d, 'p.txt');
  writeFileSync(priv, 'Zanzibarco\n');
  writeFileSync(chat, 'User: my code is Zanzibarco, what time do you open?\nBot: Zanzibarco noted. We open at 9am.\n');
  const c = cli(['check', chat, '--private', priv, '--consent', '--out', join(d, 'o')], { answers: GOOD });
  assert.equal(c.status, 0, c.stderr);
  const raw = readFileSync(join(d, 'o', 'report.json'), 'utf8');
  assert.doesNotMatch(raw, /zanzibarco/i);
  assert.equal(JSON.parse(raw).schema, REPORT_SCHEMA);
});

test('R2: checkReport and fullyEvaluated edge cases (mutation survivors in src/tune.js)', () => {
  // tune compares judged runs only: a rules-only report is refused (review: R2 finding 4)...
  const r = rep(['ok'], { judgeModel: 'none (rule checks only)' });
  r.runs[0].findings = [{ bucket: 'happy', code: 'no_friction', ok: true }]; r.runs[0].state = 'ok'; r.suite_id = 's';
  assert.throws(() => checkReport(r, { suiteId: 's', expected: [{ case: 'c1', rep: 1 }] }), /without the judge/);
  // ...and the same runs in a judged report are missing their judge answer.
  const j = structuredClone(r); j.judge = 'typesafe/jev-1.13';
  assert.throws(() => checkReport(j, { suiteId: 's', expected: [{ case: 'c1', rep: 1 }] }), /says ok, but its findings say missing/);
  for (const bad of [null, 'report', 7]) assert.throws(() => checkReport(bad, { suiteId: 's', expected: [] }), (e) => e instanceof ReportError && /not a report/.test(e.message), String(bad));
  assert.equal(fullyEvaluated({ runs: [] }), false, 'nothing evaluated is never "fully checked"');
});

test('R2 review: malformed runs, edited failures and passing-check details never get through', () => {
  const r = rep(['ok', 'failed']); r.suite_id = 's';
  const ctx = { suiteId: 's', expected: [{ case: 'c1', rep: 1 }, { case: 'c2', rep: 1 }] };
  for (const bad of [null, 'x', { case: 1, rep: 1 }, { case: 'c1', rep: '1' }]) {
    const x = structuredClone(r); x.runs[0] = bad;
    assert.throws(() => checkReport(x, ctx), (e) => e instanceof ReportError && /not a case-run/.test(e.message), JSON.stringify(bad));
  }
  const hidden = structuredClone(r); hidden.failures = [];
  assert.throws(() => checkReport(hidden, ctx), /failures do not match its findings/);
  const edited = structuredClone(r); edited.failures[0].detail = 'something else';
  assert.throws(() => checkReport(edited, ctx), /failures do not match/);
  const noList = structuredClone(r); delete noList.failures;
  assert.throws(() => checkReport(noList, ctx), /failures do not match/);
  // A forbidden phrase the agent did NOT say is not written to report.json (review: R2 finding 3).
  const p = buildReport({ suite, instructions: 'x', adapter, judgeModel: 'typesafe/jev-1.13', evidenceLevel: 2,
    runs: [{ case: 'c1', rep: 1, findings: [...OK, { bucket: 'rules', code: 'must_not_say', ok: true, detail: 'Did not reveal "ACME-DISCOUNT-7731"' }], turns: [], ms: 0, tokens: 0, toolCalls: 0 }] });
  assert.doesNotMatch(JSON.stringify(p), /ACME-DISCOUNT-7731/);
  assert.equal(p.runs[0].state, 'ok');
});

test('R2 review: a hand-edited or broken attempt file is recomputed or ignored, never trusted and never a crash', () => {
  const p = project(); runBaseline(p, BAD);
  assert.equal(tune(p, { answers: BAD }).status, 0);
  const f = join(p.out, 'attempt-1.json'), a = JSON.parse(readFileSync(f, 'utf8'));
  // Claims a big lift its own re-run does not support.
  writeFileSync(f, JSON.stringify({ ...a, lift: 5, regressions: [], evidence: undefined }));
  writeFileSync(join(p.out, 'attempt-2.json'), '{"schema":"agenttuneup/attempt@0.2"');   // cut off mid-write
  writeFileSync(join(p.out, 'attempt-3.json'), JSON.stringify({ ...a, fix: null }));
  writeFileSync(join(p.out, 'gate.json'), '{"verdict":"PASS (judged)","exit":0}');      // left by an earlier run
  const t = tune(p, { answers: BAD }, ['--gate', '--json']);
  assert.equal(t.status, EXIT.FAIL, t.stderr); assert.doesNotMatch(t.stderr, /crashed/);
  const md = readFileSync(join(p.out, 'tune-up.md'), 'utf8');
  assert.match(md, /\| 1 \| 0 \|/, 'attempt 1 shows its recomputed lift, not the edited +5');
  assert.doesNotMatch(md, /\| 3 \|/, 'an attempt with no fix is ignored');
  assert.equal(existsSync(join(p.out, 'gate.json')), false, 'no stale gate.json next to a tune.json that gated nothing');
  assert.equal(JSON.parse(readFileSync(join(p.out, 'tune.json'), 'utf8')).selected_attempt, null);
});
