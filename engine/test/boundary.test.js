// Outbound-interception tests (brief item 7): everything the judge and the fix writer send leaves through one door,
// `outbound`, which accepts only a Sanitized from the scrubber. A mocked fetch records every request so the tests can
// prove that no seeded secret and no never-send term reaches the wire, and that a held or failed scrub makes NO call.
// Secrets are built at run time from pieces, never written literally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { client, outbound, HeldBack } from '../src/openrouter.js';
import { judgeCase, judgeConversation, chatState } from '../src/judge.js';
import { proposeFix } from '../src/writer.js';
import { evaluate } from '../src/evaluate.js';
import { modelAdapter } from '../src/adapters.js';
import { scrubber, Sanitized, ScrubError } from '../src/redact.js';
import { gen, makeRng } from './corpus/expand.js';

const rng = makeRng(7101);
const TERMS = ['Acme', 'Acme Corp'];
// Seeded secrets in the shapes the brief lists; each must be absent from every request.
const SECRETS = {
  sk: 'sk-' + 'x'.repeat(40),
  pw: gen.secret(rng, 220) + 'LEAKED_SUFFIX',
  pem: gen.pemLines(rng, 3),
  basic: Buffer.from('bob:' + gen.secret(rng, 18)).toString('base64'),
  urlpw: gen.secret(rng, 22),
};
const dotenv = () => `PASSWORD=${SECRETS.pw}\nAPI_KEY="${SECRETS.sk}"`;
const pem = () => `${gen.pemHead('RSA')}\n${SECRETS.pem.join('\n')}\n${gen.pemFoot('RSA')}`;
const header = () => `Authorization: Basic ${SECRETS.basic}`;
const url = () => `postgres://bob:${SECRETS.urlpw}@db.example.com/app`;
const allSecrets = () => [SECRETS.sk, SECRETS.pw, ...SECRETS.pem, SECRETS.basic, SECRETS.urlpw];
const windows = (s, w = 8) => (s.length <= w ? [s] : Array.from({ length: s.length - w + 1 }, (_, i) => s.slice(i, i + w)));

