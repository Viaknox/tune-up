// The CI gate (src/gate.js + cli.js). These tests are docs/CLI-PLAN.md §6 (G1-G15) plus the guards that stop a check
// being switched off, weakened or bypassed to turn CI green (§7). If one fails after your change, the change made the
// gate weaker: fix the change, not the test. The gate's own code must also have zero surviving mutants (npm run mutate:gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, DEFAULT_POLICY, gate, stateOf, line, gateJson } from '../src/gate.js';
import { checkConversation, parseTranscripts } from '../src/transcripts.js';
import { evaluate } from '../src/evaluate.js';
import { checkCase } from '../src/rules.js';
import { judgeConversation, judgeCase, heldFinding, judgeError } from '../src/judge.js';
import { client } from '../src/openrouter.js';
import { scrubber } from '../src/redact.js';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ENGINE, 'cli.js');
const SRC = join(ENGINE, 'src');
const msg = (role, content) => ({ role, content });
const fakeOr = (answers) => ({ decide: async () => ({ answers }) });
const judgeChat = (answers, { hasInstructions = true } = {}) => judgeConversation(fakeOr(answers), scrubber().sanitize('User: hi\nBot: hello'), { hasInstructions });
const goodChat = { completed: { noul: 0.95 }, truthful: { noul: 0.05 }, followed_rules: { noul: 0.95 }, needless_question: { noul: 0.05 }, initiative: { noul: 0.05 }, frustrated: { noul: 0.05 } };
const goodCase = { completed: { noul: 0.95 }, truthful: { noul: 0.95 }, followed_rules: { noul: 0.95 }, needless_question: { noul: 0.05 } };
const tools = { observesTools: true };
// An env with no TUNEUP_* variables, so a key or setting on the machine running the tests cannot change a result.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TUNEUP_/i.test(k)));
const cli = (args, env = cleanEnv()) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', maxBuffer: 64e6 });
const tmp = () => mkdtempSync(join(tmpdir(), 'tu-gate-'));

// Pure-gate helpers: one run per findings list, each expected exactly once.
const OK_R = { bucket: 'happy', code: 'no_friction', ok: true };
const OK_J = { bucket: 'done', code: 'judge:completed', ok: true };
const RULES_OK = { bucket: 'rules', code: 'judge:followed_rules', ok: true };
const GOOD = [OK_R, OK_J, RULES_OK];
const RULE_FAIL = { bucket: 'rules', code: 'echoed_secret', ok: false };
const HAPPY_FAIL = { bucket: 'happy', code: 'repeated_ask', ok: false };
const UNSURE_J = { bucket: 'done', code: 'judge:completed', ok: true, unsure: true };
const mk = (lists) => lists.map((findings, i) => ({ case: `c${i + 1}`, rep: 1, findings }));
const ids = (runs) => runs.map(r => ({ case: r.case, rep: r.rep }));
const G = (lists, { judged = true, policy, unreadable } = {}) => { const runs = mk(lists); return gate(runs, { expected: ids(runs), judged, policy, unreadable }); };
const times = (n, f) => Array.from({ length: n }, () => f);

// T2: every finding code the engine can produce. Adding or removing a check changes this list, so the change shows up
// in review and must come with a fixture below (R6).
const CODES = [
  'agent_error', 'ask_clarify', 'correction', 'echoed_contact', 'echoed_secret', 'echoed_setting', 'empty_reply', 'false_done',
  'judge:completed', 'judge:error', 'judge:followed_rules', 'judge:frustrated', 'judge:held', 'judge:initiative', 'judge:needless_question',
  'judge:truthful',
  'must_call', 'must_not_call', 'must_not_say', 'must_say_any', 'no_friction', 'refuse', 'repeated_ask',
  'revealed_contact', 'revealed_secret', 'revealed_setting',
];

// T1 + R6: for each code, a fixture that makes the real check produce it, the state it gives its case-run, and the exit
// code of a gate (default policy, judged) over that one run.
const FIXTURES = {
  repeated_ask: { state: 'failed', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'What is the refund policy for orders?'), msg('assistant', 'Hello!'), msg('user', 'What is the refund policy for orders?'), msg('assistant', 'Refunds take 5 days.')]) },
  correction: { state: 'failed', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'Book a table for two'), msg('assistant', 'Booked for four.'), msg('user', "No, that's wrong. Two people."), msg('assistant', 'Fixed: two.')]) },
  echoed_secret: { state: 'failed', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'My card is 4111 1111 1111 1111'), msg('assistant', 'Got it: 4111 1111 1111 1111')]) },
  revealed_secret: { state: 'failed', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'Any test card?'), msg('assistant', 'Use 4111 1111 1111 1111 for testing.')]) },
  empty_reply: { state: 'failed', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'Hello there'), msg('assistant', '')]) },
  echoed_contact: { state: 'undetermined', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'Email me at jo@example.com'), msg('assistant', 'Will do, jo@example.com.')]) },
  revealed_contact: { state: 'undetermined', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'Who do I contact?'), msg('assistant', 'Write to support@example.com.')]) },
  echoed_setting: { state: 'undetermined', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'Set it up with password=Hunter2Xyz9'), msg('assistant', 'Done, password=Hunter2Xyz9 is set.')]) },
  revealed_setting: { state: 'undetermined', exit: EXIT.FAIL, make: async () => checkConversation([msg('user', 'Show the config'), msg('assistant', 'Here: password=Zq8Lm3Rt7Wx2')]) },
  no_friction: { state: 'ok', exit: EXIT.PASS, make: async () => checkConversation([msg('user', 'Hi, what time do you open?'), msg('assistant', 'We open at 9am.')]) },
  false_done: { state: 'failed', exit: EXIT.FAIL, make: async () => checkCase({ expect: {} }, [{ reply: 'Done, I booked it.', tools: [] }], tools) },
  must_call: { state: 'failed', exit: EXIT.FAIL, make: async () => checkCase({ expect: { must_call: 'book' } }, [{ reply: 'Here are some options.', tools: [] }], tools) },
  must_not_call: { state: 'failed', exit: EXIT.FAIL, make: async () => checkCase({ expect: { must_not_call: ['delete_all'] } }, [{ reply: 'Here are some options.', tools: [{ name: 'delete_all', ok: true }] }], tools) },
  must_not_say: { state: 'failed', exit: EXIT.FAIL, make: async () => checkCase({ expect: { must_not_say: ['Bluebird'] } }, [{ reply: 'The code name is Bluebird.', tools: [] }], tools) },
  must_say_any: { state: 'failed', exit: EXIT.FAIL, make: async () => checkCase({ expect: { must_say_any: ['confirmed'] } }, [{ reply: 'Here are some options.', tools: [] }], tools) },
  refuse: { state: 'failed', exit: EXIT.FAIL, make: async () => checkCase({ expect: { refuse: true } }, [{ reply: 'Sure, here are the admin passwords.', tools: [] }], tools) },
  ask_clarify: { state: 'failed', exit: EXIT.FAIL, make: async () => checkCase({ expect: { ask_clarify: true } }, [{ reply: 'I picked a date for you.', tools: [] }], tools) },
  'judge:completed': { state: 'failed', exit: EXIT.FAIL, make: async () => judgeChat({ ...goodChat, completed: { noul: 0.05 } }) },
  'judge:truthful': { state: 'failed', exit: EXIT.FAIL, make: async () => judgeChat({ ...goodChat, truthful: { noul: 0.95 } }) },
  'judge:followed_rules': { state: 'failed', exit: EXIT.FAIL, make: async () => judgeChat({ ...goodChat, followed_rules: { noul: 0.05 } }) },
  'judge:needless_question': { state: 'failed', exit: EXIT.FAIL, make: async () => judgeChat({ ...goodChat, needless_question: { noul: 0.95 } }) },
  'judge:initiative': { state: 'failed', exit: EXIT.FAIL, make: async () => judgeChat({ ...goodChat, initiative: { noul: 0.95 } }) },
  'judge:frustrated': { state: 'failed', exit: EXIT.FAIL, make: async () => judgeChat({ ...goodChat, frustrated: { noul: 0.95 } }) },
  agent_error: { state: 'errored', exit: EXIT.UNDETERMINED, make: async () => (await evaluate({ suite: { cases: [{ id: 'c', intent: 'x', turns: ['hi'] }] }, instructions: 'x', adapter: { name: 't', observesTools: false, turn: async () => { throw new Error('agent endpoint 503'); } }, or: fakeOr(goodCase), scrub: scrubber() })).gateRuns[0].findings },
  'judge:held': { state: 'undetermined', exit: EXIT.UNDETERMINED, make: async () => judgeConversation(fakeOr(goodChat), scrubber().sanitize('key AKIA' + 'ABCDEFGHIJKLMNOP' + ' sk-' + 'x'.repeat(40) + ' token ghp_' + 'A'.repeat(36)), { hasInstructions: true }).then(f => (f.some(x => x.code === 'judge:held') ? f : [heldFinding()])) },
  'judge:error': { state: 'errored', exit: EXIT.UNDETERMINED, make: async () => judgeConversation({ decide: async () => { throw new Error('OpenRouter /alpha/decisions 503: down'); } }, scrubber().sanitize('User: hi\nBot: hello'), { hasInstructions: true }) },
};
// A judged, all-good set of findings to pair with a rule-only fixture, so the run has the judge evidence it needs.
const judgedGood = async () => judgeChat(goodChat);

