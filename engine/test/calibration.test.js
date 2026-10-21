// Judge calibration tooling (docs/CALIBRATION-PLAN.md). engine/calibration/ is outside the npm `files` allowlist, so it
// never ships; it lives under engine/ only to reuse the test runner, count ratchet and mutation check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, wilson, kappa, flipRate, BARS } from '../calibration/score.js';
import { adapt, judgeText, sample, sourceOf, rng, shuffle, hashIds } from '../calibration/tau.js';

const rows = (spec) => {
  // spec: [label, state, count, held?]
  const out = []; let i = 0;
  for (const [label, state, count, held] of spec) for (let k = 0; k < count; k++) out.push({ id: `r${i++}`, label, state, ...(held ? { held: true } : {}) });
  return out;
};
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('calibration: wilson bounds match the plan arithmetic', () => {
  near(wilson(90, 100).lower, 0.826);
  near(wilson(80, 100).lower, 0.711);
  near(wilson(0, 40, 1.6448536269514722).upper, 0.063);
  near(wilson(1, 40, 1.6448536269514722).upper, 0.105);
  assert.equal(wilson(0, 0), null);
  assert.equal(wilson(5, 10).upper <= 1 && wilson(5, 10).lower >= 0, true);
  near(wilson(10, 10).upper, 1, 1e-9);
  assert.equal(wilson(0, 10).lower, 0);
});

test('calibration: kappa', () => {
  near(kappa(20, 5, 10, 15), 0.4);
  near(kappa(50, 0, 0, 50), 1);
  assert.equal(kappa(0, 0, 0, 0), null);
  assert.equal(kappa(10, 0, 0, 0), null);   // chance agreement 1: undefined, never a pass
});

test('calibration: only ok and failed are decided; missing and errored never count as handled', () => {
  const r = score(rows([['pass', 'ok', 45], ['fail', 'failed', 45], ['pass', 'missing', 5], ['fail', 'errored', 5]]));
  assert.equal(r.n, 100);
  assert.equal(r.decided, 90);
  assert.equal(r.agreement.rate, 1);
  assert.equal(r.unsureRate, 0);
  assert.equal(r.falsePass.of, 50);   // every label fail is in the false-pass denominator
  assert.equal(r.matrix.fail.errored, 5);
  assert.equal(r.matrix.pass.missing, 5);
});

test('calibration: agreement bar uses the Wilson lower bound', () => {
  const ok = score(rows([['pass', 'ok', 45], ['pass', 'failed', 5], ['fail', 'failed', 45], ['fail', 'ok', 5]]), { falsePassRule: 'observed' });
  assert.equal(ok.decided, 100);
  near(ok.agreement.rate, 0.9);
  near(ok.agreement.lower, 0.826);
  assert.equal(ok.checks.agreement, true);
  const low = score(rows([['pass', 'ok', 40], ['pass', 'failed', 10], ['fail', 'failed', 40], ['fail', 'ok', 10]]), { falsePassRule: 'observed' });
  assert.equal(low.checks.agreement, false);
  assert.equal(low.pass, false);
});

test('calibration: false pass, strict upper bound vs observed rule', () => {
  const base = [['pass', 'ok', 60], ['fail', 'failed', 39]];
  const zero = score(rows([...base, ['fail', 'failed', 1]]));
  assert.equal(zero.falsePass.count, 0);
  assert.equal(zero.checks.falsePass, true);
  const one = rows([...base, ['fail', 'ok', 1]]);
  assert.equal(score(one).checks.falsePass, false);   // 1/40: upper 10.5%
  const obs = score(one, { falsePassRule: 'observed' });
  assert.equal(obs.checks.falsePass, true);           // 2.5% observed
  near(obs.falsePass.upper, 0.105);
  assert.equal(obs.falsePass.rule, 'observed');
  const five = score(rows([['pass', 'ok', 60], ['fail', 'failed', 35], ['fail', 'ok', 5]]), { falsePassRule: 'observed' });
  assert.equal(five.checks.falsePass, false);         // 12.5%
  const four = score(rows([['pass', 'ok', 60], ['fail', 'failed', 36], ['fail', 'ok', 4]]), { falsePassRule: 'observed' });
  assert.equal(four.checks.falsePass, true);          // exactly 10%
  // An undetermined label-fail still counts in the denominator and is not a false pass.
  const und = score(rows([['pass', 'ok', 10], ['fail', 'undetermined', 10]]), { falsePassRule: 'observed' });
  assert.equal(und.falsePass.of, 10);
  assert.equal(und.falsePass.count, 0);
  // No label fails at all: the false-pass bar cannot be shown, so it fails.
  const noFails = score(rows([['pass', 'ok', 10]]));
  assert.equal(noFails.falsePass, null);
  assert.equal(noFails.checks.falsePass, false);
});

