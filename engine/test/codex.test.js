// Regression tests for the Codex review of PR #12 (one per finding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { modelAdapter, httpAdapter } from '../src/adapters.js';
import { checkCase } from '../src/rules.js';
import { scrubber } from '../src/redact.js';
import { buildReport, regressions } from '../src/report.js';
import { loadKey, client } from '../src/openrouter.js';
import { evaluate } from '../src/evaluate.js';

const reply = (content, tool_calls) => ({ choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}) } }] });

test('codex 1: tool descriptions, nested schemas and enums are scrubbed; tool and property names are kept', async () => {
  const sent = [];
  const or = { chat: async (b) => { sent.push(b); return reply('ok'); } };
  const tools = { email_acme: { description: 'Mail jo@acme.com at Acme Corp', parameters: { type: 'object', required: ['to'],
    properties: { to: { type: 'string', enum: ['jo@acme.com', 'Acme Corp desk'], description: 'e.g. jo@acme.com' }, nested: { type: 'object', properties: { note: { type: 'string', examples: ['Acme Corp'] } } } } } } };
  await modelAdapter({ model: 'm', tools }, or, { scrub: scrubber({ terms: ['Acme Corp'] }) }).turn({ history: [], message: 'hi', instructions: 'x' });
  const body = JSON.stringify(sent[0].tools);
  assert.ok(!body.includes('jo@acme.com') && !body.includes('Acme Corp'), body);
  const fn = sent[0].tools[0].function;
  assert.equal(fn.name, 'email_acme'); assert.deepEqual(fn.parameters.required, ['to']);
  assert.ok(fn.parameters.properties.to && fn.parameters.properties.nested.properties.note);
});

test('codex 2: a lookup succeeding is not proof of a booking claim (unsure, never a pass); a real action still counts', () => {
  const seen = { observesTools: true };
  const f = checkCase({ expect: {} }, [{ reply: 'I booked room B.', tools: [{ name: 'get_calendar', ok: true }] }], seen).find(x => x.code === 'false_done');
  assert.ok(f && f.unsure === true && f.ok === false);
  const g = checkCase({ expect: {} }, [{ reply: 'I booked room B.', tools: [{ name: 'room_status', ok: true, readOnly: true }] }], seen).find(x => x.code === 'false_done');
  assert.ok(g && g.unsure);
  assert.equal(checkCase({ expect: {} }, [{ reply: 'I booked room B.', tools: [{ name: 'get_calendar', ok: true }, { name: 'book_room', ok: true }] }], seen).filter(x => x.code === 'false_done').length, 0);
});

test('codex 3: --private words are never sent to the http agent; other text reaches it unchanged', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init.body); return new Response(JSON.stringify({ reply: 'hi' }), { status: 200 }); };
  const a = httpAdapter({ url: 'https://agent.example/chat' }, { fetchImpl, privateTerms: ['Acme Corp'] });
  await assert.rejects(a.turn({ history: [], message: 'Book for Acme Corp' }), /--private/);
  assert.equal(calls.length, 0);
  await a.turn({ history: [], message: 'Book for jo@x.com' });
  assert.ok(calls[0].includes('jo@x.com'));
});

test('[promised] a --private word inside an email address is never sent to the http agent (PR #16 review)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init.body); return new Response(JSON.stringify({ reply: 'hi' }), { status: 200 }); };
  const a = httpAdapter({ url: 'https://agent.example/chat' }, { fetchImpl, privateTerms: ['Acme'] });
  await assert.rejects(a.turn({ history: [], message: 'Write to employee@acme.example' }), /--private/);
  assert.equal(calls.length, 0);
});

test('codex 4: a tune-up that breaks a passing case or adds a rules failure is a regression', () => {
  const rep = (runs, failures = []) => ({ runs, failures });
  // R2: runs carry the classifier's state, and a regression is named per case-run (case#rep).
  const before = rep([{ case: 'a', rep: 1, state: 'ok' }, { case: 'b', rep: 1, state: 'failed' }], [{ case: 'b', bucket: 'done', code: 'x' }]);
  assert.deepEqual(regressions(before, rep([{ case: 'a', rep: 1, state: 'failed' }, { case: 'b', rep: 1, state: 'ok' }])), ['a#1']);
  assert.deepEqual(regressions(before, rep([{ case: 'a', rep: 1, state: 'ok' }, { case: 'b', rep: 1, state: 'failed' }], [{ case: 'b', bucket: 'rules', code: 'must_not_say', detail: 'Revealed "HR"' }])), ['b (must_not_say: Revealed "HR")']);
  assert.deepEqual(regressions(before, rep([{ case: 'a', rep: 1, state: 'ok' }, { case: 'b', rep: 1, state: 'ok' }])), []);
});

