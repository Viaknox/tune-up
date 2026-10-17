#!/usr/bin/env node
// Agent Tune-Up engine (v0.1).
//   agenttuneup run  <suite.json> --consent [--keyfile path] [--out dir] [--repeats N] [gate options]
//       Evaluate the agent: writes <out>/report.json and report.md.
//   agenttuneup check <chats.txt|chats.json> [--instructions file] [--agent name] [--private words.txt] [--consent] [--keyfile path] [--out dir] [gate options]
//       Report card from real chats you paste or export (Level 1). Personal data is scrubbed locally first.
//       Without --consent only the local rule checks run and nothing leaves this machine.
//   agenttuneup tune <suite.json> --consent [--keyfile path] [--out dir] [--repeats N]
//       One verified tune-up attempt: draft the smallest fix for the failures in <out>/report.json,
//       re-run the same tests on it, save <out>/attempt-N.json, and rewrite tune-up.md with the best attempt.
//       Run it again to try once more; earlier attempts that did not help are fed back to the writer.
// A fix is a proposal. This tool never applies it to a real agent.
// Gate options (check and run; docs/CLI-PLAN.md §4): --gate turns the CI gate on (without it the exit code is 0 whatever
// the result); --min, --max-undetermined and --allow-rules-fail loosen it and are printed in the verdict; --json writes
// <out>/gate.json.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadKey, client } from './src/openrouter.js';
import { httpAdapter, modelAdapter, headerVars } from './src/adapters.js';
import { evaluate, pool, CONCURRENCY } from './src/evaluate.js';
import { validateSuite } from './src/rules.js';
import { proposeFix, WRITER_MODEL } from './src/writer.js';
import { toMarkdown, buildReport, runPassed, regressions } from './src/report.js';
import { scrubber, ScrubError } from './src/redact.js';
import { parseTranscripts, checkConversation } from './src/transcripts.js';
import { judgeConversation, judgeHeld, chatState, JUDGE_MODEL } from './src/judge.js';
import { EXIT, gate, line, gateJson } from './src/gate.js';