test('calibration: judge-unsure vs scrubber-held are reported separately; only unsure meets the 20% ceiling', () => {
  const r = score(rows([['pass', 'ok', 40], ['fail', 'failed', 40], ['pass', 'undetermined', 20], ['fail', 'undetermined', 30, true]]));
  assert.equal(r.unsure, 20);
  assert.equal(r.held, 30);
  near(r.unsureRate, 20 / 130);
  near(r.heldRate, 30 / 130);
  const edge = score(rows([['pass', 'ok', 40], ['fail', 'failed', 40], ['pass', 'undetermined', 20]]));
  assert.equal(edge.unsureRate, 0.2);
  assert.equal(edge.checks.unsure, true);
  const over = score(rows([['pass', 'ok', 40], ['fail', 'failed', 39], ['pass', 'undetermined', 21]]));
  assert.equal(over.checks.unsure, false);
});

test('calibration: kappa bar and the overall verdict need every check', () => {
  const good = score(rows([['pass', 'ok', 95], ['fail', 'failed', 95], ['fail', 'ok', 2]]));
  assert.equal(good.pass, true);
  assert.deepEqual(good.checks, { agreement: true, falsePass: true, unsure: true, kappa: true });
  near(good.precisionOfOk, 95 / 97);
  const skew = score(rows([['pass', 'ok', 100]]));
  assert.equal(skew.kappa, null);
  assert.equal(skew.checks.kappa, false);
  const custom = score(rows([['pass', 'ok', 45], ['pass', 'failed', 5], ['fail', 'failed', 45], ['fail', 'ok', 5]]), { falsePassRule: 'observed', bars: { kappa: 0.81 } });
  near(custom.kappa, 0.8);
  assert.equal(custom.checks.kappa, false);
  assert.equal(BARS.agreementLower, 0.8);
  assert.equal(BARS.falsePass, 0.1);
  assert.equal(BARS.unsure, 0.2);
  assert.equal(BARS.kappa, 0.6);
  assert.ok(Object.isFrozen(BARS));
  const precisionNone = score(rows([['pass', 'failed', 1], ['fail', 'failed', 1]]));
  assert.equal(precisionNone.precisionOfOk, null);
  const noneDecided = score(rows([['pass', 'missing', 1], ['fail', 'errored', 1]]));
  assert.equal(noneDecided.agreement, null);
  assert.equal(noneDecided.checks.agreement, false);
});

test('calibration: scorer refuses malformed input instead of guessing', () => {
  assert.throws(() => score([]), /no rows/);
  assert.throws(() => score([{ id: 'a', label: 'pass', state: 'ok' }, { id: 'a', label: 'pass', state: 'ok' }]), /duplicate/);
  assert.throws(() => score([{ label: 'pass', state: 'ok' }]), /missing or duplicate/);
  assert.throws(() => score([null]), /missing or duplicate/);
  assert.throws(() => score([{ id: 'a', label: 'yes', state: 'ok' }]), /bad label/);
  assert.throws(() => score([{ id: 'a', label: 'fail', state: 'passed' }]), /bad state/);
});

test('calibration: flip rate across two repeat runs', () => {
  const a = [{ id: 'x', state: 'ok' }, { id: 'y', state: 'failed' }, { id: 'z', state: 'ok' }, { id: 'w', state: 'ok' }];
  assert.equal(flipRate(a, a), 0);
  assert.equal(flipRate(a, [{ id: 'x', state: 'ok' }, { id: 'y', state: 'ok' }, { id: 'z', state: 'ok' }, { id: 'w', state: 'undetermined' }]), 0.5);
  assert.throws(() => flipRate(a, a.slice(1)), /differ/);
  assert.throws(() => flipRate(a, [...a.slice(1), { id: 'q', state: 'ok' }]), /missing/);
  assert.throws(() => flipRate([a[0], a[0]], [a[0], a[1]]), /differ/);
  assert.equal(flipRate([], []), null);
});