test('codex 5: scrubbing a card keeps the space after it, both ways', () => {
  const s = scrubber(); const out = s.scrub('4111 1111 1111 1111 please');
  assert.equal(out, '[CARD_1] please'); assert.equal(s.unscrub(out), '4111 1111 1111 1111 please');
});

test('codex 6: tool calls and tool results from earlier turns stay in the replay history', async () => {
  const seen = []; let n = 0;
  const or = { chat: async ({ messages }) => { seen.push(messages); n++;
    if (n === 1) return reply('', [{ id: 'c1', type: 'function', function: { name: 'find_room', arguments: '{}' } }]);
    return reply(n === 2 ? 'Room B is free.' : 'Booked B.'); } };
  const adapter = modelAdapter({ model: 'm', tools: { find_room: { description: 'd', parameters: {}, default: { room: 'B' } } } }, or, { scrub: scrubber() });
  await evaluate({ suite: { cases: [{ id: 'c', turns: ['find a room', 'book it'] }] }, instructions: 'x', adapter,
    or: { ...or, decide: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.9 }])) }) } });
  const third = seen[2];
  assert.ok(third.some(m => m.role === 'tool' && m.tool_call_id === 'c1' && m.content.includes('"room":"B"')));
  assert.ok(third.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls)));
});

test('codex 7: a simulated tool with no matching case and no default fails; a defined null/false result is real', async () => {
  let n = 0;
  const mk = (tool) => modelAdapter({ model: 'm', tools: { t: tool } }, { chat: async () => (++n % 2 ? reply('', [{ id: 'x', function: { name: 't', arguments: '{"a":"z"}' } }]) : reply('done')) }, { scrub: scrubber() });
  const t1 = await mk({ description: 'd', parameters: {}, cases: [{ when: { a: 'y' }, result: { ok: 1 } }] }).turn({ history: [], message: 'go', instructions: 'x' });
  assert.equal(t1.tools[0].ok, false); assert.match(t1.tools[0].result.error, /no simulated result/);
  const t2 = await mk({ description: 'd', parameters: {}, default: null }).turn({ history: [], message: 'go', instructions: 'x' });
  assert.equal(t2.tools[0].ok, true);
});

test('codex 8: unsure verdicts do not dilute a confident failure into a warning', () => {
  const runs = [{ case: 'c', rep: 1, passed: false, turns: [], ms: 0, tokens: 0, toolCalls: 0, findings: [
    { bucket: 'done', code: 'x', ok: false }, ...Array.from({ length: 4 }, () => ({ bucket: 'done', code: 'y', ok: false, unsure: true })), { bucket: 'done', code: 'z', ok: true }] }];
  const rep = buildReport({ suite: { agent: 'a' }, instructions: '', adapter: { name: 't', observesTools: false }, runs, judgeModel: 'j', evidenceLevel: 2 });
  assert.equal(rep.buckets.find(b => b.id === 'done').status, 'fail');
});

test('codex 9: key files use real dotenv rules (quotes, export, trailing comments, CRLF)', () => {
  const d = mkdtempSync(join(tmpdir(), 'tu-')); const prev = process.env.TUNEUP_OPENROUTER_KEY; delete process.env.TUNEUP_OPENROUTER_KEY;
  try {
    for (const [line, want] of [["OPENROUTER='sk-or-abc'", 'sk-or-abc'], ['export OPENROUTER_API_KEY="sk-or-def"', 'sk-or-def'], ['OPENROUTER_KEY=sk-or-ghi # mine\r\nOTHER=1', 'sk-or-ghi']]) {
      const f = join(d, 'k.env'); writeFileSync(f, line); assert.equal(loadKey(f), want);
    }
  } finally { if (prev !== undefined) process.env.TUNEUP_OPENROUTER_KEY = prev; }
});