// Exit codes (src/gate.js), with --gate: 0 pass, 1 fail, 3 undetermined, 2 usage or config error. A crash is never 0.
// A crash prints only the error's type and where it happened, never its message: messages from fetch, Headers or JSON
// can carry a URL, a header value or input text, which would then sit in CI logs (PR #32 review).
const crashed = (e) => { const where = (String(e && e.stack || '').split('\n').find(l => /^\s+at /.test(l)) || '').trim();
  console.error(`agenttuneup: crashed (${(e && e.name) || 'Error'}${where ? ', ' + where.replace(/\(?file:\/\/[^)]*?([\w.-]+\.js:\d+):\d+\)?/, '$1') : ''}). Please report this.`); process.exit(EXIT.FAIL); };
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);
const USAGE = 'usage: agenttuneup check <chats.txt|chats.json> [--instructions file] [--agent name] [--private words.txt] [--consent] [--keyfile path] [--out dir] [gate options]\n       agenttuneup run <suite.json> --consent [--keyfile path] [--out dir] [--repeats N] [--private words.txt] [gate options]\n       agenttuneup tune <suite.json> --consent [--keyfile path] [--out dir] [--repeats N] [--private words.txt]\n       agenttuneup --version | --help\nGate options: --gate (CI gate on; without it the exit code is always 0)  --json (write gate.json)\n  Loosen the strict defaults (printed in the verdict and gate.json): --min <0-100> (default 100)  --max-undetermined <0-100> (default 0)  --allow-rules-fail\nExit codes with --gate: 0 PASS (judged) or PASS: local rules only, 1 FAIL, 3 UNDETERMINED (fails CI too), 2 usage or config error.';
const usage = (msg) => { console.error((msg ? msg + '\n' : '') + USAGE); process.exit(EXIT.USAGE); };
const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) { console.log(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version); process.exit(0); }
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { console.log(USAGE); process.exit(0); }
// Strict flags: an unknown, repeated or empty flag is an error, never ignored. No flag or setting skips a check; the only
// ways to loosen the gate are the three documented options, and each one is printed (docs/CLI-PLAN.md §4, G11b).
const GATE = { gate: 0, json: 0, min: 1, 'max-undetermined': 1, 'allow-rules-fail': 0 };
const FLAGS = { check: { instructions: 1, agent: 1, private: 1, keyfile: 1, out: 1, consent: 0, ...GATE }, run: { keyfile: 1, out: 1, repeats: 1, private: 1, consent: 0, ...GATE }, tune: { keyfile: 1, out: 1, repeats: 1, private: 1, consent: 0 } };
const [cmd, file, ...rest] = argv;
if (!Object.hasOwn(FLAGS, cmd) || !file || file.startsWith('-')) usage();
// Gating a tune-up is defined only in R2 (the best eligible attempt), so it is refused rather than guessed (G11c).
if (cmd === 'tune' && rest.some(a => Object.hasOwn(GATE, a.replace(/^--/, '')) && a.startsWith('--'))) usage('tune does not take gate options yet: gate the `run` before and after instead.');
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const m = /^--([a-z]+(?:-[a-z]+)*)$/.exec(rest[i]);
  if (!m || !Object.hasOwn(FLAGS[cmd], m[1])) usage(`Unknown option ${JSON.stringify(rest[i])} for ${cmd}.`);
  if (Object.hasOwn(flags, m[1])) usage(`--${m[1]} given twice.`);
  if (FLAGS[cmd][m[1]]) { const v = rest[i + 1]; if (v === undefined || v === '' || v.startsWith('--')) usage(`--${m[1]} needs a value.`); flags[m[1]] = v; i++; }
  else flags[m[1]] = true;
}
// Only documented TUNEUP_* variables are read; any other one is a mistake or an attempt to change behavior, so stop.
const strayEnv = Object.keys(process.env).filter(k => /^TUNEUP_/i.test(k) && !/^TUNEUP_(?:CONSENT|OPENROUTER_KEY|AGENT_[A-Z0-9_]+)$/.test(k));
if (strayEnv.length) usage(`Unknown setting ${strayEnv.join(', ')}. agenttuneup reads only TUNEUP_CONSENT, TUNEUP_OPENROUTER_KEY and TUNEUP_AGENT_*.`);
if (process.env.TUNEUP_CONSENT !== undefined && process.env.TUNEUP_CONSENT !== '1') usage('TUNEUP_CONSENT must be 1 when set.');
const opt = (name, dflt) => (Object.hasOwn(flags, name) ? flags[name] : dflt);
// Gate policy: thresholds are percentages from 0 to 100 (decimals allowed). Loosening without --gate would do nothing,
// so it is refused rather than letting someone think the gate is on (G11).
const gating = opt('gate', false) === true;
const policy = {};
for (const [name, key] of [['min', 'min'], ['max-undetermined', 'maxUndetermined']]) {
  if (!Object.hasOwn(flags, name)) continue;
  const v = flags[name], n = Number(v);
  if (!/^\d+(?:\.\d+)?$/.test(v) || !(n >= 0 && n <= 100)) usage(`--${name} must be a number from 0 to 100.`);
  policy[key] = n;
}
if (Object.hasOwn(flags, 'allow-rules-fail')) policy.allowRulesFail = true;
if (!gating && Object.keys(policy).length) usage('--min, --max-undetermined and --allow-rules-fail only apply with --gate.');
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
// One verdict for check and run, from the findings in memory (never from report.json, T5). Without --gate the verdict
// is still printed, but the exit code stays 0.
const finish = (runs, { expected, judged, unreadable = [], suiteId = null }) => {
  const g = gate(runs, { expected, judged, policy, unreadable });
  if (opt('json', false) === true) save('gate.json', JSON.stringify(gateJson(g, { engineVersion: VERSION, gating, suiteId, judgeModel: judged ? JUDGE_MODEL : null }), null, 2) + '\n');
  console.error(gating ? `${line(g)} (exit ${g.exit})` : `${line(g)} (gate off: exit 0; add --gate to fail CI on this)`);
  process.exitCode = gating ? g.exit : EXIT.PASS;
};
// --consent with no key is a config error (2), named here before anything runs.
const keyOrStop = () => { try { return loadKey(opt('keyfile')); } catch (e) { console.error(`${e.message}. Strict CI needs a key: set TUNEUP_OPENROUTER_KEY as a CI secret, or pass --keyfile.`); process.exit(EXIT.USAGE); } };
// Input files: unreadable or malformed input is a usage error (2) naming the file, never a "check failed" crash.
const readInput = (path, what) => { try { return readFileSync(path, 'utf8'); } catch (e) { usage(`Cannot read ${what} ${JSON.stringify(path)}: ${e.code || 'unreadable'}.`); } };
// Only our own messages are shown. A JSON parser's message can quote part of the file, and a chat file can hold a secret
// that has not been scrubbed yet, so a parse error says only where to look (PR #32 review).
class InputError extends Error {}
const parseInput = (path, what, parse) => { const raw = readInput(path, what); try { return parse(raw); } catch (e) { usage(`${what} ${JSON.stringify(path)} is not valid: ${e instanceof InputError ? e.message : e instanceof SyntaxError ? 'it is not valid JSON' : 'it does not have the expected shape'}.`); } };
const consent = opt('consent', false) === true || process.env.TUNEUP_CONSENT === '1';
const NOTICE = 'Remote models: the judge (Jev, via OpenRouter) and, for tune-ups, the fix writer (Nemotron on a no-training endpoint). Text is scrubbed on this machine first of emails, phone numbers, API keys and tokens, card numbers, US Social Security numbers and IPv4 addresses (other IDs, such as passport numbers, are not detected). Turn on "no training" in your OpenRouter privacy settings.';
const out = opt('out', 'tune-up-report');
// An output folder that cannot be made (a file is in the way, no permission) is a usage error, not a crash (PR #32 review).
// A probe file proves the folder takes normal files (a read-only folder or /proc passes mkdir but not this), so a bad
// --out stops here with exit 2 before anything runs or is sent, never as a crash after the run (PR #32 review).
{ const bad = (e) => usage(`Cannot use --out ${JSON.stringify(out)} as the output folder: ${e.code || 'unusable'}.`);
  // Exclusive create with a random name: never truncates or deletes a file that was already there (PR #32 review).
  try { mkdirSync(out, { recursive: true }); const probe = join(out, `.agenttuneup-write-${randomUUID()}`); writeFileSync(probe, '', { flag: 'wx' }); unlinkSync(probe); } catch (e) { bad(e); } }