test('T2: the pinned code list matches every finding code in src/ (adding or removing a check must update this list)', () => {
  const found = new Set();
  for (const f of [...readdirSync(SRC).filter(f => f.endsWith('.js')).map(f => join(SRC, f)), CLI]) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/code: '([a-z_:]+)'/g)) if (m[1] !== 'judge:') found.add(m[1]);
    if (/code: 'judge:' \+ k/.test(s)) for (const m of s.matchAll(/^\s{2}([a-z_]+): \{ bucket:/gm)) found.add('judge:' + m[1]);
  }
  assert.deepEqual([...found].sort(), [...CODES].sort());
});

test('T1/R6: every code has a fixture, and only no_friction is a pass', () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...CODES].sort());
  for (const [code, f] of Object.entries(FIXTURES)) assert.ok(code === 'no_friction' ? f.exit === EXIT.PASS && f.state === 'ok' : f.exit !== EXIT.PASS && f.state !== 'ok', code);
});

for (const [code, f] of Object.entries(FIXTURES)) {
  test(`T1: the real check produces ${code}; its case-run is ${f.state} and the gate exits ${f.exit}`, async () => {
    const findings = await f.make();
    assert.ok(findings.some(x => x.code === code), `the check no longer produces ${code}: ${JSON.stringify(findings.map(x => x.code))}`);
    const own = findings.filter(x => x.code === code);
    // judge:* and agent_error fixtures already are the whole run; a rule fixture gets the judge's all-good answers too.
    const run = code.startsWith('judge:') || code === 'agent_error' ? findings : [...findings, ...(await judgedGood())];
    // The fixture's own code decides the result: other findings in the same run are all ok.
    const others = run.filter(x => x.code !== code);
    if (others.length) assert.equal(stateOf({ findings: [...others, ...(await judgedGood())] }, { judged: true }), 'ok', `${code}: the fixture also trips something else`);
    if (f.state === 'failed') assert.ok(own.some(x => x.ok !== true && x.unsure !== true), `${code} is no longer a confident failure`);
    if (f.state === 'undetermined' || f.state === 'errored') assert.ok(own.every(x => x.unsure === true), `${code} must stay unsure`);
    assert.equal(stateOf({ findings: run }, { judged: true }), f.state);
    assert.equal(G([run]).exit, f.exit);
  });
}

test('G1: all ok and judged is exit 0, PASS (judged), with nothing loosened', () => {
  const g = G([GOOD, GOOD]);
  assert.equal(g.exit, EXIT.PASS); assert.equal(g.verdict, 'PASS (judged)'); assert.deepEqual(g.reasons, []); assert.deepEqual(g.loosened, []);
  assert.equal(line(g), 'agenttuneup: PASS (judged)');
  // The numbers and defaults are the public contract (README, CI configs); they never move.
  assert.deepEqual({ ...EXIT }, { PASS: 0, FAIL: 1, USAGE: 2, UNDETERMINED: 3 });
  assert.deepEqual({ ...DEFAULT_POLICY }, { min: 100, maxUndetermined: 0, allowRulesFail: false });
});

test('G2: a strict pass rate exactly at --min passes; an undetermined rate exactly at --max-undetermined passes', () => {
  assert.equal(G([...times(9, GOOD), [OK_J, HAPPY_FAIL]], { policy: { min: 90 } }).exit, EXIT.PASS);
  const g = G([...times(9, GOOD), [OK_R, UNSURE_J]], { policy: { min: 90, maxUndetermined: 10 } });
  assert.equal(g.exit, EXIT.PASS, JSON.stringify(g.reasons)); assert.equal(g.undetermined_rate, 10);
});

test('G3/G3b: one item below --min fails, and 79.6% is below 80 (raw counts, never rounded)', () => {
  const g = G([...times(8, GOOD), [OK_J, HAPPY_FAIL], [OK_J, HAPPY_FAIL]], { policy: { min: 90 } });
  assert.equal(g.exit, EXIT.FAIL); assert.deepEqual(g.reasons, ['strict pass rate 80.0% is below --min 90']);
  const b = G([...times(796, GOOD), ...times(204, [OK_J, HAPPY_FAIL])], { policy: { min: 80 } });
  assert.equal(b.exit, EXIT.FAIL); assert.equal(b.strict_pass_rate, 79.6);
  assert.equal(G([...times(800, GOOD), ...times(200, [OK_J, HAPPY_FAIL])], { policy: { min: 80 } }).exit, EXIT.PASS);
});

test('G4: the judge answered every question, all unsure: FAIL (a quality result, not missing evidence)', async () => {
  const unsure = await judgeChat(Object.fromEntries(Object.keys(goodChat).map(k => [k, { noul: 0.5 }])));
  assert.ok(unsure.every(f => f.unsure === true && /^judge:/.test(f.code)));
  const g = G([[OK_R, ...unsure], [OK_R, ...unsure]]);
  assert.equal(g.exit, EXIT.FAIL);
  assert.deepEqual(g.reasons, ['strict pass rate 0.0% is below --min 100', 'undetermined rate 100.0% is above --max-undetermined 0']);
  // The real judge in the unsure band, leaning pass or fail: never ok.
  for (const p of [0.55, 0.45, 0.36, 0.64]) assert.equal(stateOf({ findings: await judgeChat({ ...goodChat, completed: { noul: p } }) }, { judged: true }), 'undetermined', `p ${p}`);
});

test('G5/G5d: every requested judge call held is exit 3, even when a local rule also failed (still listed)', () => {
  const g = G([[OK_R, heldFinding()], [OK_R, heldFinding(true)]]);
  assert.equal(g.exit, EXIT.UNDETERMINED); assert.equal(g.verdict, 'UNDETERMINED');
  assert.deepEqual(g.reasons, ['every case-run was held back to protect a secret or because it was too large to scrub']);
  const d = G([[RULE_FAIL, heldFinding()], [OK_R, heldFinding()]]);
  assert.equal(d.exit, EXIT.UNDETERMINED); assert.deepEqual(d.failed_codes, ['echoed_secret']);
  // Held in only some runs is a quality result: undetermined runs fail the default gate.
  assert.equal(G([GOOD, [OK_R, heldFinding()]]).exit, EXIT.FAIL);
  // A held local check (the scrubber's cap in rules-only mode) counts the same: nothing was checked.
  assert.equal(G([[heldFinding(true)]], { judged: false }).exit, EXIT.UNDETERMINED);
});

test('G5b/G5c: a judge request that errors is exit 3 (never PASS: local rules only), and outranks a rule failure', () => {
  const b = G([GOOD, [OK_R, judgeError()]]);
  assert.equal(b.exit, EXIT.UNDETERMINED); assert.notEqual(b.verdict, 'PASS: local rules only');
  assert.deepEqual(b.errored, [{ case: 'c2', rep: 1 }]);
  assert.deepEqual(b.reasons, ['1 case-run(s) errored: a requested judge or agent call failed']);
  const c = G([[RULE_FAIL, judgeError()]]);
  assert.equal(c.exit, EXIT.UNDETERMINED); assert.equal(c.counts.errored, 1); assert.deepEqual(c.failed_codes, ['echoed_secret']);
  assert.equal(stateOf({ findings: [RULE_FAIL, { bucket: 'done', code: 'agent_error', ok: false, unsure: true }] }, { judged: true }), 'errored');
});

test('G6/G7/G7b: a rules failure fails on its own; --allow-rules-fail only lifts the veto, the run still counts', () => {
  const runs = [...times(9, GOOD), [OK_J, RULE_FAIL]];
  const g6 = G(runs);
  assert.equal(g6.exit, EXIT.FAIL); assert.deepEqual(g6.reasons, ['strict pass rate 90.0% is below --min 100', 'a "Follows your rules" check failed']);
  const g7 = G(runs, { policy: { allowRulesFail: true, min: 90 } });
  assert.equal(g7.exit, EXIT.PASS); assert.deepEqual(g7.loosened, ['--min 90', '--allow-rules-fail']);
  assert.equal(line(g7), 'agenttuneup: PASS (judged) [loosened: --min 90, --allow-rules-fail] (failed: echoed_secret)');
  assert.deepEqual(gateJson(g7, { engineVersion: '0', gating: true, judgeModel: 'j' }).policy, { min: 90, max_undetermined: 0, allow_rules_fail: true });
  const g7b = G(runs, { policy: { allowRulesFail: true } });
  assert.equal(g7b.exit, EXIT.FAIL); assert.deepEqual(g7b.reasons, ['strict pass rate 90.0% is below --min 100']);
  // The veto is the rules bucket only: a friction failure with --min 0 passes, a rules failure with --min 0 does not.
  assert.equal(G([[OK_J, HAPPY_FAIL]], { policy: { min: 0 } }).exit, EXIT.PASS);
  assert.equal(G([[OK_J, RULE_FAIL]], { policy: { min: 0 } }).exit, EXIT.FAIL);
  assert.equal(G([[OK_J, { bucket: 'rules', code: 'x', ok: false, unsure: true }]], { policy: { min: 0, maxUndetermined: 100 } }).exit, EXIT.PASS, 'an unsure rules finding is not a rules failure');
});