test('codex 10: a suite cannot pull non-TUNEUP_AGENT_* variables into headers; no request is made', async () => {
  let called = 0; const fetchImpl = async () => { called++; return new Response('{}'); };
  process.env.TUNEUP_OPENROUTER_KEY = 'sk-or-secret'; process.env.TUNEUP_AGENT_TOKEN = 'agent-tok';
  try {
    assert.throws(() => httpAdapter({ url: 'https://evil.example', headers: { a: 'Bearer ${TUNEUP_OPENROUTER_KEY}' } }, { fetchImpl }), /TUNEUP_AGENT_/);
    assert.throws(() => httpAdapter({ url: 'https://evil.example', headers: { a: '${AWS_SECRET_ACCESS_KEY}' } }, { fetchImpl }), /refusing/);
    assert.equal(called, 0);
    // Aikido: an allowed variable still only goes to the address the user bound in TUNEUP_AGENT_URL.
    const cfg = (url) => ({ url, headers: { authorization: 'Bearer ${TUNEUP_AGENT_TOKEN}' } });
    assert.throws(() => httpAdapter(cfg('https://agent.example/chat'), { fetchImpl }), /TUNEUP_AGENT_URL/);
    process.env.TUNEUP_AGENT_URL = 'https://agent.example';
    assert.throws(() => httpAdapter(cfg('https://evil.example/chat'), { fetchImpl }), /refusing to send/);
    assert.equal(called, 0);
    let got; const ok = httpAdapter(cfg('https://agent.example/chat'), { fetchImpl: async (u, i) => { got = i.headers.authorization; return new Response('{"reply":"x"}'); } });
    await ok.turn({ history: [], message: 'hi' }); assert.equal(got, 'Bearer agent-tok');
  } finally { delete process.env.TUNEUP_OPENROUTER_KEY; delete process.env.TUNEUP_AGENT_TOKEN; delete process.env.TUNEUP_AGENT_URL; }
});

// ---- round 2 (Codex + Aikido on 5d0ee43) ----
import { spawnSync } from 'node:child_process';
import { CONCURRENCY } from '../src/evaluate.js';

test('round 2: http agent requests refuse redirects, so headers never follow to another host', async () => {
  let init; const a = httpAdapter({ url: 'https://agent.example' }, { fetchImpl: async (u, i) => { init = i; return new Response('{"reply":"x"}'); } });
  await a.turn({ history: [], message: 'hi' }); assert.equal(init.redirect, 'error');
});
test('round 2: "booked" backed only by an unrelated action is unsure; generic "done" accepts any action', () => {
  const seen = { observesTools: true };
  const f = checkCase({ expect: {} }, [{ reply: 'I booked room B.', tools: [{ name: 'send_email', ok: true }] }], seen).find(x => x.code === 'false_done');
  assert.ok(f && f.unsure);
  assert.equal(checkCase({ expect: {} }, [{ reply: 'All set.', tools: [{ name: 'send_email', ok: true }] }], seen).filter(x => x.code === 'false_done').length, 0);
  assert.equal(checkCase({ expect: {} }, [{ reply: "I've sent it.", tools: [{ name: 'send_email', ok: true }] }], seen).filter(x => x.code === 'false_done').length, 0);
});
test('round 2: a second leak in a case that already leaked counts as a new rules failure', () => {
  const leak = (w) => ({ case: 'c', bucket: 'rules', code: 'must_not_say', detail: `Revealed "${w}"` });
  const before = { runs: [{ case: 'c', passed: false }], failures: [leak('dentist')] };
  assert.equal(regressions(before, { runs: [{ case: 'c', passed: false }], failures: [leak('dentist'), leak('HR')] }).length, 1);
  assert.equal(regressions(before, { runs: [{ case: 'c', passed: false }], failures: [leak('dentist')] }).length, 0);
});
test('round 2: a lookup before asking for a missing detail still counts as asking first', () => {
  const f = checkCase({ expect: { ask_clarify: true } }, [{ reply: 'Which room and what time?', tools: [{ name: 'get_rooms', ok: true }] }], { observesTools: true });
  assert.equal(f.find(x => x.code === 'ask_clarify').ok, true);
  const g = checkCase({ expect: { ask_clarify: true } }, [{ reply: 'Which time?', tools: [{ name: 'book_room', ok: true }] }], { observesTools: true });
  assert.equal(g.find(x => x.code === 'ask_clarify').ok, false);
});
test('round 2: cases run at most CONCURRENCY at a time', async () => {
  let live = 0, peak = 0;
  const adapter = { observesTools: false, turn: async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return { reply: 'ok', tools: null, ms: 1 }; } };
  const or = { decide: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.9 }])) }) };
  await evaluate({ suite: { cases: Array.from({ length: 12 }, (_, i) => ({ id: 'c' + i, turns: ['hi'] })) }, instructions: 'x', adapter, or });
  assert.ok(peak <= CONCURRENCY, String(peak));
});
test('round 2: a suite with no cases is refused before anything runs', () => {
  const d = mkdtempSync(join(tmpdir(), 'tu-')); const f = join(d, 's.json');
  writeFileSync(f, JSON.stringify({ agent: 'a', instructions: 'x', agent_config: { type: 'http', url: 'https://x.example' }, cases: [] }));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'run', f, '--consent', '--out', join(d, 'o')], { env: { ...process.env, TUNEUP_OPENROUTER_KEY: 'sk-or-test' }, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /no test cases/);
});

