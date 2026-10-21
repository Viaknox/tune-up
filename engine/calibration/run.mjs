#!/usr/bin/env node
// Track A calibration run (docs/CALIBRATION-PLAN.md). One labeller (Jev, or one pinned panel model) over one split.
//   node calibration/run.mjs --tau <historical_trajectories> --split dev|test --who jev|panel
//        [--model id --provider name] [--seed 1] [--repeat 1] [--limit N] [--keyfile f] [--out dir]
// The test split runs only when calibration/preregistration.json matches these files and the sample exactly, and
// never twice for the same labeller and repeat (a spent test set is never re-run; plan §5).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadKey, client, outbound, HeldBack } from '../src/openrouter.js';
import { scrubber } from '../src/redact.js';
import { judgeHeld, judgeCase, heldFinding, JUDGE_MODEL } from '../src/judge.js';
import { stateOf } from '../src/gate.js';
import { adapt, judgeText } from './tau.js';
import { score } from './score.js';
import { completedState, parseVerdict, panelRequest, preregMismatches, sha256, pool } from './runner.js';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const { values: a } = parseArgs({ options: {
  tau: { type: 'string' }, split: { type: 'string' }, who: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' },
  seed: { type: 'string', default: '1' }, repeat: { type: 'string', default: '1' }, limit: { type: 'string' }, keyfile: { type: 'string' },
  out: { type: 'string', default: 'calibration-out' }, concurrency: { type: 'string', default: '4' },
} });
const die = (m) => { console.error(m); process.exit(2); };
if (!a.tau || !['dev', 'test'].includes(a.split) || !['jev', 'panel'].includes(a.who)) die('usage: run.mjs --tau dir --split dev|test --who jev|panel [--model id --provider name]');
if (a.who === 'panel' && (!a.model || !a.provider)) die('panel runs need --model and --provider (pinned)');
if (a.split === 'test' && a.limit) die('--limit is for dev pilots only; the test split always runs in full');

const manifest = JSON.parse(readFileSync(join(ENGINE, 'calibration/track-a.sample.json'), 'utf8'));
const files = readdirSync(a.tau).filter(f => f.endsWith('.json')).sort();
const items = new Map();
for (const f of files) {
  const raw = readFileSync(join(a.tau, f));
  if (manifest.fileHashes[f] !== sha256(raw)) die(`${f} does not match the tau-bench files the sample was drawn from`);
  for (const t of JSON.parse(raw)) { const it = adapt(f, t); items.set(it.id, it); }
}
let ids = manifest[a.split];
if (a.limit) ids = ids.slice(0, Number(a.limit));

const who = a.who === 'jev' ? JUDGE_MODEL : a.model;
const tag = `${a.who}-${who.replace(/[^\w.-]+/g, '_')}-r${a.repeat}-${a.split}`;
mkdirSync(a.out, { recursive: true });
const outFile = join(a.out, tag + '.jsonl');
if (a.split === 'test') {
  const pre = join(ENGINE, 'calibration/preregistration.json');
  if (!existsSync(pre)) die('No calibration/preregistration.json: the test split is locked until Paul approves the pre-registration.');
  const prereg = JSON.parse(readFileSync(pre, 'utf8'));
  const actual = { sampleHash: manifest.sampleHash, files: Object.fromEntries(Object.keys(prereg.files || {}).map(f => [f, existsSync(join(ENGINE, f)) ? sha256(readFileSync(join(ENGINE, f))) : null])) };
  const bad = preregMismatches(prereg, actual);
  if (bad.length) die('Refusing the test split; these differ from the pre-registration: ' + bad.join(', '));
  if (a.who === 'panel' && !(prereg.panel || []).some(p => p.model === a.model && p.provider === a.provider)) die('This panel model/provider is not in the pre-registration.');
  if (existsSync(outFile)) die(`${outFile} exists: this test run is spent and is never re-run.`);
}

const or = client(loadKey(a.keyfile));
const scrub = scrubber({});
const guide = readFileSync(join(ENGINE, 'calibration/guide-track-a.md'), 'utf8');
const startedAt = new Date().toISOString();
const rows = await pool(ids.map(id => items.get(id)), Number(a.concurrency), async (it) => {
  if (!it) throw new Error('id missing from tau-bench files');
  const base = { id: it.id, label: it.label, at: new Date().toISOString() };
  if (a.who === 'jev') {
    const findings = await judgeHeld(scrub, judgeText(it), (san) => judgeCase(or, san));
    return { ...base, ...completedState(findings), runState: stateOf({ findings }, { judged: true }), findings: findings.map(f => ({ code: f.code, ok: f.ok, unsure: f.unsure, p: f.p })) };
  }
  const held = (await judgeHeld(scrub, judgeText(it), async (san) => {
    try {
      const j = await outbound(or, 'chat', san, (text) => panelRequest({ model: a.model, provider: a.provider, seed: Number(a.seed) }, guide, text));
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      base.state = parseVerdict(content); base.servedBy = { model: j.model, provider: j.provider };
      return [];
    } catch (e) { if (e instanceof HeldBack) return [heldFinding(e.cap)]; throw e; }
  })).some(f => f.code === 'judge:held');
  return held ? { ...base, state: 'undetermined', held: true } : base;
});
writeFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const summary = score(rows, { falsePassRule: 'upper' });
writeFileSync(join(a.out, tag + '.summary.json'), JSON.stringify({ who, provider: a.provider ?? 'openrouter decisions', split: a.split, repeat: Number(a.repeat), seed: Number(a.seed), startedAt, n: rows.length, cost: or.spent(), summary }, null, 1) + '\n');
console.log(`${tag}: ${rows.length} items, agreement ${summary.agreement ? (summary.agreement.rate * 100).toFixed(1) + '%' : 'n/a'}, unsure ${(summary.unsureRate * 100).toFixed(1)}%, held ${(summary.heldRate * 100).toFixed(1)}%, cost $${or.spent().toFixed(4)}`);