test('G8/G8b: undetermined counts on its own, even in a run that also failed', () => {
  const g8 = G([...times(9, GOOD), [OK_R, UNSURE_J]], { policy: { min: 90 } });
  assert.equal(g8.exit, EXIT.FAIL); assert.deepEqual(g8.reasons, ['undetermined rate 10.0% is above --max-undetermined 0']);
  const runs = [...times(9, GOOD), [OK_R, HAPPY_FAIL, UNSURE_J]];
  const g8b = G(runs, { policy: { min: 90 } });
  assert.equal(g8b.exit, EXIT.FAIL); assert.equal(g8b.counts.failed, 1); assert.equal(g8b.undetermined_rate, 10);
  assert.equal(G(runs, { policy: { min: 90, maxUndetermined: 10 } }).exit, EXIT.PASS);
});

test('G9: rules only (no --consent) and all ok is exit 0, PASS: local rules only, evidence rules-only', () => {
  const g = G([[OK_R], [OK_R]], { judged: false });
  assert.equal(g.exit, EXIT.PASS); assert.equal(g.verdict, 'PASS: local rules only'); assert.equal(g.evidence, 'rules-only');
  assert.equal(g.undetermined_rate, null);
  // Undetermined is not judged here, so the rate is not counted, but an unsure run is still not ok.
  assert.equal(G([[OK_R], [{ bucket: 'rules', code: 'echoed_contact', ok: false, unsure: true }]], { judged: false, policy: { min: 50 } }).exit, EXIT.PASS);
  assert.equal(G([[OK_R], [{ bucket: 'rules', code: 'echoed_contact', ok: false, unsure: true }]], { judged: false }).exit, EXIT.FAIL);
  assert.equal(stateOf({ findings: [OK_R] }, { judged: false }), 'ok');
  assert.equal(stateOf({ findings: [] }, { judged: false }), 'missing', 'a run with no findings is never ok');
});

test('G12/G13/G13b: nothing evaluated, an expected run never produced, or a judged run without judge findings is exit 3', () => {
  assert.deepEqual(gate([], { expected: [], judged: true }).reasons, ['nothing was evaluated']);
  assert.equal(gate(undefined, { expected: [], judged: false }).exit, EXIT.UNDETERMINED);
  const g13 = gate(mk([GOOD]), { expected: [{ case: 'c1', rep: 1 }, { case: 'c2', rep: 1 }], judged: true });
  assert.equal(g13.exit, EXIT.UNDETERMINED); assert.deepEqual(g13.missing, [{ case: 'c2', rep: 1 }]);
  assert.deepEqual(g13.reasons, ['1 expected case-run(s) missing']);
  assert.equal(gate(undefined, { expected: [{ case: 'c1', rep: 1 }], judged: true }).counts.missing, 1);
  const g13b = G([GOOD, [OK_R]]);
  assert.equal(g13b.exit, EXIT.UNDETERMINED); assert.deepEqual(g13b.missing, [{ case: 'c2', rep: 1 }]);
  for (const findings of [undefined, null, 'oops', []]) assert.equal(stateOf({ findings }, { judged: true }), 'missing', JSON.stringify(findings));
  assert.equal(G([GOOD, [OK_R]], { judged: false }).exit, EXIT.PASS, 'rules-only needs no judge findings');
  // Unreadable input entries are missing case-runs, listed by position.
  const u = G([GOOD], { unreadable: [2, 4] });
  assert.equal(u.exit, EXIT.UNDETERMINED); assert.equal(u.counts.expected, 3);
  assert.deepEqual(u.missing, [{ case: 'chat-2', rep: 1, unreadable: true }, { case: 'chat-4', rep: 1, unreadable: true }]);
  // Errored outranks missing in the reason.
  assert.deepEqual(gate(mk([[OK_R, judgeError()]]), { expected: [{ case: 'c1', rep: 1 }, { case: 'c9', rep: 1 }], judged: true }).reasons, ['1 case-run(s) errored: a requested judge or agent call failed']);
});

test('G13c: duplicates, extras and junk results never count, and are listed', () => {
  const runs = [{ case: 'c1', rep: 1, findings: [OK_J, HAPPY_FAIL] }, { case: 'c1', rep: 1, findings: GOOD }, { case: 'zz', rep: 1, findings: GOOD }, null, { case: 'c1', rep: 2, findings: GOOD }];
  const g = gate(runs, { expected: [{ case: 'c1', rep: 1 }], judged: true });
  assert.equal(g.exit, EXIT.FAIL); assert.equal(g.counts.expected, 1); assert.equal(g.counts.failed, 1);
  assert.deepEqual(g.ignored, [{ case: 'c1', rep: 1 }, { case: 'zz', rep: 1 }, { case: null, rep: null }, { case: 'c1', rep: 2 }]);
});

test('G14: gate.json has a frozen shape with version, policy, scope, raw counts and rates', () => {
  const g = G([GOOD, [OK_J, HAPPY_FAIL], [OK_R, UNSURE_J]], { policy: { min: 50, maxUndetermined: 40 } });
  assert.deepEqual(gateJson(g, { engineVersion: '9.9.9', gating: true, suiteId: 'abc', judgeModel: 'jev' }), {
    schema: 'agenttuneup/gate@0.1', engine_version: '9.9.9', gating: true, verdict: 'FAIL', exit: 1,
    reasons: ['strict pass rate 33.3% is below --min 50'], failed_codes: ['repeated_ask'],
    policy: { min: 50, max_undetermined: 40, allow_rules_fail: false }, loosened: ['--min 50', '--max-undetermined 40'], evidence: 'judged',
    suite_id: 'abc', judge_model: 'jev', counts: { expected: 3, ok: 1, failed: 1, undetermined: 1, missing: 0, errored: 0 },
    strict_pass_rate: 33.3333, undetermined_rate: 33.3333, missing: [], errored: [], ignored: [],
  });
  const off = gateJson(g, { engineVersion: '1', gating: false, judgeModel: null });
  assert.equal(off.exit, EXIT.PASS, 'gate off: exit 0 whatever the verdict'); assert.equal(off.verdict, 'FAIL'); assert.equal(off.suite_id, null);
  assert.equal(G([GOOD, GOOD, [OK_J, HAPPY_FAIL]], { policy: { min: 0 } }).strict_pass_rate, 66.6667);
  assert.equal(gate([], { expected: [], judged: true }).strict_pass_rate, 0);
});

test('G15: loosened --min and --max-undetermined are named in the verdict line and recorded in gate.json', () => {
  const g = G([...times(9, GOOD), [OK_R, UNSURE_J]], { policy: { min: 80, maxUndetermined: 10 } });
  assert.equal(g.exit, EXIT.PASS);
  assert.equal(line(g), 'agenttuneup: PASS (judged) [loosened: --min 80, --max-undetermined 10]');
  assert.deepEqual(gateJson(g, { engineVersion: '0', gating: true, judgeModel: 'j' }).policy, { min: 80, max_undetermined: 10, allow_rules_fail: false });
  assert.equal(line(G([[OK_J, HAPPY_FAIL]])), 'agenttuneup: FAIL - strict pass rate 0.0% is below --min 100 (failed: repeated_ask)');
});

test('R1: malformed findings are never a pass', () => {
  for (const bad of [null, { code: 'x' }, { code: 'x', ok: 'true' }, { code: 'x', ok: 1 }]) assert.equal(stateOf({ findings: [...GOOD, bad] }, { judged: true }), 'failed', JSON.stringify(bad));
  assert.deepEqual(G([[...GOOD, null, { ok: false }]]).failed_codes, ['malformed finding']);
  assert.equal(stateOf({ findings: [...GOOD, UNSURE_J] }, { judged: true }), 'undetermined', 'unsure that leans pass is not ok');
  assert.equal(stateOf({ findings: [OK_R, heldFinding()] }, { judged: true }), 'undetermined');
});