test('round 3: "booking confirmed" after an unrelated action is unsure; table-breaking characters are neutralised', () => {
  const f = checkCase({ expect: {} }, [{ reply: 'Your booking is confirmed.', tools: [{ name: 'send_email', ok: true }] }], { observesTools: true }).find(x => x.code === 'false_done');
  assert.ok(f && f.unsure);
  const r = regressions({ runs: [], failures: [] }, { runs: [], failures: [{ case: 'c', bucket: 'rules', code: 'must_not_say', detail: 'Revealed "a|b\nc"' }] });
  assert.ok(!r[0].includes('|') && !r[0].includes('\n'));
});

// ---- round 4 (Codex + Aikido on ea3adb1) ----
import { validateSuite } from '../src/rules.js';
import { proposeFix } from '../src/writer.js';

test('round 4: the --private list is part of the suite identity (a tune-up cannot weaken it)', () => {
  const d = mkdtempSync(join(tmpdir(), 'tu-')); const f = join(d, 's.json'), p = join(d, 'p.txt'), o = join(d, 'o');
  writeFileSync(f, JSON.stringify({ agent: 'a', instructions: 'x', agent_config: { type: 'model', model: 'm' }, cases: [{ id: 'c', turns: ['hi'] }] }));
  writeFileSync(p, 'Acme Corp');
  mkdirSync(o, { recursive: true });
  // The id a baseline made WITHOUT --private would have (same formula as the CLI, with an empty list).
  const suite = JSON.parse(readFileSync(f, 'utf8')); suite.repeats = 1;
  const noPrivate = createHash('sha256').update(JSON.stringify(suite) + '\u0000' + JSON.stringify([])).digest('hex').slice(0, 16);
  writeFileSync(join(o, 'report.json'), JSON.stringify({ suite_id: noPrivate, failures: [{}], runs: [] }));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'tune', f, '--consent', '--private', p, '--out', o], { env: { ...process.env, TUNEUP_OPENROUTER_KEY: 'sk-or-test' }, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /different suite or settings/);
});
test('round 4: malformed cases and catastrophic regexes are refused before anything runs', () => {
  assert.equal(validateSuite({ cases: [{ id: 'a', turns: ['hi'], expect: { must_say_any: ['RB-\\d+'] } }] }).length, 0);
  assert.match(validateSuite({ cases: [{ id: 'a', turns: ['hi'] }, { id: 'b' }] })[0], /turns/);
  assert.match(validateSuite({ cases: [{ id: 'a', turns: ['hi'], expect: { must_say_any: ['(a+)+$'] } }] })[0], /too complex/);
  assert.match(validateSuite({ cases: [{ id: 'a', turns: ['hi'], expect: { must_say_any: ['(unclosed'] } }] })[0], /not a valid regex/);
});
test('round 4: forbidden words with accents or symbols are still caught', () => {
  for (const w of ['René', 'C++', '$100']) {
    const f = checkCase({ expect: { must_not_say: [w] } }, [{ reply: `It was ${w} today.`, tools: [] }], { observesTools: false });
    assert.equal(f.find(x => x.code === 'must_not_say').ok, false, w);
  }
});
test('round 4: an earlier success does not cover a later failed attempt; more clause separators', () => {
  const seen = { observesTools: true };
  const f = checkCase({ expect: {} }, [{ reply: 'Booked A.', tools: [{ name: 'book_room', ok: true }] }, { reply: "I've booked room B.", tools: [{ name: 'book_room', ok: false }] }], seen);
  assert.ok(f.some(x => x.code === 'false_done' && !x.unsure));
  const g = checkCase({ expect: {} }, [{ reply: "Room C is unavailable, so I've booked room B.", tools: [] }], seen);
  assert.ok(g.some(x => x.code === 'false_done'));
});
test('round 4: "sent the booking confirmation" needs a send action', () => {
  const f = checkCase({ expect: {} }, [{ reply: "I've sent your booking confirmation.", tools: [{ name: 'book_room', ok: true }] }], { observesTools: true });
  assert.ok(f.some(x => x.code === 'false_done' && x.unsure));
});
test('round 4: judge vote percentages do not make an unchanged failure look new; distinct labels stay distinct', () => {
  const j = (p) => ({ case: 'c', bucket: 'rules', code: 'judge:followed_rules', detail: `The agent followed… — no (${p}%)` });
  assert.equal(regressions({ runs: [], failures: [j(90)] }, { runs: [], failures: [j(91)] }).length, 0);
  const l = (w) => ({ case: 'c', bucket: 'rules', code: 'must_not_say', detail: `Revealed "${w}"` });
  assert.equal(regressions({ runs: [], failures: [] }, { runs: [], failures: [l('a|b'), l('a/b')] }).length, 2);
});
test('round 4: key files pick the credential, not other OpenRouter settings', () => {
  const d = mkdtempSync(join(tmpdir(), 'tu-')); const f = join(d, 'k.env'); const prev = process.env.TUNEUP_OPENROUTER_KEY; delete process.env.TUNEUP_OPENROUTER_KEY;
  try { writeFileSync(f, 'OPENROUTER_BASE_URL=https://x\nOPENROUTER_MODEL=m\nOPENROUTER_KEY=sk-or-real\n'); assert.equal(loadKey(f), 'sk-or-real'); }
  finally { if (prev !== undefined) process.env.TUNEUP_OPENROUTER_KEY = prev; }
});
test('round 4: unknown http-agent usage is reported as unknown, not 0', () => {
  const runs = [{ case: 'c', rep: 1, passed: true, findings: [], turns: [], ms: 10, tokens: null, toolCalls: null }];
  const rep = buildReport({ suite: { agent: 'a' }, instructions: '', adapter: { name: 'http', observesTools: false }, runs, judgeModel: 'j', evidenceLevel: 2 });
  const u = rep.buckets.find(b => b.id === 'waste').usage; assert.equal(u.avg_tokens, null); assert.equal(u.avg_tool_calls, null);
});
test('round 4: nested simulator arguments are compared structurally', async () => {
  let n = 0;
  const a = modelAdapter({ model: 'm', tools: { t: { description: 'd', parameters: {}, cases: [{ when: { where: { room: 'A' } }, result: { r: 'A' } }, { when: { where: { room: 'B' } }, result: { r: 'B' } }] } } },
    { chat: async () => (++n === 1 ? reply('', [{ id: 'x', function: { name: 't', arguments: '{"where":{"room":"B"}}' } }]) : reply('ok')) }, { scrub: scrubber() });
  const t = await a.turn({ history: [], message: 'go', instructions: 'x' }); assert.deepEqual(t.tools[0].result, { r: 'B' });
});
test('round 4: an unchanged proposal is rejected before any re-run', async () => {
  const instructions = 'You are BookBot. Book rooms carefully and confirm ids.';
  const or = { chat: async () => reply(JSON.stringify({ revised_instructions: instructions + '  ', changes: ['x'] })) };
  await assert.rejects(proposeFix(or, { instructions, failures: [{ case: 'c', code: 'x', detail: 'd' }] }), /unchanged/);
});