// Every output file goes through here: a write that still fails later is a usage error naming the file, not a crash.
const save = (name, text) => { try { writeFileSync(join(out, name), text); } catch (e) { usage(`Cannot write ${JSON.stringify(join(out, name))}: ${e.code || 'unwritable'}.`); } };
// --private <file>: one never-send word or name per line (# starts a comment). Scrubbed before anything leaves.
const terms = opt('private') ? readInput(opt('private'), 'private words file').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean) : [];

if (cmd === 'check') {
  const scrub = scrubber({ terms });
  const instructions = opt('instructions') ? readInput(opt('instructions'), 'instructions file').trim() : '';
  const convos = parseInput(file, 'chat file', (raw) => parseTranscripts(raw, { agentName: opt('agent') }));
  const HOW = 'Label lines "User:" and "Bot:" (or your bot\'s name with --agent), and separate chats with a line of ---.';
  const or = consent ? client(keyOrStop()) : null;
  // Entries that could not be read as a chat are listed by position and count as missing: never as passed (G12b).
  const rejected = convos.rejected;
  if (rejected.length) console.error(`Not checked: entr${rejected.length === 1 ? 'y' : 'ies'} ${rejected.join(', ')} in ${file} could not be read as a chat (each needs a user and a bot turn). ${HOW}`);
  // Nothing to check: with --gate that is UNDETERMINED (G12), and the report still lists any unreadable entries;
  // without --gate, a usage error as before.
  if (!convos.length) { console.error('No conversations found. ' + HOW); if (!gating) process.exit(EXIT.USAGE); }
  else console.error(`Checking ${convos.length} conversation(s)` + (consent ? ' with the remote judge. ' + NOTICE : '. Rule checks only, nothing leaves this machine (add --consent to use the judge).'));
  // At most CONCURRENCY conversations at once (each asks the judge three times).
  const runs = await pool(convos.map((msgs, i) => [msgs, i]), CONCURRENCY, async ([msgs, i]) => {
    // A chat over the scrubber's size or time cap gets the held finding (unsure), like a run in evaluate: never a crash.
    const findings = [...checkConversation(msgs), ...(or ? await judgeHeld(scrub, chatState(instructions, msgs), (san) => judgeConversation(or, san, { hasInstructions: !!instructions })) : [])];
    // Report text is scrubbed again for display; past the scrubber's cap it is withheld rather than crashing the command
    // (PR #16 review).
    // The report goes through the same fail-closed check as the judge: residual-only secrets are held, not written out (PR #16 review).
    const shown = (t) => { try { const z = scrub.sanitize(t); return z.held ? '[held back: secret-like content]' : z.text; } catch (e) { if (e instanceof ScrubError) return '[held back: too large to scrub safely]'; throw e; } };
    return { case: `chat-${convos.positions[i]}`, rep: 1, passed: runPassed(findings), findings: findings.map(f => ({ ...f, quote: f.quote && shown(f.quote) })),
      turns: msgs.map(m => ({ role: m.role, reply: shown(m.content) })), ms: 0, tokens: 0, toolCalls: 0 };
  });
  // With no chat to check there are no scores to show (a report card over nothing would print NaN): the report says so
  // and lists what could not be read (PR #32 review).
  const rep = runs.length ? buildReport({ suite: { agent: opt('agent', 'Your agent'), repeats: 1 }, instructions, adapter: { name: 'paste', observesTools: false }, runs, judgeModel: or ? JUDGE_MODEL : 'none (rule checks only)', evidenceLevel: 1 })
    : { schema: 'tune-up/report@0.1', agent: opt('agent', 'Your agent'), evaluated_at: new Date().toISOString(), evidence_level: 1, adapter: 'paste', cases: 0, pass_rate: null, runs: [] };
  rep.scrubbed = scrub.counts();
  if (rejected.length) rep.unreadable_entries = rejected;
  save('report.json', JSON.stringify(rep, null, 2));
  const md = (runs.length ? toMarkdown(rep, { title: 'Report card' }) : `# Report card: ${rep.agent}\n\nNo chat in the file could be read, so nothing was checked and there is no score.\n`) + (rejected.length ? `\nNot checked: entr${rejected.length === 1 ? 'y' : 'ies'} ${rejected.join(', ')} of the file could not be read as a chat, so this report card is incomplete.\n` : '') + `\nScrubbed before checking: ${Object.entries(rep.scrubbed).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'nothing found'}.` + (or ? ` Model cost: $${or.spent().toFixed(5)}` : '') + '\n';
  save('report.md', md); console.log(md);
  // The exit code comes from the findings in memory, never from report.json (T5).
  finish(runs, { expected: convos.positions.map(p => ({ case: `chat-${p}`, rep: 1 })), judged: !!or, unreadable: rejected });
} else {
if (!consent) { console.error(NOTICE + '\nAdd --consent to run with remote models.'); process.exit(2); }

const suite = parseInput(file, 'suite file', (raw) => { const j = JSON.parse(raw); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new InputError('expected a JSON object'); if (!j.agent_config || typeof j.agent_config !== 'object' || Array.isArray(j.agent_config)) throw new InputError('it needs an "agent_config" object');
  // The adapter is checked before any client exists, so a half-written config never reaches a paid call (PR #32 review).
  const ac = j.agent_config, nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (typeof j.instructions !== 'string') throw new InputError('it needs "instructions" (the agent\'s instructions, as text)');
  if ('sacred' in j && (!Array.isArray(j.sacred) || !j.sacred.every(x => typeof x === 'string'))) throw new InputError('"sacred" must be a list of sentences');
  if (ac.type === 'http') { let u = null; try { u = new URL(ac.url); } catch {} if (!nonEmpty(ac.url) || !u || !/^https?:$/.test(u.protocol)) throw new InputError('agent_config.url must be an http(s) address for an "http" agent');
    // A user:password in the URL would be refused by fetch with the whole URL in the error; put it in a TUNEUP_AGENT_* header instead.
    if (u.username || u.password) throw new InputError('agent_config.url must not contain a user name or password; send credentials in a header from a TUNEUP_AGENT_* variable');
    if (ac.reply_path !== undefined && !nonEmpty(ac.reply_path)) throw new InputError('agent_config.reply_path must be a non-empty string such as "data.0.text"');
    if (ac.timeout_ms !== undefined && !intIn(ac.timeout_ms, 1, 600_000)) throw new InputError('agent_config.timeout_ms must be a whole number of milliseconds from 1 to 600000');
    if (ac.headers !== undefined && (!ac.headers || typeof ac.headers !== 'object' || Array.isArray(ac.headers) || !Object.values(ac.headers).every(v => typeof v === 'string'))) throw new InputError('agent_config.headers must map header names to text values');
    // Header names must be valid tokens and values single-line (checked again after ${TUNEUP_AGENT_*} expansion in the adapter).
    for (const [k, v] of Object.entries(ac.headers || {})) { if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new InputError('agent_config.headers has a header name that is not valid'); if (/[\r\n\0]/.test(v)) throw new InputError(`agent_config.headers.${k} must be a single line`); } }
  else if (ac.type === 'model') { if (!nonEmpty(ac.model)) throw new InputError('agent_config.model must name a model for a "model" agent');
    if (ac.max_tokens !== undefined && !intIn(ac.max_tokens, 1, 200_000)) throw new InputError('agent_config.max_tokens must be a whole number from 1 to 200000');
    if (ac.temperature !== undefined && !(typeof ac.temperature === 'number' && ac.temperature >= 0 && ac.temperature <= 2)) throw new InputError('agent_config.temperature must be a number from 0 to 2');
    if (ac.tools !== undefined && (!ac.tools || typeof ac.tools !== 'object' || Array.isArray(ac.tools))) throw new InputError('agent_config.tools must map tool names to tool definitions');
    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    for (const [name, d] of Object.entries(ac.tools || {})) {
      const t = `agent_config.tools.${name}`;
      if (!isObj(d)) throw new InputError(`${t} must be a tool definition object`);
      if ('description' in d && typeof d.description !== 'string') throw new InputError(`${t}.description must be text`);
      if ('parameters' in d && !isObj(d.parameters)) throw new InputError(`${t}.parameters must be a JSON schema object`);
      if ('read_only' in d && typeof d.read_only !== 'boolean') throw new InputError(`${t}.read_only must be true or false`);
      if ('cases' in d && (!Array.isArray(d.cases) || !d.cases.every(c => isObj(c) && (!('when' in c) || isObj(c.when))))) throw new InputError(`${t}.cases must be a list of {when, result} objects`);
    } }
  else throw new InputError('agent_config.type must be "http" or "model"');
  return j; });
{ const errs = validateSuite(suite); if (errs.length) { console.error('Fix the suite before running (nothing was sent):\n- ' + errs.join('\n- ')); process.exit(2); } }
const repeats = Number(opt('repeats', suite.repeats ?? 1));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) { console.error('--repeats (or the suite\'s "repeats") must be a whole number from 1 to 20.'); process.exit(2); }
suite.repeats = repeats;
// Ties reports and tune-up attempts to the exact suite they came from, so stale files are never mixed in.
// The --private list is part of the identity, so a tune-up can never run with a weaker never-send list than its baseline.
const suiteId = createHash('sha256').update(JSON.stringify(suite) + '\u0000' + JSON.stringify([...terms].map(t => t.toLowerCase()).sort())).digest('hex').slice(0, 16);
const or = client(keyOrStop());
const scrub = scrubber({ terms });
let adapter;
try { adapter = suite.agent_config.type === 'http' ? httpAdapter(suite.agent_config, { privateTerms: terms }) : modelAdapter(suite.agent_config, or, { scrub, privateTerms: terms }); }
catch (e) { console.error(e.message); process.exit(2); }
// A tool check on an agent whose tool calls can't be seen would never run and so could never fail: refuse the suite
// before anything is sent, rather than letting the gate pass without it (PR #32 review).
{ const blind = adapter.observesTools ? [] : suite.cases.filter(c => c.expect && ('must_call' in c.expect || 'must_not_call' in c.expect)).map(c => c.id);
  if (blind.length) usage(`Case(s) ${blind.join(', ')} check tool calls (must_call / must_not_call), but this agent's tool calls are not visible (${suite.agent_config.type} adapter). Remove those checks or use an adapter that shows tool calls. Nothing was sent.`); }