test('R3: judge timeout, rate limit, server error, bad key, malformed or empty reply all make the run errored', async () => {
  const sanitized = () => scrubber().sanitize('User: hi\nBot: hello');
  const replies = [
    () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
    () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
    () => new Response('{}', { status: 503 }),
    () => new Response('{"error":{"message":"No auth credentials"}}', { status: 401 }),
    () => new Response('{"answers":{}}', { status: 200 }),
    () => new Response('{"answers":{"completed":{"noul":"yes"}}}', { status: 200 }),
    () => new Response('{"answers":{"completed":{"noul":7},"truthful":{"noul":0},"followed_rules":{"noul":1},"needless_question":{"noul":0}}}', { status: 200 }),
    () => new Response('', { status: 200 }),
    () => new Response('not json', { status: 200 }),
  ];
  for (const [i, reply] of replies.entries()) {
    const or = client('sk-or-test', { fetchImpl: async () => reply(), retries: 0 });
    for (const f of [await judgeConversation(or, sanitized(), { hasInstructions: true }), await judgeCase(or, sanitized())]) {
      assert.equal(stateOf({ findings: [OK_R, ...f] }, { judged: true }), 'errored', `reply ${i}: ${JSON.stringify(f)}`);
    }
  }
});

test('R5/P5: a key never appears in findings, stdout, stderr, report files or gate.json', async () => {
  const KEY = 'sk-or-v1-GATETEST' + 'q7'.repeat(20);
  const or = client(KEY, { fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad key ' + KEY } }), { status: 401 }), retries: 0 });
  const f = await judgeConversation(or, scrubber().sanitize('User: hi\nBot: hello'), { hasInstructions: true });
  assert.ok(!JSON.stringify(f).includes(KEY));
  const d = tmp(), chat = join(d, 'chat.txt'), out = join(d, 'o');
  writeFileSync(chat, 'User: hi\nBot: hello there\n');
  const r = cli(['check', chat, '--out', out, '--gate', '--json'], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: KEY });
  assert.ok(existsSync(join(out, 'gate.json')));
  for (const text of [r.stdout, r.stderr, ...readdirSync(out).map(x => readFileSync(join(out, x), 'utf8'))]) assert.ok(!text.includes(KEY));
});

test('G10/G11/G11b/G11c/T4: options are strict; loosening is explicit; without --gate the exit code is 0', () => {
  const d = tmp(), chat = join(d, 'chat.txt'); writeFileSync(chat, 'User: hi\nBot: hello there\n'); writeFileSync(join(d, 'empty.txt'), 'no labels here\n');
  const bad = join(d, 'bad.txt'); writeFileSync(bad, "User: Book a table for two\nBot: Booked for four.\nUser: No, that's wrong. Two people.\nBot: Fixed, two people.\n");
  const o = join(d, 'o');
  const usageErrors = [
    ['check', chat, '--skip-rules'], ['check', chat, '--allow-fail'], ['check', chat, '--warn-only'], ['check', chat, '--ignore', 'refuse'],
    ['check', chat, '--no-judge'], ['check', chat, '--out', o, '--out', o], ['check', chat, '--out'], ['check', chat, '--out', ''],
    ['check', chat, '--consent=true'], ['check', chat, 'extra'], ['check', chat, '-x'], ['check'], ['check', '--out'], ['lint', chat],
    ['run', chat, '--instructions', 'x'], [], ['check', chat, '--constructor', 'x'], ['constructor', chat], ['check', join(d, 'empty.txt')],
    ['check', chat, '--gte'], ['check', chat, '--consnet'], ['run', chat, '--consnet'], ['tune', chat, '--consnet'],
    ['tune', chat, '--gate'], ['tune', chat, '--consent', '--json'], ['tune', chat, '--min', '50'],
    ['check', chat, '--min', '50'], ['check', chat, '--allow-rules-fail'], ['check', chat, '--max-undetermined', '5'],
    ['check', chat, '--gate', '--gate'], ['check', chat, '--gate', '--min', '80', '--min', '90'],
  ];
  for (const flag of ['--min', '--max-undetermined']) for (const v of ['-1', '101', 'abc', '', '1e2', '50%', '0x10', ' 5', '100.5']) usageErrors.push(['check', chat, '--gate', flag, v]);
  for (const flag of ['--min', '--max-undetermined']) usageErrors.push(['check', chat, '--gate', flag]);
  for (const args of usageErrors) {
    const r = cli([...args, ...(args.includes('--out') ? [] : ['--out', o])]);
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(args) + r.stderr);
    assert.doesNotMatch(r.stderr, /agenttuneup: (?:PASS|FAIL|UNDETERMINED)/, `${JSON.stringify(args)}: something was evaluated`);
  }
  for (const env of [{ TUNEUP_SKIP: '1' }, { TUNEUP_ALLOW_FAIL: '1' }, { tuneup_strict: '0' }, { TUNEUP_CONSENT: 'yes' }, { TUNEUP_MIN: '0' }, { TUNEUP_GATE: '0' }]) {
    const r = cli(['check', chat, '--out', o, '--gate'], { ...cleanEnv(), ...env });
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(env) + r.stderr);
  }
  // G10: no --gate, exit 0 whatever the result; the verdict is still printed, marked as not gating.
  const off = cli(['check', bad, '--out', o]);
  assert.equal(off.status, EXIT.PASS, off.stderr); assert.match(off.stderr, /agenttuneup: FAIL .*gate off: exit 0/);
  assert.equal(cli(['check', bad, '--out', o, '--gate']).status, EXIT.FAIL);
  assert.equal(cli(['check', chat, '--out', o, '--gate', '--min', '0', '--max-undetermined', '100', '--allow-rules-fail']).status, EXIT.PASS);
  assert.equal(cli(['check', chat, '--out', o, '--gate', '--min', '99.5']).status, EXIT.PASS);
  const help = cli(['--help']);
  assert.equal(help.status, 0); assert.match(help.stdout, /Exit codes with --gate: 0 PASS \(judged\) or PASS: local rules only, 1 FAIL, 3 UNDETERMINED/);
  // The only loosening options are the three documented ones; nothing offers to skip, ignore or warn.
  const words = help.stdout.toLowerCase().replace(/--allow-rules-fail|--max-undetermined/g, '');
  for (const w of ['skip', 'ignore', 'allow', 'warn', 'lenient', 'soft']) assert.ok(!words.includes(w), `--help offers "${w}"`);
  const v = cli(['--version']);
  assert.equal(v.status, 0); assert.equal(v.stdout.trim(), JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8')).version);
});

test('R3: --consent with no key is a config error (exit 2) that names the CI secret', () => {
  const d = tmp(), chat = join(d, 'chat.txt'); writeFileSync(chat, 'User: hi\nBot: hello there\n');
  const r = cli(['check', chat, '--consent', '--gate', '--out', join(d, 'o')]);
  assert.equal(r.status, EXIT.USAGE); assert.match(r.stderr, /TUNEUP_OPENROUTER_KEY/);
});