test('round 5: repeated groups are refused; percentage-like text in a leaked term is not normalised away', () => {
  assert.match(validateSuite({ cases: [{ id: 'a', turns: ['hi'], expect: { must_say_any: ['^(a|aa)+$'] } }] })[0], /too complex/);
  assert.equal(validateSuite({ cases: [{ id: 'a', turns: ['hi'], expect: { must_say_any: ['RB-\\d+', 'fully booked'] } }] }).length, 0);
  const l = (w) => ({ case: 'c', bucket: 'rules', code: 'must_not_say', detail: `Revealed "${w}"` });
  assert.equal(regressions({ runs: [], failures: [l('foo')] }, { runs: [], failures: [l('foo'), l('foo (90%)')] }).length, 1);
});

// Live Grok Bot test (2026-10-12): the bot wrote "[submitted the hidden field]" for the user's secret entry, twice.
test('review: bracketed placeholder turns never count as asking again or correcting', async () => {
  const { checkConversation } = await import('../src/transcripts.js');
  const msgs = [{ role: 'user', content: 'add the connector please' }, { role: 'assistant', content: 'Paste the value in the hidden field.' },
    { role: 'user', content: '[submitted the hidden field]' }, { role: 'assistant', content: 'Saved.' },
    { role: 'user', content: '[submitted the hidden field]' }, { role: 'assistant', content: 'Connected.' }];
  assert.deepEqual(checkConversation(msgs).filter(f => f.code === 'repeated_ask' || f.code === 'correction'), []);
  const real = [{ role: 'user', content: 'reset my password for the account' }, { role: 'assistant', content: 'Done!' },
    { role: 'user', content: 'reset my password for the account please' }, { role: 'assistant', content: 'Sorry.' }];
  assert.equal(checkConversation(real).filter(f => f.code === 'repeated_ask').length, 1, 'real repeats still count');
});
// PR review (Aikido): credential settings by name, and the no-training provider flag on every model call.
test('review: credentials named like AWS_SECRET_ACCESS_KEY, client_secret or X-Api-Key are removed', () => {
  const s = scrubber();
  const v = (n) => 'v' + String(n).repeat(8);   // made-up values, built here so secret scanners don't flag the test itself
  const names = ['AWS_SECRET_ACCESS_KEY=', 'SECRET_KEY=', 'PRIVATE_KEY: ', 'client_secret: "', 'X-Api-Key: ', 'db_password=', 'accessKeyId: ', 'secretAccessKey='];
  const out = s.scrub(names.map((n, i) => n + v(i)).join('\n') + '\naws key ' + 'ASIA' + 'Q'.repeat(16));
  for (const leak of [...names.map((_, i) => v(i)), 'ASIA' + 'Q'.repeat(16)]) assert.ok(!out.includes(leak), leak);
  assert.equal(s.scrub('the keyboard: fine'), 'the keyboard: fine');
});
test('review: every OpenRouter call asks for data_collection deny, even if the caller set something else', async () => {
  const bodies = [];
  const or = client('k', { fetchImpl: async (u, i) => { bodies.push(JSON.parse(i.body)); return new Response('{"answers":{}}', { status: 200 }); } });
  await or.decide({ model: 'm', state: 's', questions: {} });
  await or.chat({ model: 'm', messages: [], provider: { data_collection: 'allow', sort: 'price' } });
  assert.deepEqual(bodies.map(b => b.provider), [{ data_collection: 'deny', zdr: true }, { data_collection: 'deny', sort: 'price', zdr: true }]);
});