// A real OpenRouter client whose fetch is recorded. Replies depend on the path so the replay model, the judge and the
// writer all get something usable.
function recorder(writerReply) {
  const calls = [];
  const fetchImpl = async (u, init) => {
    calls.push(JSON.stringify({ url: u, headers: init.headers, body: init.body }));
    if (String(u).endsWith('/alpha/decisions')) {
      const qs = Object.keys(JSON.parse(init.body).questions);
      return new Response(JSON.stringify({ answers: Object.fromEntries(qs.map(k => [k, { noul: 0.9 }])) }), { status: 200 });
    }
    const content = writerReply || `All set for Acme Corp, key ${SECRETS.sk} saved.`;   // the replay model "echoes" a secret and a term
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  return { or: client('k', { fetchImpl }), calls };
}
function assertClean(calls, label) {
  assert.ok(calls.length > 0, label + ': nothing was sent, so nothing was tested');
  for (const c of calls) {
    for (const sec of allSecrets()) { const hit = windows(sec).find(w => c.includes(w)); assert.equal(hit, undefined, `${label}: a secret window reached the wire`); }
    assert.ok(!/acme/i.test(c), label + ': a never-send term reached the wire');
  }
}

test('[promised] boundary: the judge path sends no seeded secret or never-send term in any request (instructions, turns, tools, replies)', async () => {
  const { or, calls } = recorder();
  const scrub = scrubber({ terms: TERMS });
  const tools = { get_env: { description: `Reads Acme settings ${url()}`, parameters: {}, default: { env: dotenv(), key: pem() } } };
  const adapter = modelAdapter({ model: 'm', tools }, or, { scrub });
  const suite = { cases: [{ id: 'c-acme', intent: `Acme Corp wants ${header()} kept private`, turns: [`here is my config\n${dotenv()}\n${pem()}\n${header()}\n${url()}`] }] };
  const rep = await evaluate({ suite, instructions: `You work for Acme Corp. ${dotenv()}`, adapter, or, scrub });
  assertClean(calls, 'judge');
  assert.ok(calls.some(c => c.includes('/alpha/decisions')), 'the judge was asked');
  const rules = rep.buckets.find(b => b.id === 'rules');
  assert.equal(rules.unsure, 0, 'a scrubbable chat is judged, not held');
});

test('[promised] boundary: the writer path sends no seeded secret or never-send term (instructions, failures, quotes, cases, tried)', async () => {
  const { or, calls } = recorder(JSON.stringify({ revised_instructions: 'You are BookBot. Always confirm the id and never repeat settings.', changes: ['x'] }));
  const scrub = scrubber({ terms: TERMS });
  const fix = await proposeFix(or, {
    instructions: `You are BookBot for Acme Corp.\n${dotenv()}\n${pem()}`,
    failures: [{ case: 'c-acme', code: 'must_not_say', detail: `Revealed "${SECRETS.sk}" to Acme`, quote: `${header()} ${url()}` }],
    cases: [{ id: 'c-acme', intent: `Acme asks about PASSWORD=${SECRETS.pw}` }],
    tried: [{ lift: -5, revised_instructions: `Use ${url()} for Acme Corp` }], scrub });
  assertClean(calls, 'writer');
  assert.equal(calls.length, 1); assert.match(fix.revised_instructions, /BookBot/);
});

test('[promised] boundary: a plain string is refused with a TypeError before any call, for the judge, the chat judge and outbound', async () => {
  const { or, calls } = recorder();
  await assert.rejects(judgeCase(or, 'AGENT: hi'), TypeError);
  await assert.rejects(judgeConversation(or, chatState('', [{ role: 'user', content: 'hi' }]), { hasInstructions: false }), TypeError);
  await assert.rejects(outbound(or, 'decide', 'state', (t) => ({ state: t })), TypeError);
  await assert.rejects(outbound(or, 'upload', scrubber().sanitize('x'), (t) => t), TypeError);
  assert.equal(calls.length, 0);
});

test('[promised] boundary: an object shaped like a Sanitized but not made by the scrubber is refused', async () => {
  const { or, calls } = recorder();
  const fake = Object.freeze({ text: 'hello', held: false, reasons: [], version: '2.0.0' });
  await assert.rejects(outbound(or, 'chat', fake, (t) => ({ messages: [{ role: 'user', content: t }] })), TypeError);
  await assert.rejects(judgeCase(or, fake), TypeError);
  await assert.rejects(outbound(or, 'chat', Object.create(Sanitized.prototype), (t) => t), TypeError);
  assert.equal(calls.length, 0);
});

test('[promised] boundary: text held by the residual scan gives one judge:held finding and makes no call; the writer rejects with HeldBack', async () => {
  const { or, calls } = recorder();
  const bare = 'deploy key ' + gen.b64(rng, 48);   // no credential name, so only the residual scan can catch it
  const held = scrubber().sanitize(bare);
  assert.equal(held.held, true, 'the residual scan did not hold a bare high-entropy token');
  const f = await judgeCase(or, held);
  assert.deepEqual(f, [{ bucket: 'rules', code: 'judge:held', ok: false, unsure: true, detail: 'unsure: we held back part of this chat to protect a secret' }]);
  const g = await judgeConversation(or, held, { hasInstructions: true });
  assert.equal(g.length, 1); assert.equal(g[0].code, 'judge:held'); assert.equal(g[0].unsure, true);
  await assert.rejects(proposeFix(or, { instructions: 'Agent rules. ' + bare, failures: [{ case: 'c', code: 'x', detail: 'd' }] }), (e) => e instanceof HeldBack && e.message === 'unsure: we held back part of this chat to protect a secret');
  assert.equal(calls.length, 0);
});

test('[promised] boundary: a ScrubError in evaluate marks the run unsure with judge:held and makes no judge call', async () => {
  const { or, calls } = recorder();
  const real = scrubber(); const scrub = { ...real, sanitize: (t) => real.sanitize(t, { maxChars: 5 }) };
  const adapter = { name: 't', observesTools: false, turn: async () => ({ reply: 'ok', tools: null, ms: 1 }) };
  const rep = await evaluate({ suite: { cases: [{ id: 'c', turns: ['hi'] }] }, instructions: 'x', adapter, or, scrub });
  const rules = rep.buckets.find(b => b.id === 'rules');
  assert.equal(rules.status, 'warn'); assert.equal(rules.unsure, 1); assert.equal(rules.failed, 0);
  assert.match(JSON.stringify(rules), /too long or complex to scrub safely/);   // a cap hold, not a secret (viaknox PR #31 review)
  assert.equal(rep.runs[0].passed, true, 'an unsure finding never fails a run on its own');
  assert.equal(calls.length, 0);
  assert.throws(() => real.sanitize('a'.repeat(10), { maxChars: 5 }), ScrubError);
});

test('[promised] boundary: the restore map never leaves scope: no request, Sanitized, HeldBack or TypeError serialises a secret', async () => {
  const { or, calls } = recorder();
  const scrub = scrubber({ terms: TERMS });
  const san = scrub.sanitize(`Acme ${dotenv()}\n${pem()}\n${header()}\n${url()}`);
  const heldOne = scrubber().sanitize('deploy key ' + gen.b64(rng, 48));
  let heldErr, typeErr;
  try { await outbound(or, 'chat', heldOne, (t) => t); } catch (e) { heldErr = e; }
  try { await outbound(or, 'chat', { text: SECRETS.sk }, (t) => t); } catch (e) { typeErr = e; }
  await judgeCase(or, san);
  for (const blob of [...calls, JSON.stringify(san), JSON.stringify(heldErr) + String(heldErr) + heldErr.stack, JSON.stringify(typeErr) + String(typeErr) + typeErr.stack]) {
    for (const sec of allSecrets()) assert.equal(windows(sec).find(w => blob.includes(w)), undefined, 'a secret window was serialised');
    assert.ok(!/acme/i.test(blob));
  }
  assert.ok(Object.isFrozen(san) && san instanceof Sanitized);
});

test('[promised] boundary: judge, writer and evaluate never call or.chat/or.decide directly; only outbound does', () => {
  const src = (f) => readFileSync(fileURLToPath(new URL('../src/' + f, import.meta.url)), 'utf8');
  for (const f of ['judge.js', 'writer.js', 'evaluate.js']) {
    assert.ok(!/\bor\.(chat|decide)\s*\(/.test(src(f)), `${f} calls the client directly`);
    assert.ok(!/\bfetch(Impl)?\s*\(/.test(src(f)), `${f} fetches directly`);
  }
  for (const f of ['judge.js', 'writer.js']) assert.ok(/\boutbound\(/.test(src(f)), `${f} does not go through outbound`);
  const o = src('openrouter.js');
  assert.ok(/export async function outbound\(/.test(o) && /or\[kind\]\(build\(sanitized\.text\)\)/.test(o));
});

// viaknox #25 review: a never-send word inside a tool name, a JSON-schema property name or a `required` entry cannot be
// scrubbed (the model must echo those exactly), so the run is refused before any request is built.
test('[promised] model adapter refuses a run when a --private word sits in a tool name, a property name or a required list; nothing is sent', async () => {
  let calls = 0; const or = { chat: async () => { calls++; return { choices: [{ message: { content: 'ok' } }] }; } };
  const mk = (tools) => modelAdapter({ model: 'm', tools }, or, { scrub: scrubber({ terms: ['Acme'] }), privateTerms: ['Acme'] });
  const base = { description: 'd', parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } };
  assert.throws(() => mk({ acme_lookup: base }), /--private/);
  assert.throws(() => mk({ lookup: { ...base, parameters: { type: 'object', properties: { acmeId: { type: 'string' } } } } }), /--private/);
  assert.throws(() => mk({ lookup: { ...base, parameters: { type: 'object', properties: { nested: { type: 'object', properties: { ACME: { type: 'string' } } } } } } }), /--private/);
  assert.throws(() => mk({ lookup: { ...base, parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['Acme'] } } }), /--private/);
  assert.equal(calls, 0);
  // Without a clash the adapter builds and runs; the description is scrubbed as before.
  const ok = mk({ lookup: { ...base, description: 'Mail Acme Corp' } });
  const t = await ok.turn({ history: [], message: 'hi', instructions: 'x' }); assert.equal(t.reply, 'ok'); assert.equal(calls, 1);
  const plain = modelAdapter({ model: 'm', tools: { acme_lookup: base } }, or, { scrub: scrubber() }); assert.ok(plain);
});

// PR #16 review: identifiers in every schema-keyed map ($defs, definitions, patternProperties, dependentSchemas,
// dependentRequired, dependencies) travel unscrubbed like property names, so a never-send word in any of them refuses the run.
test('[promised] model adapter refuses a run when a --private word sits in a $defs, definitions or other schema-keyed map name', async () => {
  let calls = 0; const or = { chat: async () => { calls++; return { choices: [{ message: { content: 'ok' } }] }; } };
  const mk = (parameters) => modelAdapter({ model: 'm', tools: { lookup: { description: 'd', parameters } } }, or, { scrub: scrubber({ terms: ['Acme'] }), privateTerms: ['Acme'] });
  const str = { type: 'string' };
  assert.throws(() => mk({ type: 'object', $defs: { AcmeUser: str }, properties: { to: { $ref: '#/$defs/AcmeUser' } } }), /--private/);
  assert.throws(() => mk({ type: 'object', definitions: { acme_user: str }, properties: { to: str } }), /--private/);
  assert.throws(() => mk({ type: 'object', patternProperties: { '^acme_': str } }), /--private/);
  assert.throws(() => mk({ type: 'object', properties: { x: str }, dependentRequired: { acmeId: ['x'] } }), /--private/);
  assert.throws(() => mk({ type: 'object', properties: { x: str }, dependentSchemas: { x: { properties: { ACME: str } } } }), /--private/);
  assert.throws(() => mk({ type: 'object', properties: { x: str }, dependencies: { acmeFlag: ['x'] } }), /--private/);
  assert.equal(calls, 0);
  const ok = mk({ type: 'object', $defs: { User: str }, properties: { to: { $ref: '#/$defs/User' } } });
  const t = await ok.turn({ history: [], message: 'hi', instructions: 'x' }); assert.equal(t.reply, 'ok'); assert.equal(calls, 1);
});

// PR #16 review: check mode must treat the scrubber's caps like evaluate does: one held finding, no call, no crash.
test('[promised] judgeHeld turns a ScrubError into the judge:held finding for the chat judge, and cli.js check mode goes through it', async () => {
  const { judgeHeld } = await import('../src/judge.js');
  assert.equal(typeof judgeHeld, 'function', 'judgeHeld is not exported');
  const { or, calls } = recorder();
  const real = scrubber(); const capped = { ...real, sanitize: (t) => real.sanitize(t, { maxChars: 5 }) };
  const state = chatState('', [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'hi' }]);
  const f = await judgeHeld(capped, state, (s) => judgeConversation(or, s, { hasInstructions: false }));
  assert.deepEqual(f, [{ bucket: 'rules', code: 'judge:held', ok: false, unsure: true, cap: true, detail: 'unsure: we held back this chat because it was too long or complex to scrub safely' }]);   // a cap hold says so (viaknox PR #31 review)
  assert.equal(calls.length, 0);
  const ok = await judgeHeld(real, state, (s) => judgeConversation(or, s, { hasInstructions: false }));
  assert.ok(ok.length > 1 && ok.every(x => x.code !== 'judge:held'), JSON.stringify(ok));
  const cli = readFileSync(fileURLToPath(new URL('../cli.js', import.meta.url)), 'utf8');
  // The judge call goes through judgeHeld; the only direct sanitize() allowed is the local report's `shown` helper,
  // which holds residual-only secrets out of report.json (PR #16 review).
  const direct = cli.split('\n').filter(l => /scrub\.sanitize\(/.test(l));
  assert.ok(/\bjudgeHeld\(/.test(cli) && direct.every(l => /const shown = /.test(l)), 'cli.js check mode must sanitize through judgeHeld');
});

test('[promised] cli check --consent on a conversation over the size cap exits 0 with a judge:held finding', () => {
  const d = mkdtempSync(join(tmpdir(), 'tu-')); const f = join(d, 'chats.txt');
  writeFileSync(f, 'User: ' + 'hello there '.repeat(340_000) + '\nBot: ok\n');   // over the 4,000,000-character cap
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'check', f, '--consent', '--out', join(d, 'o')], { env: { ...process.env, TUNEUP_OPENROUTER_KEY: 'sk-or-test' }, encoding: 'utf8', maxBuffer: 256e6 });
  assert.equal(r.status, 0, r.stderr.slice(-500));   // without --gate the exit code is 0 (docs/CLI-PLAN.md G10); the gate case is in gate.test.js
  const rep = readFileSync(join(d, 'o', 'report.json'), 'utf8');
  assert.ok(rep.includes('too long or complex to scrub safely'), 'no cap-held finding in the report');   // the report card carries the finding text, not its code
  assert.ok(!rep.includes('ScrubError') && !r.stderr.includes('ScrubError'));
});

test('[promised] boundary: the replay model is never called when a turn holds a residual-only secret (PR #16 review)', async () => {
  const { or, calls } = recorder();
  const tok = ['AbCdEfGh', 'IjKlMnOp', 'QrStUvWx', 'Yz012345'].join('');
  const adapter = modelAdapter({ model: 'm', tools: {} }, or, { scrub: scrubber() });
  const suite = { cases: [{ id: 'c1', intent: 'x', turns: [`send ${tok}`] }] };
  const rep = await evaluate({ suite, instructions: 'You are a bot.', adapter, or, scrub: scrubber() });
  assert.ok(!calls.some(c => c.includes(tok)), 'the token reached the wire');
  assert.equal(rep.buckets.find(b => b.id === 'rules').unsure, 1);
});

test('[promised] boundary: compound never-send terms are refused in tool names (PR #16 review)', () => {
  const { or } = recorder();
  const base = { description: 'x', parameters: {}, default: {} };
  assert.throws(() => modelAdapter({ model: 'm', tools: { AcmeCorpLookup: base } }, or, { scrub: scrubber({ terms: ['AcmeCorp'] }), privateTerms: ['AcmeCorp'] }));
  assert.throws(() => modelAdapter({ model: 'm', tools: { 'Acme-Corp_lookup': base } }, or, { scrub: scrubber({ terms: ['Acme-Corp'] }), privateTerms: ['Acme-Corp'] }));
  assert.throws(() => modelAdapter({ model: 'm', tools: { acmecorplookup: base } }, or, { scrub: scrubber({ terms: ['acmecorp'] }), privateTerms: ['acmecorp'] }));
});

test('[promised] writer: a placeholder minted from the instructions is restored in the proposal (PR #16 review)', async () => {
  const { or } = recorder(JSON.stringify({ revised_instructions: 'You are BookBot. Email [EMAIL_1] for help and confirm ids.', changes: ['x'] }));
  const fix = await proposeFix(or, { instructions: 'You are BookBot. Email help@bookbot.example for help.', failures: [{ case: 'c', code: 'x', detail: 'd' }] });
  assert.match(fix.revised_instructions, /help@bookbot\.example/);
});
test('round 42: a run held at a later turn keeps the false "done" its first turn already proved', async () => {
  const { or, calls } = recorder();
  let n = 0;
  const adapter = { name: 't', observesTools: true, turn: async () => { if (n++ > 0) throw new HeldBack(); return { reply: 'I booked it.', tools: [], ms: 1 }; } };
  const rep = await evaluate({ suite: { cases: [{ id: 'c', turns: ['book it', 'and again'] }] }, instructions: 'x', adapter, or, scrub: scrubber() });
  const b = Object.fromEntries(rep.buckets.map(x => [x.id, x]));
  assert.equal(b.truth.failed, 1); assert.equal(b.rules.unsure, 1);
  assert.equal(rep.runs[0].passed, false); assert.equal(calls.length, 0);
});
test('round 42: cli.js check finishes with a report when a pasted chat exceeds the scrubber cap (no crash)', () => {
  const d = mkdtempSync(join(tmpdir(), 'tu-')), f = join(d, 'chat.txt');
  writeFileSync(f, 'User: ' + Array.from({ length: 2000 }, () => 'credentials {').join('\n') + '\nBot: ok\n');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'check', f, '--out', join(d, 'o')], { encoding: 'utf8', maxBuffer: 256e6 });
  assert.equal(r.status, 0, r.stderr);   // finished with a report, not a crash
  const g = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'check', f, '--gate', '--out', join(d, 'o2')], { encoding: 'utf8', maxBuffer: 256e6 });
  assert.equal(g.status, 3, g.stderr);   // with --gate: every case-run held, nothing checked = UNDETERMINED (docs/CLI-PLAN.md §4)
  assert.ok(existsSync(join(d, 'o', 'report.json')));
});

test('[promised] boundary: a scrubber cap in the replay adapter is a cap hold (cap: true), a secret hold is not (tune-up PR #21 review)', async () => {
  const { or, calls } = recorder();
  const real = scrubber(); const capped = { ...real, sanitize: (t) => real.sanitize(t, { maxChars: 5 }) };
  const rep = await evaluate({ suite: { cases: [{ id: 'c', turns: ['hello there'] }] }, instructions: 'x', adapter: modelAdapter({ model: 'm' }, or, { scrub: capped }), or, scrub: capped });
  const rules = JSON.stringify(rep.buckets.find(b => b.id === 'rules'));
  assert.match(rules, /too long or complex to scrub safely/); assert.doesNotMatch(rules, /protect a secret/);
  assert.equal(calls.length, 0);
  const e = new HeldBack(); assert.equal(e.cap, false); assert.match(e.message, /protect a secret/);
  assert.match(new HeldBack(true).message, /too long or complex/);
});