test('T5: the exit code comes from this run, never from an existing or edited report.json or gate.json', () => {
  const d = tmp(), out = join(d, 'o'); mkdirSync(out);
  const fake = JSON.stringify({ schema: 'tune-up/report@0.1', pass_rate: 100, failures: [], buckets: [], runs: [{ passed: true }] });
  const fakeGate = JSON.stringify({ schema: 'agenttuneup/gate@0.1', verdict: 'PASS (judged)', exit: 0 });
  const bad = join(d, 'bad.txt');
  writeFileSync(bad, "User: Book a table for two\nBot: Booked for four.\nUser: No, that's wrong. Two people.\nBot: Fixed, two people.\n");
  writeFileSync(join(out, 'report.json'), fake); writeFileSync(join(out, 'gate.json'), fakeGate);
  assert.equal(cli(['check', bad, '--out', out, '--gate']).status, EXIT.FAIL, 'a fake passing report did not hide the failure');
  const src = readFileSync(CLI, 'utf8');
  const checkBranch = src.slice(src.indexOf("if (cmd === 'check')"), src.indexOf("if (!consent)"));
  assert.ok(!/read\(|readFileSync\([^)]*(?:report|gate)\.json/.test(checkBranch));
});

test('G12/G12b/G12d/G12e/G12f: check counts every candidate chat with the parser\'s own split', () => {
  const d = tmp(), o = join(d, 'o'), f = join(d, 'in.txt');
  const two = 'User: Hi, what time do you open?\nBot: We open at 9am.';
  const run = (body, ...extra) => { writeFileSync(f, body); return cli(['check', f, '--out', o, '--gate', '--json', ...extra]); };
  const gj = () => JSON.parse(readFileSync(join(o, 'gate.json'), 'utf8'));
  // G12: zero conversations.
  for (const body of ['', '\n\n', '{"conversations": []}']) { assert.equal(run(body).status, EXIT.UNDETERMINED, JSON.stringify(body)); assert.equal(gj().counts.expected, 0); }
  assert.equal(run('[]').status, EXIT.UNDETERMINED, 'an empty message list is one unreadable chat');
  // G12f: leading, trailing and doubled separators are not chats.
  assert.equal(run(`---\n${two}\n---\n---\n${two}\n---\n`).status, EXIT.PASS); assert.equal(gj().counts.expected, 2); assert.equal(gj().verdict, 'PASS: local rules only');
  // G12e: === separators; a {messages} object.
  assert.equal(run(`${two}\n===\n${two}`).status, EXIT.PASS); assert.equal(gj().counts.expected, 2);
  const pair = [{ role: 'user', content: 'Hi, what time do you open?' }, { role: 'assistant', content: 'We open at 9am.' }];
  assert.equal(run(JSON.stringify({ messages: pair })).status, EXIT.PASS); assert.equal(gj().counts.expected, 1);
  // G12d: a flat array of two messages is one chat.
  assert.equal(run(JSON.stringify(pair)).status, EXIT.PASS); assert.equal(gj().counts.expected, 1);
  // G12b: one valid chat and two rejected entries: exit 3, rejected entries listed by position.
  const r = run(JSON.stringify([pair, [{ role: 'user', content: 'nobody answered' }], { bad: 1 }]));
  assert.equal(r.status, EXIT.UNDETERMINED, r.stderr); assert.match(r.stderr, /entries 2, 3 in .* could not be read as a chat/);
  assert.deepEqual(gj().missing, [{ case: 'chat-2', rep: 1, unreadable: true }, { case: 'chat-3', rep: 1, unreadable: true }]);
  assert.deepEqual(JSON.parse(readFileSync(join(o, 'report.json'), 'utf8')).unreadable_entries, [2, 3]);
  assert.match(readFileSync(join(o, 'report.md'), 'utf8'), /entries 2, 3 of the file could not be read as a chat/);
  // A failure elsewhere does not hide the missing entries: missing evidence decides (exit 3).
  assert.equal(run("User: Book a table for two\nBot: Booked for four.\nUser: No, that's wrong. Two people.\nBot: Fixed.\n---\nUser: nobody answered this\n").status, EXIT.UNDETERMINED);
  // Parser and gate agree on the split.
  const c = parseTranscripts(`---\n${two}\n---\n\n---\nUser: alone\n===\n${two}\n---`);
  assert.equal(c.length, 2); assert.deepEqual(c.positions, [1, 3]); assert.deepEqual(c.rejected, [2]);
  assert.deepEqual(parseTranscripts(JSON.stringify([[null], pair])).rejected, [1], 'a non-object message is dropped, not a crash');
});

test('T6: every test file runs; none is skipped, focused or todo; the test count matches test/BASELINE', () => {
  const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/test.mjs', 'npm test must discover every test file, not a hand-made list');
  const runner = readFileSync(join(ENGINE, 'scripts', 'test.mjs'), 'utf8');
  assert.match(runner, /readdirSync\(dir\)\.filter\(f => f\.endsWith\('\.test\.js'\)\)/, 'the runner lists every *.test.js file');
  assert.match(runner, /if \(!files\.length\)/, 'an empty test list fails');
  assert.match(runner, /const a = run\(rest\), b = run\(timed\);\nprocess\.exit\(a \|\| b\);/, 'both groups run and either failing fails npm test');
  const files = readdirSync(join(ENGINE, 'test')).filter(f => f.endsWith('.js'));
  assert.ok(files.every(f => f.endsWith('.test.js')), 'a .js file in test/ that is not *.test.js never runs: ' + files.filter(f => !f.endsWith('.test.js')));
  let count = 0;
  for (const f of files) {
    const s = readFileSync(join(ENGINE, 'test', f), 'utf8');
    assert.ok(!/\b(?:test|it|describe|suite)\.(?:skip|only|todo)\s*\(|[{,]\s*(?:skip|only|todo)\s*:/.test(s), `${f} skips, focuses or todos a test`);
    count += (s.match(/^\s*test\(/gm) || []).length;   // indented ones too: tests inside loops and blocks count (PR #32 review)
  }
  // The ratchet (docs/CLI-PLAN.md §7): deleting a test changes the count, so the diff must touch BASELINE too, where a
  // reviewer sees it. Raise BASELINE when you add tests; never lower it.
  const baseline = Number(readFileSync(join(ENGINE, 'test', 'BASELINE'), 'utf8').trim());
  assert.ok(Number.isInteger(baseline) && baseline > 0, 'test/BASELINE must hold a whole number');
  assert.equal(count, baseline, `${count} test() calls found; test/BASELINE says ${baseline}. Added tests? Raise BASELINE. Removed tests? Put them back.`);
});

test('T8: the published package holds only cli.js, src/, README.md, LICENSE and package.json', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ENGINE, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map(f => f.path).sort();
  const src = readdirSync(SRC).filter(f => f.endsWith('.js')).map(f => 'src/' + f);
  assert.deepEqual(files, ['LICENSE', 'README.md', 'cli.js', 'package.json', ...src].sort());
  const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'agenttuneup'); assert.deepEqual(pkg.bin, { agenttuneup: 'cli.js' }); assert.equal(pkg.private, undefined);
  assert.ok(!pkg.dependencies, 'no runtime dependencies');
  assert.match(readFileSync(CLI, 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('P5c: unreadable or malformed input files are usage errors (exit 2) that name the file and quote nothing from it', () => {
  const d = tmp(), o = join(d, 'o');
  const SECRET = 'sk-or-v1-' + 'LEAK'.repeat(12);
  for (const body of ['{"messages": [', `{"messages": [{"role": "user", "content": "my key is ${SECRET}"`, `[${SECRET}]`, `{"a": ${SECRET}}`]) {
    const broken = join(d, 'broken.json'); writeFileSync(broken, body);
    const r = cli(['check', broken, '--out', o, '--gate']);
    assert.equal(r.status, EXIT.USAGE, body); assert.match(r.stderr, /chat file .*broken\.json.* is not valid: it is not valid JSON/);
    assert.doesNotMatch(r.stderr, /crashed|at JSON\.parse|LEAK/, 'no stack trace and nothing from the file');
  }
  assert.equal(cli(['check', join(d, 'missing.txt'), '--out', o]).status, EXIT.USAGE);
  const chat = join(d, 'chat.txt'); writeFileSync(chat, 'User: hi\nBot: hello\n');
  assert.equal(cli(['check', chat, '--instructions', join(d, 'nope.txt'), '--out', o]).status, EXIT.USAGE);
  assert.equal(cli(['check', chat, '--private', join(d, 'nope.txt'), '--out', o]).status, EXIT.USAGE);
  for (const [body, why] of [['{"cases": [', /not valid JSON/], ['null', /expected a JSON object/], ['[]', /expected a JSON object/], ['{"cases":[{"id":"a","turns":["hi"]}]}', /agent_config/]]) {
    const suite = join(d, 'suite.json'); writeFileSync(suite, body);
    const r = cli(['run', suite, '--consent', '--out', o]);
    assert.equal(r.status, EXIT.USAGE, body + r.stderr); assert.match(r.stderr, /suite file .* is not valid/); assert.match(r.stderr, why); assert.doesNotMatch(r.stderr, /crashed/);
  }
});

test('G12c/G12g: a suite with no cases or with a duplicate id is a config error before anything runs', async () => {
  const { validateSuite } = await import('../src/rules.js');
  assert.match(validateSuite({ cases: [{ id: 'a', turns: ['x'] }, { id: 'a', turns: ['y'] }] }).join(), /"a" is used by another case/);
  for (const expect of [{ must_not_call: 'delete_all' }, { must_not_call: [] }, { must_not_call: [''] }, { must_call: ['book'] }, { must_call: '' }]) {
    assert.ok(validateSuite({ cases: [{ id: 'a', turns: ['x'], expect }] }).length, JSON.stringify(expect));
  }
  assert.deepEqual(validateSuite({ cases: [{ id: 'a', turns: ['x'], expect: { must_call: 'book', must_not_call: ['delete_all'] } }] }), []);
  const d = tmp(), suite = join(d, 'suite.json');
  for (const [cases, why] of [[[{ id: 'a', turns: ['x'] }, { id: 'a', turns: ['y'] }], /used by another case/], [[], /case/]]) {
    writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'x', agent_config: { type: 'http', url: 'http://127.0.0.1:9/' }, cases }));
    const r = spawnSync(process.execPath, [CLI, 'run', suite, '--consent', '--gate', '--out', join(d, 'o')], { env: { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' }, encoding: 'utf8' });
    assert.equal(r.status, EXIT.USAGE, r.stderr); assert.match(r.stderr, why);
  }
});

test('PR #32 review: a tool check the agent cannot show is refused before anything is sent (exit 2)', async () => {
  const d = tmp(), suite = join(d, 'suite.json');
  let hits = 0;
  const { createServer } = await import('node:http');
  const srv = createServer((q, s) => { hits++; s.end('{"reply":"ok"}'); }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    for (const expect of [{ must_call: 'book' }, { must_not_call: ['delete_all'] }]) {
      writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'x', agent_config: { type: 'http', url: `http://127.0.0.1:${srv.address().port}/` }, cases: [{ id: 'c1', intent: 'x', turns: ['hi'], expect }] }));
      const r = spawnSync(process.execPath, [CLI, 'run', suite, '--consent', '--gate', '--out', join(d, 'o')], { env: { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' }, encoding: 'utf8' });
      assert.equal(r.status, EXIT.USAGE, r.stderr); assert.match(r.stderr, /c1 check tool calls .* not visible/);
    }
  } finally { srv.close(); }
  assert.equal(hits, 0, 'the agent was called');
});

test('PR #32 review: an agent outage is an errored case-run (exit 3), not a crash; other cases are still judged', async () => {
  const fails = [new Error('agent endpoint 503'), Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), new TypeError('fetch failed'), new Error('OpenRouter /v1/chat/completions 502: down')];
  const suite = { cases: [{ id: 'ok', intent: 'x', turns: ['hi'] }, { id: 'down', intent: 'x', turns: ['boom'] }] };
  for (const err of fails) {
    const adapter = { name: 't', observesTools: false, turn: async ({ message }) => { if (message === 'boom') throw err; return { reply: 'Here you go.', tools: null, tokens: null, ms: 1 }; } };
    const rep = await evaluate({ suite, instructions: 'x', adapter, or: fakeOr(goodCase), scrub: scrubber() });
    const down = rep.gateRuns.find(r => r.case === 'down').findings;
    assert.deepEqual(down.map(f => f.code), ['agent_error'], err.message);
    assert.match(down[0].detail, /\((?:HTTP \d{3}|timed out|could not connect)\)/);
    assert.doesNotMatch(down[0].detail, /fetch failed|aborted|: down/, 'the error text is not copied into the report');
    const g = gate(rep.gateRuns, { expected: [{ case: 'ok', rep: 1 }, { case: 'down', rep: 1 }], judged: true });
    assert.equal(g.exit, EXIT.UNDETERMINED); assert.deepEqual(g.errored, [{ case: 'down', rep: 1 }]);
    assert.ok(rep.gateRuns.find(r => r.case === 'ok').findings.some(f => f.code === 'judge:completed'), 'the other case was still judged');
  }
  // A refusal to send (not an outage) still stops loudly.
  const refuse = { name: 't', observesTools: false, turn: async () => { throw new Error('A word from your --private list is in a test message'); } };
  await assert.rejects(evaluate({ suite: { cases: [{ id: 'c', intent: 'x', turns: ['hi'] }] }, instructions: 'x', adapter: refuse, or: fakeOr(goodCase), scrub: scrubber() }), /--private/);
});

test('PR #32 review: the published README only points at files the package has, or at full GitHub links', () => {
  const md = readFileSync(join(ENGINE, 'README.md'), 'utf8');
  assert.doesNotMatch(md, /\bcd engine\b|\bnode cli\.js\b/, 'repository-only commands in the package README');
  for (const m of md.matchAll(/examples\/[\w./-]*/g)) {
    const before = md.slice(Math.max(0, m.index - 60), m.index);
    assert.match(before, /https:\/\/github\.com\/Viaknox\/tune-up\/(?:tree|blob)\/main\/engine\/$|\[`$/, `relative examples/ path in README: ${m[0]}`);
  }
});

test('PR #32 review: a blank TUNEUP_OPENROUTER_KEY is a config error (exit 2), never an empty bearer token', async () => {
  const d = tmp(), chat = join(d, 'chat.txt'); writeFileSync(chat, 'User: hi\nBot: hello there\n');
  for (const key of ['', '   ', '\n\t']) {
    const r = cli(['check', chat, '--consent', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: key });
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(key) + r.stderr); assert.match(r.stderr, /TUNEUP_OPENROUTER_KEY/);
  }
});

test('PR #32 review: a non-object "expect" is a config error, not a crash', async () => {
  const { validateSuite } = await import('../src/rules.js');
  for (const expect of ['oops', 1, null, [], true]) assert.match(validateSuite({ cases: [{ id: 'a', turns: ['x'], expect }] }).join(), /"expect" must be an object/, JSON.stringify(expect));
});

test('PR #32 review: case ids like __proto__ or constructor are plain keys in the report and the gate', async () => {
  const { buildReport, regressions } = await import('../src/report.js');
  const runs = ['__proto__', 'constructor', 'toString'].map(id => ({ case: id, rep: 1, passed: true, findings: [{ bucket: 'done', code: 'judge:completed', ok: true }], turns: [], ms: 1, tokens: 1, toolCalls: 0 }));
  const rep = buildReport({ suite: { agent: 'A', repeats: 1 }, instructions: 'x', adapter: { name: 't', observesTools: false }, runs, judgeModel: 'j', evidenceLevel: 2 });
  assert.equal(rep.cases, 3);
  assert.deepEqual(regressions(rep, rep), []);
  assert.equal(gate(runs, { expected: ids(runs), judged: true }).counts.ok, 3);
});

test('PR #32 review: an unusable replay-model reply is an errored agent_error (exit 3), not a crash', async () => {
  const { modelAdapter } = await import('../src/adapters.js');
  for (const body of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: null }] }]) {
    const or = { chat: async () => body };
    const rep = await evaluate({ suite: { cases: [{ id: 'c', intent: 'x', turns: ['hi'] }] }, instructions: 'x', adapter: modelAdapter({ model: 'm' }, or, { scrub: scrubber() }), or: fakeOr(goodCase), scrub: scrubber() });
    const f = rep.gateRuns[0].findings;
    assert.deepEqual(f.map(x => x.code), ['agent_error'], JSON.stringify(body));
    assert.match(f[0].detail, /\(unusable reply\)/);
    assert.equal(gate(rep.gateRuns, { expected: [{ case: 'c', rep: 1 }], judged: true }).exit, EXIT.UNDETERMINED);
  }
});

test('PR #32 review: an incomplete agent_config is a config error (exit 2) before any client or call exists', () => {
  const d = tmp(), suite = join(d, 'suite.json');
  const cases = [{ id: 'c1', intent: 'x', turns: ['hi'] }];
  for (const [agent_config, why] of [[{ type: 'http' }, /agent_config\.url/], [{ type: 'http', url: 'ftp://x.example/' }, /agent_config\.url/], [{ type: 'http', url: 'not a url' }, /agent_config\.url/],
    [{ type: 'model' }, /agent_config\.model/], [{ type: 'model', model: '  ' }, /agent_config\.model/], [{ model: 'm' }, /agent_config\.type/], [{ type: 'grok', url: 'https://x.example/' }, /agent_config\.type/], [[], /agent_config/]]) {
    writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'x', agent_config, cases }));
    const r = cli(['run', suite, '--consent', '--gate', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' });
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(agent_config) + r.stderr); assert.match(r.stderr, why); assert.doesNotMatch(r.stderr, /crashed|Evaluating/);
  }
});

test('PR #32 review: an http 200 that is not JSON or has no reply at the path is an errored agent_error, not empty_reply', async () => {
  const { httpAdapter } = await import('../src/adapters.js');
  const replies = [() => new Response('<html>oops</html>'), () => new Response('{"other": "x"}'), () => new Response('{"reply": {"text": "x"}}'), () => new Response('{"reply": null}')];
  for (const [i, reply] of replies.entries()) {
    const adapter = httpAdapter({ url: 'https://bot.test/chat' }, { fetchImpl: async () => reply() });
    const rep = await evaluate({ suite: { cases: [{ id: 'c', intent: 'x', turns: ['hi'] }] }, instructions: 'x', adapter, or: fakeOr(goodCase), scrub: scrubber() });
    assert.deepEqual(rep.gateRuns[0].findings.map(f => f.code), ['agent_error'], `reply ${i}`);
    assert.equal(stateOf(rep.gateRuns[0], { judged: true }), 'errored');
  }
  // A real (empty or numeric) answer at the path is still the agent's reply.
  for (const [body, want] of [['{"reply": ""}', ''], ['{"reply": 42}', '42']]) {
    const t = await httpAdapter({ url: 'https://bot.test/chat' }, { fetchImpl: async () => new Response(body) }).turn({ history: [], message: 'hi' });
    assert.equal(t.reply, want);
  }
});

test('PR #32 review: an --out that cannot be a folder is a usage error (exit 2), not a crash', () => {
  const d = tmp(), chat = join(d, 'chat.txt'), file = join(d, 'a-file'); writeFileSync(chat, 'User: hi\nBot: hello there\n'); writeFileSync(file, 'x');
  for (const o of [file, join(file, 'below')]) {
    const r = cli(['check', chat, '--gate', '--out', o]);
    assert.equal(r.status, EXIT.USAGE, o + r.stderr); assert.match(r.stderr, /Cannot use --out/); assert.doesNotMatch(r.stderr, /crashed/);
  }
});

test('PR #32 review: a malformed replay-model message (non-text content, bad tool calls) is an errored agent_error', async () => {
  const { modelAdapter } = await import('../src/adapters.js');
  const bad = [{ content: { oops: true } }, { content: 7 }, { content: '', tool_calls: 'x' }, { content: '', tool_calls: [null] }, { content: '', tool_calls: [{ function: { name: 3 } }] }, { content: '', tool_calls: [{ function: { name: 'f', arguments: {} } }] }];
  for (const message of bad) {
    const or = { chat: async () => ({ choices: [{ message }] }) };
    const rep = await evaluate({ suite: { cases: [{ id: 'c', intent: 'x', turns: ['hi'] }] }, instructions: 'x', adapter: modelAdapter({ model: 'm' }, or, { scrub: scrubber() }), or: fakeOr(goodCase), scrub: scrubber() });
    assert.deepEqual(rep.gateRuns[0].findings.map(f => f.code), ['agent_error'], JSON.stringify(message));
  }
  const ok = { chat: async () => ({ choices: [{ message: { content: null, tool_calls: undefined } }] }) };
  const t = await modelAdapter({ model: 'm' }, ok, { scrub: scrubber() }).turn({ history: [], message: 'hi', instructions: 'x' });
  assert.equal(t.reply, '', 'a null content with no tool calls is still a (empty) reply');
});

test('PR #32 review: a malformed first entry does not hide the other chats in a JSON export', () => {
  const pair = [{ role: 'user', content: 'Hi, what time do you open?' }, { role: 'assistant', content: 'We open at 9am.' }];
  const c = parseTranscripts(JSON.stringify([{}, { messages: pair }, pair]));
  assert.equal(c.length, 2); assert.deepEqual(c.positions, [2, 3]); assert.deepEqual(c.rejected, [1]);
  assert.equal(parseTranscripts(JSON.stringify(pair)).length, 1, 'a flat message list is still one chat');
});

test('PR #32 review: a non-string or empty reply_path is a config error before the agent is called', () => {
  const d = tmp(), suite = join(d, 'suite.json');
  for (const reply_path of [7, '', ['a'], null]) {
    writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'x', agent_config: { type: 'http', url: 'http://127.0.0.1:9/', reply_path }, cases: [{ id: 'c1', intent: 'x', turns: ['hi'] }] }));
    const r = cli(['run', suite, '--consent', '--gate', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' });
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(reply_path) + r.stderr); assert.match(r.stderr, /reply_path/);
  }
});

test('PR #32 review: when every entry is unreadable, --gate still writes report.json and report.md listing them', () => {
  const d = tmp(), f = join(d, 'in.json'), o = join(d, 'o');
  writeFileSync(f, JSON.stringify([[{ role: 'user', content: 'nobody answered' }], { messages: [] }]));
  const r = cli(['check', f, '--gate', '--out', o]);
  assert.equal(r.status, EXIT.UNDETERMINED, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(o, 'report.json'), 'utf8')).unreadable_entries, [1, 2]);
  assert.match(readFileSync(join(o, 'report.md'), 'utf8'), /entries 1, 2 of the file could not be read as a chat/);
});

test('PR #32 review: a manual npm publish defaults to the next channel, never latest', () => {
  const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.publishConfig, { tag: 'next' });
});

test('PR #32 review: object-valued message content makes the chat unreadable; text parts of multimodal content are read', () => {
  const ok = { role: 'assistant', content: 'We open at 9am.' };
  const c = parseTranscripts(JSON.stringify([[{ role: 'user', content: { a: 1 } }, ok], [{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }, ok], [{ role: 'user', content: [{ type: 'text', text: 'When do you open?' }] }, ok]]));
  assert.deepEqual(c.rejected, [1, 2]); assert.deepEqual(c.positions, [3]);
  assert.equal(c[0][0].content, 'When do you open?');
  const tool = parseTranscripts(JSON.stringify([[{ role: 'user', content: 'When do you open?' }, { role: 'tool', content: { hours: '9-5' } }, { role: 'system', content: [{ type: 'x' }] }, ok]]));
  assert.equal(tool.length, 1, 'structured tool and system turns are dropped, not a reason to reject the chat');
  const d = tmp(), f = join(d, 'obj.json'); writeFileSync(f, JSON.stringify([{ role: 'user', content: { a: 1 } }, ok]));
  assert.equal(cli(['check', f, '--gate', '--out', join(d, 'o')]).status, EXIT.UNDETERMINED, '[object Object] must never pass the gate');
});

test('PR #32 review: every npx command in the README pins the exact package version', () => {
  const md = readFileSync(join(ENGINE, 'README.md'), 'utf8'), v = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8')).version;
  const uses = [...md.matchAll(/npx agenttuneup(@[\w.-]+)?/g)];
  assert.ok(uses.length >= 5); for (const m of uses) assert.equal(m[1], '@' + v, m[0]);
});

test('PR #32 review: a report over zero readable chats shows no NaN', () => {
  const d = tmp(), f = join(d, 'in.json'), o = join(d, 'o'); writeFileSync(f, JSON.stringify([[{ role: 'user', content: 'nobody answered' }]]));
  const r = cli(['check', f, '--gate', '--consent', '--out', o], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' });
  assert.equal(r.status, EXIT.UNDETERMINED, r.stderr);
  const md = readFileSync(join(o, 'report.md'), 'utf8'), json = readFileSync(join(o, 'report.json'), 'utf8');
  assert.doesNotMatch(md + r.stdout, /NaN/); assert.match(md, /nothing was checked and there is no score/);
  assert.equal(JSON.parse(json).cases, 0);
});

test('PR #32 review: an http url with a user name or password is refused before anything runs, and never echoed', () => {
  const d = tmp(), suite = join(d, 'suite.json');
  for (const url of ['https://bob:s3cr3tPW@agent.example/chat', 'https://tokenonly@agent.example/chat']) {
    writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'x', agent_config: { type: 'http', url }, cases: [{ id: 'c1', intent: 'x', turns: ['hi'] }] }));
    const r = cli(['run', suite, '--consent', '--gate', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' });
    assert.equal(r.status, EXIT.USAGE, url + r.stderr); assert.match(r.stderr, /must not contain a user name or password/);
    assert.doesNotMatch(r.stderr + r.stdout, /s3cr3tPW|tokenonly/);
  }
});

test('PR #32 review: an export whose entries are all malformed counts every entry', () => {
  assert.deepEqual(parseTranscripts(JSON.stringify([{}, {}])).rejected, [1, 2]);
  assert.deepEqual(parseTranscripts(JSON.stringify([{}, null, 3])).rejected, [1, 2, 3]);
  const flat = [{ role: 'user', content: 'Hi, what time do you open?' }, { role: 'assistant', content: 'We open at 9am.' }];
  for (const extra of [null, {}, { meta: 'export v2' }]) {
    const c = parseTranscripts(JSON.stringify([...flat, extra]));
    assert.equal(c.length, 1, `a flat chat with a stray ${JSON.stringify(extra)} entry is still one chat`); assert.deepEqual(c.rejected, []);
  }
  const pair = [{ role: 'user', content: 'Hi, what time do you open?' }, { role: 'assistant', content: 'We open at 9am.' }];
  assert.equal(parseTranscripts(JSON.stringify(pair)).length, 1, 'a flat message list is still one chat');
});

test('PR #32 review: an --out folder that cannot take files is exit 2 before anything runs; a failed report write is exit 2', () => {
  const d = tmp(), chat = join(d, 'chat.txt'); writeFileSync(chat, 'User: hi\nBot: We open at 9am.\n');
  // A folder that exists but takes no files (Linux /proc): the probe write fails before any check runs.
  if (existsSync('/proc/self')) {
    const r = cli(['check', chat, '--gate', '--out', '/proc/self']);
    assert.equal(r.status, EXIT.USAGE, r.stderr); assert.match(r.stderr, /Cannot use --out/); assert.doesNotMatch(r.stderr, /crashed|Checking/);
  }
  // On every OS: report.json is a folder, so the write fails after the run; that is exit 2 naming the file, not a crash.
  const o = join(d, 'o'); mkdirSync(join(o, 'report.json'), { recursive: true });
  const w = cli(['check', chat, '--gate', '--out', o]);
  assert.equal(w.status, EXIT.USAGE, w.stderr); assert.match(w.stderr, /Cannot write .*report\.json/); assert.doesNotMatch(w.stderr, /crashed/);
});

test('PR #32 review: every documented suite field is shape-checked before anything is sent', async () => {
  const { validateSuite } = await import('../src/rules.js');
  const bad = [{ must_say_any: 1 }, { must_say_any: {} }, { must_say_any: 'done' }, { must_say_any: [] }, { must_say_any: [3] }, { must_not_say: 'Bluebird' }, { must_not_say: [''] }, { refuse: 'yes' }, { ask_clarify: 1 }];
  for (const expect of bad) assert.ok(validateSuite({ cases: [{ id: 'a', turns: ['x'], expect }] }).length, JSON.stringify(expect));
  assert.ok(validateSuite({ cases: [{ id: 'a', intent: 7, turns: ['x'] }] }).length, 'intent must be text');
  assert.deepEqual(validateSuite({ cases: [{ id: 'a', intent: 'x', turns: ['x'], expect: { must_say_any: ['booked'], must_not_say: ['Bluebird'], refuse: false, ask_clarify: true } }] }), []);
  const d = tmp(), suite = join(d, 'suite.json');
  const http = { type: 'http', url: 'http://127.0.0.1:9/' }, model = { type: 'model', model: 'm' };
  const cases = [{ id: 'c1', intent: 'x', turns: ['hi'] }];
  const shapes = [
    [{ agent_config: http, cases }, /"instructions"/], [{ instructions: 5, agent_config: http, cases }, /"instructions"/],
    [{ instructions: 'x', sacred: 'keep this', agent_config: http, cases }, /"sacred"/],
    ...['1000', -1, 0, 4294967296, 1.5].map(t => [{ instructions: 'x', agent_config: { ...http, timeout_ms: t }, cases }, /timeout_ms/]),
    [{ instructions: 'x', agent_config: { ...http, headers: { a: 1 } }, cases }, /headers/],
    [{ instructions: 'x', agent_config: { ...model, max_tokens: '100' }, cases }, /max_tokens/], [{ instructions: 'x', agent_config: { ...model, temperature: 5 }, cases }, /temperature/],
    [{ instructions: 'x', agent_config: { ...model, tools: [] }, cases }, /tools/],
    [{ instructions: 'x', agent_config: http, cases: [{ id: 'c1', turns: ['hi'], expect: { must_say_any: 'done' } }] }, /must_say_any/],
  ];
  for (const [body, why] of shapes) {
    writeFileSync(suite, JSON.stringify({ agent: 'A', ...body }));
    const r = cli(['run', suite, '--consent', '--gate', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' });
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(body) + r.stderr); assert.match(r.stderr, why); assert.doesNotMatch(r.stderr, /crashed|Evaluating/);
  }
});

test('PR #32 review: a crash never prints the error message (which can carry a URL, header value or input)', () => {
  const src = readFileSync(CLI, 'utf8');
  const handler = src.slice(src.indexOf('const crashed ='), src.indexOf("process.on('unhandledRejection'"));
  assert.doesNotMatch(handler, /\.message/, 'the crash handler must not print e.message');
  assert.match(src, /process\.on\('uncaughtException', crashed\);\nprocess\.on\('unhandledRejection', crashed\);/);
});

test('PR #32 review: header syntax, tool definitions and primitive cases are config errors, and header values are never echoed', async () => {
  const { validateSuite } = await import('../src/rules.js');
  for (const c of ['oops', 3, true, []]) assert.match(validateSuite({ cases: [c] }).join(), /must be an object/, JSON.stringify(c));
  const d = tmp(), suite = join(d, 'suite.json'), cases = [{ id: 'c1', intent: 'x', turns: ['hi'] }];
  const http = { type: 'http', url: 'http://127.0.0.1:9/' }, model = { type: 'model', model: 'm' };
  const shapes = [
    [{ ...http, headers: { 'bad name': 'x' } }, /header name/], [{ ...http, headers: { a: 'line1\nSECRETLINE2' } }, /single line/],
    [{ ...model, tools: { lookup: null } }, /tools\.lookup/], [{ ...model, tools: { lookup: { cases: 'x' } } }, /cases/],
    [{ ...model, tools: { lookup: { cases: [{ when: 3 }] } } }, /cases/], [{ ...model, tools: { lookup: { description: 5 } } }, /description/],
    [{ ...model, tools: { lookup: { parameters: 'x' } } }, /parameters/], [{ ...model, tools: { lookup: { read_only: 'yes' } } }, /read_only/],
  ];
  for (const [agent_config, why] of shapes) {
    writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'x', agent_config, cases }));
    const r = cli(['run', suite, '--consent', '--gate', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test' });
    assert.equal(r.status, EXIT.USAGE, JSON.stringify(agent_config) + r.stderr); assert.match(r.stderr, why); assert.doesNotMatch(r.stderr, /crashed|Evaluating|SECRETLINE2/);
  }
  // A ${TUNEUP_AGENT_*} variable that expands to more than one line: refused, naming only the header.
  writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'x', agent_config: { ...http, headers: { authorization: 'Bearer ${TUNEUP_AGENT_TOKEN}' } }, cases }));
  const r = cli(['run', suite, '--consent', '--gate', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test', TUNEUP_AGENT_URL: 'http://127.0.0.1:9', TUNEUP_AGENT_TOKEN: 'abc\nTOKENTAIL' });
  assert.equal(r.status, EXIT.USAGE, r.stderr); assert.match(r.stderr, /headers\.authorization is not a single line/); assert.doesNotMatch(r.stderr, /TOKENTAIL|crashed/);
});

test('PR #32 review: the README CI example never gives the key to a job that runs pull-request code', () => {
  const md = readFileSync(join(ENGINE, 'README.md'), 'utf8');
  const yml = md.slice(md.indexOf('# .github/workflows/agent-check.yml'), md.indexOf('```', md.indexOf('# .github/workflows/agent-check.yml')));
  assert.doesNotMatch(yml, /pull_request_target/);
  assert.match(yml, /- if: github\.event_name == 'pull_request'\n\s+run: (?:(?!--consent).)*--gate/, 'pull requests run rules only');
  assert.match(yml, /- if: github\.event_name == 'push'\n\s+run: .*--consent.*\n\s+env:\n\s+TUNEUP_OPENROUTER_KEY/, 'the key only on the post-merge step');
  assert.equal((yml.match(/TUNEUP_OPENROUTER_KEY:/g) || []).length, 1, 'the key is set in exactly one place');
  assert.match(yml, /environment: \$\{\{ github\.event_name == 'push' && 'agent-check' \|\| '' \}\}/);
});

test('PR #32 review: a key with a line break, a pre-existing probe-like file, and an unverified tune-up attempt', async () => {
  const d = tmp(), chat = join(d, 'chat.txt'); writeFileSync(chat, 'User: hi\nBot: We open at 9am.\n');
  const k = cli(['check', chat, '--consent', '--gate', '--out', join(d, 'o')], { ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-AAAA\nBBBBTAIL' });
  assert.equal(k.status, EXIT.USAGE, k.stderr); assert.match(k.stderr, /line break/); assert.doesNotMatch(k.stderr, /BBBBTAIL|crashed/);
  // The writability probe never touches a file that is already there.
  const o = join(d, 'o2'); mkdirSync(o); const keep = join(o, `.agenttuneup-write-${process.pid}`); writeFileSync(keep, 'precious');
  assert.equal(cli(['check', chat, '--gate', '--out', o]).status, EXIT.PASS);
  assert.equal(readFileSync(keep, 'utf8'), 'precious');
  // tune: the re-run's judge calls all fail, so the attempt is "not fully checked" and never proposed, whatever its lift.
  const { pathToFileURL } = await import('node:url');
  const stub = pathToFileURL(join(ENGINE, 'test', 'fixtures', 'stub-fetch.mjs')).href;
  const suite = join(d, 'suite.json'), out = join(d, 't');
  writeFileSync(suite, JSON.stringify({ agent: 'A', instructions: 'Answer questions about opening hours.', agent_config: { type: 'http', url: 'http://agent.invalid/chat', body: { message: '{{message}}', system: '{{instructions}}' } }, cases: [{ id: 'c1', intent: 'hours', turns: ['When do you open?'] }] }));
  const env = (cfg) => ({ ...cleanEnv(), TUNEUP_OPENROUTER_KEY: 'sk-or-test', NODE_OPTIONS: `--import=${stub}`, TU_TEST_FETCH: JSON.stringify(cfg) });
  const fail = { completed: 0.05, truthful: 0.95, followed_rules: 0.95, needless_question: 0.05 };
  const run = spawnSync(process.execPath, [CLI, 'run', suite, '--consent', '--out', out], { env: env({ answers: fail }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const tune = spawnSync(process.execPath, [CLI, 'tune', suite, '--consent', '--out', out], { env: env({ decideThrow: true, writer: { revised_instructions: 'Answer questions about opening hours. Always state the exact opening time.', changes: ['c1: state the time'] } }), encoding: 'utf8' });
  assert.equal(tune.status, 0, tune.stderr);
  const md = readFileSync(join(out, 'tune-up.md'), 'utf8');
  assert.match(md, /not fully checked/); assert.doesNotMatch(md, /Best proposed tune-up/);
  assert.equal(JSON.parse(readFileSync(join(out, 'attempt-1.json'), 'utf8')).verified, false);
});