// PR #14 review (Aikido + Codex)
test('review: whole PEM blocks and credential names with any suffix are scrubbed', () => {
  const s = scrubber(), body = 'M' + 'I'.repeat(3) + 'Evg' + 'Q'.repeat(40);
  const pem = ('private_key: -----BEGIN ' + 'PRIVATE KEY-----\n') + body + '\n' + body + ('\n-----END ' + 'PRIVATE KEY-----');
  const out = s.scrub(pem + '\nPASSWORD_HASH=abcdefgh1\nCLIENT_SECRET_CURRENT=abcdefgh2\nMY_API_KEY_BACKUP=abcdefgh3');
  for (const leak of [body, 'BEGIN PRIVATE', 'abcdefgh1', 'abcdefgh2', 'abcdefgh3']) assert.ok(!out.includes(leak), leak);
});
test('review: placeholders keep their place; bracketed requests still count; the judge sees an action, not a message', async () => {
  const { checkConversation, isPlaceholder } = await import('../src/transcripts.js');
  const { chatState } = await import('../src/judge.js');
  const fix = [{ role: 'user', content: '[image attached]' }, { role: 'assistant', content: 'That is a cat.' }, { role: 'user', content: "No, that's wrong" }, { role: 'assistant', content: 'Sorry.' }];
  assert.equal(checkConversation(fix).filter(f => f.code === 'correction').length, 1, 'a correction after a placeholder still counts');
  const req = [{ role: 'user', content: '[please reset my account now]' }, { role: 'assistant', content: 'Done.' }, { role: 'user', content: '[please reset my account now]' }, { role: 'assistant', content: 'Ok.' }];
  assert.equal(checkConversation(req).filter(f => f.code === 'repeated_ask').length, 1, 'bracketed words are still a request');
  assert.ok(!isPlaceholder(req[0]));
  assert.match(chatState('', fix), /USER ACTION \(not a message the user typed\): \[image attached\]/);
});

