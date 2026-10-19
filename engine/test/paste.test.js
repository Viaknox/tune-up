import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubber } from '../src/redact.js';
import { parseTranscripts, checkConversation } from '../src/transcripts.js';
import { buildReport } from '../src/report.js';

test('scrub: emails, phones, keys, valid card numbers, SSNs and IPs become stable placeholders', () => {
  const s = scrubber();
  const out = s.scrub('Mail jo@acme.com or jo@acme.com, call +1 336-555-0142, key sk-or-v1-abcdefghijklmnopqrstuvwx1234, card 4111 1111 1111 1111, ssn 123-45-6789, ip 10.0.0.12, password: hunter22x');
  for (const leak of ['jo@acme.com', '555-0142', 'sk-or-v1', '4111', '123-45-6789', '10.0.0.12', 'hunter22x']) assert.ok(!out.includes(leak), leak);
  assert.equal(out.match(/\[EMAIL_1\]/g).length, 2);
  assert.deepEqual(Object.keys(s.counts()).sort(), ['CARD', 'EMAIL', 'IP', 'KEY', 'PHONE', 'SECRET', 'SSN']);
});

test('scrub: order numbers that fail the card checksum, prices and dates are left alone', () => {
  const out = scrubber().scrub('Order 1234567890123 shipped on 2026-10-11 for $49.99, room B at 3pm.');
  assert.equal(out, 'Order 1234567890123 shipped on 2026-10-11 for $49.99, room B at 3pm.');
});

test('unscrub restores values locally (used on a revised instruction)', () => {
  const s = scrubber();
  const sent = s.scrub('Escalate to help@viaknox.test.');
  assert.equal(s.unscrub(sent.replace('Escalate', 'Always escalate')), 'Always escalate to help@viaknox.test.');
});

test('parse: labelled text, multi-line messages, bot name, and --- between chats', () => {
  const c = parseTranscripts('User: hi\nBookBot: hello\nhow can I help?\n---\nYou: book B\nBookBot: done', { agentName: 'BookBot' });
  assert.equal(c.length, 2);
  assert.deepEqual(c[0][1], { role: 'assistant', content: 'hello\nhow can I help?' });
  assert.equal(c[1][0].role, 'user');
});

test('parse: JSON exports in the common shapes', () => {
  const one = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  assert.equal(parseTranscripts(JSON.stringify(one)).length, 1);
  assert.equal(parseTranscripts(JSON.stringify([one, one])).length, 2);
  assert.equal(parseTranscripts(JSON.stringify({ conversations: [{ messages: one }] })).length, 1);
});

test('friction: a repeated ask and a correction are flagged; a calm chat is not', () => {
  const rough = [{ role: 'user', content: 'Book room B for 3pm tomorrow please' }, { role: 'assistant', content: 'Done!' },
    { role: 'user', content: "No, I didn't get a confirmation. Book room B for 3pm tomorrow" }, { role: 'assistant', content: 'Booked, id RB-1.' }];
  const codes = checkConversation(rough).filter(f => !f.ok).map(f => f.code).sort();
  assert.deepEqual(codes, ['correction', 'repeated_ask']);
  assert.ok(checkConversation([{ role: 'user', content: 'hi there' }, { role: 'assistant', content: 'Hello, how can I help?' }]).every(f => f.ok));
});

test('report from chats: Keeps you happy is measured; tools are not available', () => {
  const findings = checkConversation([{ role: 'user', content: 'one two three four' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'one two three four' }, { role: 'assistant', content: 'ok then' }]);
  const r = buildReport({ suite: { agent: 'x', repeats: 1 }, instructions: '', adapter: { name: 'paste', observesTools: false },
    runs: [{ case: 'chat-1', rep: 1, findings, turns: [], ms: 0, tokens: 0, toolCalls: 0 }], judgeModel: 'none', evidenceLevel: 1 });
  assert.equal(r.buckets.find(b => b.id === 'happy').status, 'fail');
  assert.equal(r.buckets.find(b => b.id === 'tools').status, 'not_available');
});

test('echo: repeating a card number fails the rules; repeating a phone is only flagged as unsure', () => {
  const card = checkConversation([{ role: 'user', content: 'card 4111 1111 1111 1111' }, { role: 'assistant', content: 'Updated to 4111 1111 1111 1111.' }]);
  assert.equal(card.find(f => f.code === 'echoed_secret').ok, false);
  const phone = checkConversation([{ role: 'user', content: 'call +1 336-555-0142' }, { role: 'assistant', content: 'Passing on +1 336-555-0142 to the team.' }]);
  assert.equal(phone.find(f => f.code === 'echoed_contact').unsure, true);
});

test('friction: "why did you say it was done?" and "I haven\'t received anything" count as corrections', () => {
  const f = checkConversation([{ role: 'user', content: 'reset my password' }, { role: 'assistant', content: 'Done!' },
    { role: 'user', content: "I haven't received anything." }, { role: 'assistant', content: 'Sorry.' }, { role: 'user', content: 'So why did you say it was done?' }, { role: 'assistant', content: 'Apologies.' }]);
  assert.equal(f.filter(x => x.code === 'correction').length, 2);
});