if (suite.agent_config.type === 'http') {
  const vars = headerVars(suite.agent_config);
  console.error('Use a test copy of your agent: every case is sent ' + repeats + ' time(s), and again after each tune-up, so real actions (bookings, emails) would repeat.');
  const where = (() => { try { return new URL(suite.agent_config.url).origin; } catch { return '(invalid url)'; } })();   // origin only: a signed URL's secrets never reach logs
  console.error(`Test messages go unchanged to your agent at ${where}` + (vars.length ? ` with ${vars.join(', ')} from your environment.` : '.') + ' Words in --private are never sent.');
}
if (cmd === 'tune' && adapter.acceptsInstructions === false) {
  console.error('This http agent has no way to receive new instructions, so a tune-up cannot be verified by re-running it. Add "{{instructions}}" to agent_config.body, or use the model adapter.'); process.exit(2);
}
const log = (s) => console.error('  ' + s);
// Lift in percentage points from raw pass counts (reports round pass rates for display only).
const rate = (rep) => 100 * rep.runs.filter(r => r.passed).length / rep.runs.length;
const liftOf = (before, after) => rate(after) - rate(before);
const read = (f) => JSON.parse(readFileSync(join(out, f), 'utf8'));

if (cmd === 'run') {
  console.error(`Evaluating ${suite.agent}: ${suite.cases.length} cases × ${suite.repeats} runs`);
  const rep = await evaluate({ suite, instructions: suite.instructions, adapter, or, log, scrub });
  rep.suite_id = suiteId;
  save('report.json', JSON.stringify(rep, null, 2));
  const md = toMarkdown(rep, { title: 'Report card' }) + `\nModel cost for this run: $${or.spent().toFixed(5)}\n`;
  save('report.md', md); console.log(md);
  finish(rep.gateRuns, { expected: suite.cases.flatMap(c => Array.from({ length: repeats }, (_, k) => ({ case: c.id, rep: k + 1 }))), judged: true, suiteId });
} else {
  if (!existsSync(join(out, 'report.json'))) { console.error(`No report in ${out}. Run \`run\` with the same suite and --out first.`); process.exit(2); }
  const before = read('report.json');
  if (before.suite_id !== suiteId) { console.error(`${out}/report.json was made from a different suite or settings. Run \`run\` again with this suite first.`); process.exit(2); }
  if (!before.failures.length) { const u = before.buckets.filter(b => b.status === 'warn').map(b => b.name); console.log(u.length ? `No confident failures to tune, but these were unsure: ${u.join(', ')}. Review them in report.md, or run again with more --repeats.` : 'No failures to tune.'); process.exit(0); }
  const files = readdirSync(out).map(f => f.match(/^attempt-(\d+)\.json$/)).filter(Boolean).sort((a, b) => a[1] - b[1]);
  // Only attempts made against this exact suite and baseline count; older ones are kept on disk but ignored.
  const attempts = files.map(m => read(m[0])).filter(a => a.suite_id === suiteId && a.baseline_at === before.evaluated_at);
  const n = files.length ? Number(files[files.length - 1][1]) + 1 : 1;
  console.error(`Tune-up attempt ${n}: drafting a fix with ${WRITER_MODEL}…`);
  const fix = await proposeFix(or, { instructions: suite.instructions, failures: before.failures, sacred: suite.sacred || [], cases: suite.cases,
    // Every attempt that was not proposed goes back to the writer, including positive-lift ones that broke something.
    tried: attempts.filter(a => a.lift <= 0 || a.verified !== true || regressions(before, a.after).length).map(a => ({ lift: a.lift, revised_instructions: a.fix.revised_instructions })), scrub });
  console.error('Re-running the same tests on the fixed instructions…');
  const after = await evaluate({ suite, instructions: fix.revised_instructions, adapter, or, log, scrub });
  // A re-run where the judge or the agent failed, or the text was held back, was never fully checked, so it can never be
  // proposed as verified, whatever its lift (PR #32 review). Saved with the attempt; older files without it never qualify.
  const unverified = after.gateRuns.some(r => (r.findings || []).some(f => ['judge:error', 'agent_error', 'judge:held'].includes(f.code)));
  const attempt = { attempt: n, suite_id: suiteId, baseline_at: before.evaluated_at, fix, lift: liftOf(before, after), after, cost: or.spent(), verified: !unverified };
  save(`attempt-${n}.json`, JSON.stringify(attempt, null, 2));
  const all = [...attempts, attempt].map(a => ({ ...a, regressions: regressions(before, a.after) }));
  // A tune-up that breaks something that worked, or adds any rules failure, is never proposed, whatever its lift.
  const eligible = all.filter(a => a.verified === true && a.lift > 0 && !a.regressions.length);
  const best = eligible.length ? eligible.reduce((a, b) => (b.lift > a.lift ? b : a)) : null;
  let md = toMarkdown(before, { title: 'Report card (before)' });
  md += `\n## Tune-up attempts\n\n| Attempt | Fix lift | Pass rate after | New failures |\n| --- | --- | --- | --- |\n${all.map(a => `| ${a.attempt} | ${a.lift > 0 ? '+' : ''}${Math.round(a.lift * 10) / 10} | ${a.after.pass_rate}% | ${a.regressions.join(', ') || 'none'}${a.verified === true ? '' : ' (not fully checked: a judge or agent call failed or was held back)'} |`).join('\n')}\n`;
  if (best) {
    md += `\n## Best proposed tune-up: attempt ${best.attempt} (not applied)\n\n${best.fix.changes.map(c => '- ' + c).join('\n')}\n\n**Revised instructions:**\n\n> ${best.fix.revised_instructions.replace(/\n/g, '\n> ')}\n\n`;
    md += toMarkdown(best.after, { title: 'After the best tune-up', lift: best.lift }).replace(/^# /, '## ');
  } else md += `\nNo fully checked attempt improved the agent without breaking something else${all.some(a => a.lift > 0) ? ' (attempts with new failures, or not fully checked, are never proposed)' : ''}, so there is nothing to propose. Run \`tune\` again, or review the failures by hand.\n`;
  md += `\nModel cost for this attempt: $${attempt.cost.toFixed(5)}\n`;
  save('tune-up.md', md); console.log(md);
}
}