// A small tau-bench-shaped trajectory (not real data; the real files are read only by sample-tau.mjs).
const traj = (reward, extra = []) => ({
  task_id: 7, trial: 1, reward,
  info: { task: { instruction: 'You are Ana. Exchange the red lamp for the blue one.', actions: [{ name: 'SECRET_ACTION' }], outputs: ['SECRET_OUTPUT'] }, reward_info: { r: 'SECRET_REWARD' } },
  traj: [
    { role: 'system', content: '# Retail policy\nAuthenticate first.' },
    { role: 'user', content: 'Hi, I want to swap a lamp.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'find_user', arguments: '{"name":"Ana"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'find_user', content: 'user_1' },
    { role: 'assistant', content: 'Found you. Which lamp?' },
    { role: 'user', content: 'The red one.' },
    { role: 'assistant', content: 'Done, exchange requested.', tool_calls: [{ id: 'c2', function: { name: 'exchange', arguments: 'not json' } }] },
    ...extra,
  ],
});

test('calibration: tau adapter maps the run and never shows the judge the reward or reference answers', () => {
  const a = adapt('gpt-4o-retail.json', traj(1));
  assert.equal(a.id, 'gpt-4o-retail:7:1');
  assert.equal(a.group, 'retail:7');
  assert.equal(a.label, 'pass');
  assert.equal(adapt('gpt-4o-retail.json', traj(0)).label, 'fail');
  assert.equal(adapt('gpt-4o-retail.json', traj(0.5)).label, 'fail');
  assert.equal(a.instructions, '# Retail policy\nAuthenticate first.');
  assert.equal(a.case.intent, 'You are Ana. Exchange the red lamp for the blue one.');
  assert.deepEqual(a.case.turns, ['Hi, I want to swap a lamp.', 'The red one.']);
  assert.deepEqual(a.turns[0].tools, [{ name: 'find_user', args: { name: 'Ana' }, result: 'user_1' }]);
  assert.equal(a.turns[0].reply, 'Found you. Which lamp?');
  assert.deepEqual(a.turns[1].tools, [{ name: 'exchange', args: 'not json', result: undefined }]);
  const text = judgeText(a);
  for (const s of ['SECRET_ACTION', 'SECRET_OUTPUT', 'SECRET_REWARD', 'reward']) assert.ok(!text.includes(s), s);
  assert.match(text, /\[tool find_user\(\{"name":"Ana"\}\) returned "user_1"\]/);
  assert.match(text, /TEST INTENT: You are Ana/);
});

test('calibration: tau adapter strips the simulator stop token and drops an unanswered stop turn', () => {
  const stop = adapt('gpt-4o-retail.json', traj(1, [{ role: 'user', content: 'Thanks! ###STOP###' }]));
  assert.deepEqual(stop.case.turns, ['Hi, I want to swap a lamp.', 'The red one.']);
  assert.equal(stop.turns.length, 2);
  const answered = adapt('gpt-4o-retail.json', traj(1, [{ role: 'user', content: 'Wait ###STOP###' }, { role: 'assistant', content: 'Bye' }]));
  assert.deepEqual(answered.case.turns.at(-1), 'Wait');
  assert.equal(answered.turns.length, 3);
  const plain = adapt('gpt-4o-retail.json', traj(1, [{ role: 'user', content: 'Hello?' }]));
  assert.equal(plain.turns.length, 3);   // a real unanswered message stays: the agent left the user hanging
  assert.throws(() => adapt('gpt-4o-retail.json', { traj: [] }), /malformed/);
  assert.throws(() => adapt('notes.json', traj(1)), /unexpected file name/);
  assert.deepEqual(sourceOf('sonnet-35-new-airline.json'), { model: 'sonnet-35-new', domain: 'airline' });
});

const pool = () => {
  const out = [];
  for (const model of ['m1', 'm2']) for (const domain of ['airline', 'retail']) for (let task = 0; task < 40; task++) for (let trial = 0; trial < 2; trial++)
    out.push({ id: `${model}-${domain}:${task}:${trial}`, group: `${domain}:${task}`, model, domain, label: (task + trial) % 2 ? 'pass' : 'fail' });
  return out;
};

test('calibration: sample is deterministic, grouped and balanced per stratum', () => {
  const s1 = sample(pool(), { seed: 42, perStratum: { dev: 2, test: 5 } });
  const s2 = sample(pool(), { seed: 42, perStratum: { dev: 2, test: 5 } });
  assert.deepEqual(s1, s2);
  assert.notDeepEqual(sample(pool(), { seed: 43, perStratum: { dev: 2, test: 5 } }).test, s1.test);
  assert.equal(s1.dev.length, 16);
  assert.equal(s1.test.length, 40);
  assert.equal(s1.devGroups.length, 16);   // 20% of 80 groups
  const groupOf = (id) => `${id.split(':')[0].split('-').at(-1)}:${id.split(':')[1]}`;
  const dev = new Set(s1.dev.map(groupOf));
  for (const id of s1.test) assert.ok(!dev.has(groupOf(id)), `group of ${id} is on both sides`);
  for (const g of dev) assert.ok(s1.devGroups.includes(g));
  const count = (ids, label) => ids.filter(id => pool().find(p => p.id === id).label === label).length;
  assert.equal(count(s1.test, 'pass'), 20);
  assert.equal(count(s1.test, 'fail'), 20);
  assert.equal(s1.hash, hashIds(s1));
  assert.equal(s1.hash, '09fda1344c30070ed01ac32a85c79a69e7da315aada058e1554f599e08826cc8');   // pinned: seed 42 must always draw this sample
  assert.throws(() => sample(pool(), { seed: 42, perStratum: { dev: 50, test: 5 } }), /needs 50/);
  assert.throws(() => sample([...pool(), pool()[0]], { seed: 1, perStratum: { dev: 1, test: 1 } }), /duplicate/);
});

test('calibration: rng and shuffle are seeded and keep every element', () => {
  const r = rng(7), a = [r(), r(), r()];
  const r2 = rng(7);
  assert.deepEqual([r2(), r2(), r2()], a);
  for (const x of a) assert.ok(x >= 0 && x < 1);
  const xs = Array.from({ length: 50 }, (_, i) => i);
  const sh = shuffle(xs, rng(1));
  assert.notDeepEqual(sh, xs);
  assert.deepEqual([...sh].sort((p, q) => p - q), xs);
  assert.deepEqual(xs, Array.from({ length: 50 }, (_, i) => i));   // input untouched
});

test('calibration: a value exactly on a bar passes it (bars are inclusive)', () => {
  const spec = rows([['pass', 'ok', 45], ['pass', 'failed', 5], ['fail', 'failed', 45], ['fail', 'ok', 5]]);
  const r = score(spec);
  const at = score(spec, { bars: { agreementLower: r.agreement.lower, kappa: r.kappa, falsePass: r.falsePass.upper } });
  assert.deepEqual(at.checks, { agreement: true, falsePass: true, unsure: true, kappa: true });
  const above = score(spec, { bars: { agreementLower: r.agreement.lower + 1e-9, kappa: r.kappa + 1e-9, falsePass: r.falsePass.upper - 1e-9 } });
  assert.deepEqual(above.checks, { agreement: false, falsePass: false, unsure: true, kappa: false });
});

test('calibration: seeded draws are pinned, so a published seed reproduces the published sample', () => {
  const r = rng(7);
  assert.deepEqual([r(), r(), r()], [0.011704753153026104, 0.06195825757458806, 0.97690763277933]);
  assert.deepEqual(shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rng(1)), [7, 8, 3, 2, 1, 5, 9, 4, 0, 6]);
});

test('calibration: adapter edge cases', () => {
  const good = traj(1);
  for (const bad of [null, { ...good, traj: 'x' }, { ...good, info: undefined }, { ...good, info: {} }]) assert.throws(() => adapt('gpt-4o-retail.json', bad), /malformed/);
  const onlyStop = adapt('gpt-4o-retail.json', { ...good, traj: [{ role: 'system', content: 'p' }, { role: 'user', content: '###STOP###' }] });
  assert.equal(onlyStop.turns.length, 0);
  assert.deepEqual(onlyStop.case.turns, []);
});

test('calibration: a stratum with exactly enough items is used, one short is refused', () => {
  const items = [];
  for (let task = 0; task < 10; task++) for (const label of ['pass', 'fail']) items.push({ id: `m-retail:${task}:${label}`, group: `retail:${task}`, model: 'm', domain: 'retail', label });
  const s = sample(items, { seed: 3, perStratum: { dev: 2, test: 8 } });
  assert.equal(s.dev.length, 4);
  assert.equal(s.test.length, 16);
  assert.throws(() => sample(items, { seed: 3, perStratum: { dev: 3, test: 8 } }), /has 2 items, needs 3/);
});