// PR #14 review round 2 (Aikido + Codex)
test('review: credential names need whole-word credential parts; quoted values go whole; private PEM only', () => {
  const s = scrubber();
  assert.equal(s.scrub('tokenizer=enabled'), 'tokenizer=enabled');   // over-scrubbing is allowed, but "tokenizer" isn't a credential word
  const out = s.scrub('CLIENT_SECRET_CURRENT="correct horse battery staple"\nauthToken: abcdefgh9');
  assert.ok(!/horse|battery|staple|abcdefgh9/.test(out), out);
  const pub = '-----BEGIN PUBLIC KEY-----\nAAAAB3NzaC1yc2E\n-----END PUBLIC KEY-----';
  assert.equal(scrubber().scrub(pub), pub, 'public keys are meant to be shared');
});
test('review: a never-send word like PRIVATE cannot break private-key scrubbing', () => {
  const body = 'M' + 'I'.repeat(3) + 'Evg' + 'Q'.repeat(40);
  const out = scrubber({ terms: ['PRIVATE'] }).scrub(('-----BEGIN ' + 'PRIVATE KEY-----\n') + body + ('\n-----END ' + 'PRIVATE KEY-----'));
  assert.ok(!out.includes(body), out);
});
test('review: the credential rule runs in linear time on crafted input', () => {
  const t0 = Date.now(); scrubber().scrub('password-'.repeat(5000)); assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});
test('review: only action notes are placeholders; bracketed requests and corrections are the user\'s words', async () => {
  const { isPlaceholder } = await import('../src/transcripts.js');
  const u = (content) => ({ role: 'user', content });
  for (const p of ['[submitted the hidden field]', '[user attached a file]', '[image]', '[screenshot attached]']) assert.ok(isPlaceholder(u(p)), p);
  for (const w of ['[please send the document now]', '[No, I already sent the file]', '[please attach the file to the ticket now]', '[please reset my account now]']) assert.ok(!isPlaceholder(u(w)), w);
});
test('review: identical regression rows from repeated runs are shown once', () => {
  const f = { case: 'c', bucket: 'rules', code: 'must_not_say', detail: 'Revealed "x"' };
  assert.equal(regressions({ runs: [], failures: [] }, { runs: [], failures: [f, f] }).length, 1);
});

// PR #14 review round 3 (Aikido + Codex)
test('review: punctuation in values, long and plural and run-together names, but not tokenLimit or secretSanta', () => {
  const s = scrubber();
  const out = s.scrub('PASSWORD=correct,horse,battery\nAPI_KEY=Ab3;CorrectHorse9!\nAPI_KEYS=abcdefgh1\naccessKeys=abcdefgh2\nSECRETKEY=abcdefgh3\nACCESSKEY=abcdefgh4\n' + 'X'.repeat(80) + '_SECRET=abcdefgh5');
  for (const leak of ['horse', 'CorrectHorse9', 'abcdefgh1', 'abcdefgh2', 'abcdefgh3', 'abcdefgh4', 'abcdefgh5']) assert.ok(!out.includes(leak), leak);
  assert.equal(s.scrub('tokenLimit=100000'), 'tokenLimit=100000'); assert.equal(s.scrub('max_tokens: 128000'), 'max_tokens: 128000');
});
test('review: the whole scrubber stays fast on hostile input (emails, unterminated PEM headers)', () => {
  for (const junk of ['password-'.repeat(10000), 'a.'.repeat(40000) + '@', ('-----BEGIN ' + 'PRIVATE KEY-----\n').repeat(20000)]) {
    const t0 = Date.now(); scrubber().scrub(junk); assert.ok(Date.now() - t0 < 1500, `${junk.slice(0, 12)}… took ${Date.now() - t0} ms`);
  }
});
test('review: a keyfile saved with a byte-order mark still loads', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'tu-')), f = join(d, '.env'); writeFileSync(f, '\uFEFFOPENROUTER_API_KEY=sk-or-v1-test\n');
  const old = process.env.TUNEUP_OPENROUTER_KEY; delete process.env.TUNEUP_OPENROUTER_KEY;
  try { assert.equal(loadKey(f), 'sk-or-v1-test'); } finally { if (old !== undefined) process.env.TUNEUP_OPENROUTER_KEY = old; }
});
test('review: a case id that looks like a rule row does not hide the rule failure', () => {
  const f = { case: 'c', bucket: 'rules', code: 'must_not_say', detail: 'Revealed "x"' };
  const before = { runs: [{ case: 'c (must_not_say: Revealed "x")', rep: 1, state: 'ok' }], failures: [] };
  const after = { runs: [{ case: 'c (must_not_say: Revealed "x")', rep: 1, state: 'failed' }], failures: [f] };
  assert.equal(regressions(before, after).length, 2);
});

// PR #14 review round 4: when in doubt, scrub
test('review: credential settings are scrubbed in every common form', () => {
  const v = (n) => 'v' + String(n).repeat(8);
  const lines = ['PGPASSWORD=', 'SECRET_KEY_BASE=', 'PRIVATE_KEY_PEM=', 'API_KEY_STRING=', '_API_KEY=', 'settings: API_KEY='];
  const out = scrubber().scrub(lines.map((l, i) => l + v(i)).join('\n') + '\nCLIENT_SECRET=correct horse battery staple');
  for (const leak of [...lines.map((_, i) => v(i)), 'horse', 'battery']) assert.ok(!out.includes(leak), leak);
});
test('review: private keys of any length go, even with no footer; never-send words leave placeholders alone', () => {
  const big = ('-----BEGIN ' + 'PRIVATE KEY-----\n') + ('Q'.repeat(64) + '\n').repeat(400) + '-----END PRIVATE KEY-----';
  assert.ok(!scrubber().scrub(big).includes('QQQQ'));
  const cut = scrubber().scrub(('-----BEGIN ' + 'RSA PRIVATE KEY-----\n') + 'W'.repeat(64) + '\n' + 'W'.repeat(64));
  assert.ok(!cut.includes('WWWW'), cut);
  const s = scrubber({ terms: ['KEY'] }); const out = s.scrub(('-----BEGIN ' + 'PRIVATE KEY-----\nabc\n-----END ' + 'PRIVATE KEY-----'));
  assert.match(out, /^\[KEY_1\]$/); assert.match(s.unscrub(out), /BEGIN PRIVATE KEY/);
});
test('review: media notes with a file name are placeholders', async () => {
  const { isPlaceholder } = await import('../src/transcripts.js');
  for (const p of ['[image attached: screenshot.png]', '[file attached: invoice.pdf]']) assert.ok(isPlaceholder({ role: 'user', content: p }), p);
});
test('review: a bot repeating a credential-looking setting is "unsure", not a hard fail', async () => {
  const { checkConversation } = await import('../src/transcripts.js');
  const f = checkConversation([{ role: 'user', content: 'what is the setting' }, { role: 'assistant', content: 'password_hint: Jonathan Smith' }]);
  const e = f.find(x => x.code === 'revealed_setting'); assert.ok(e && e.unsure && !f.some(x => x.code === 'echoed_secret'));
});
