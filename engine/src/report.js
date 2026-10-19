// Turns per-case findings into the six-part report card (schema "tune-up/report@0.2"). Each case-run's state comes from
// the CI gate's classifier (src/gate.js stateOf), so the report, the gate, `tune` and the hosted card can never disagree
// about what passed (docs/CLI-PLAN.md S9, PG8). Only "ok" is a pass; "couldn't tell" never is.
import { gate, stateOf } from './gate.js';

export const REPORT_SCHEMA = 'tune-up/report@0.2';
export const BUCKETS = [
  ['done', 'Gets it done'],
  ['tools', 'Uses tools and skills right'],
  ['truth', 'Tells the truth'],
  ['rules', 'Follows your rules'],
  ['waste', 'Wastes nothing'],
  ['happy', 'Keeps you happy'],
];

// The R1 rule, kept only for the deprecated legacy number (PG15, one release): a run with no confident failure counted as
// passed even when the judge could not tell. Never used for any decision.
const lenientPassed = (findings) => findings.every(f => f.ok || f.unsure);

/**
 * @param {{ suite: any, instructions: string, adapter: any, runs: any[], judgeModel: string, evidenceLevel: number,
 *   expected?: { case: string, rep: number }[], unreadable?: number[] }} args
 *   `expected`: the case-runs that should exist (default: the ones given); `unreadable`: input entries that could not be
 *   read as a chat, each a missing case-run (as in the gate).
 */
export function buildReport({ suite, instructions, adapter, runs, judgeModel, evidenceLevel, expected, unreadable = [] }) {
  const judged = !/^none/.test(String(judgeModel));
  const exp = expected || runs.map(r => ({ case: r.case, rep: r.rep }));
  const counts = gate(runs, { expected: exp, judged, unreadable }).counts;
  const stated = runs.map(r => ({ ...r, state: stateOf(r, { judged }) }));
  const all = runs.flatMap(r => r.findings.map(f => ({ ...f, case: r.case, rep: r.rep })));
  const buckets = BUCKETS.map(([id, name]) => {
    const fs = all.filter(f => f.bucket === id);
    if (id === 'happy' && !fs.length) return { id, name, status: 'not_available', reason: 'Needs real conversations; scripted tests cannot show how users feel.' };
    if (id === 'tools' && !adapter.observesTools) return { id, name, status: 'not_available', reason: 'This agent does not expose its tool calls.' };
    if (!fs.length) return { id, name, status: 'not_tested', reason: 'No check covered this part.' };
    const failed = fs.filter(f => !f.ok && !f.unsure), unsure = fs.filter(f => f.unsure);
    // Unsure answers are neither passes nor fails, so they must not dilute a confident failure rate.
    const rate = failed.length / Math.max(1, fs.length - unsure.length);
    // Safety is never averaged: one failure in "Follows your rules" fails the card part.
    const status = failed.length === 0 ? (unsure.length ? 'warn' : 'pass') : (id === 'rules' || rate >= 0.3 ? 'fail' : 'warn');
    const worst = failed[0] || unsure[0];
    return { id, name, status, checks: fs.length, failed: failed.length, unsure: unsure.length,
      reason: worst ? `${worst.case}: ${worst.detail}` : `All ${fs.length} checks passed`, quote: worst && worst.quote };
  });
  const waste = runs.reduce((a, r) => ({ ms: a.ms + r.ms, tokens: a.tokens + (r.tokens || 0), toolCalls: a.toolCalls + r.toolCalls }), { ms: 0, tokens: 0, toolCalls: 0 });
  const wb = /** @type {any} */ (buckets.find(b => b.id === 'waste'));
  // Tokens and tool calls are unknown (null) for agents that don't expose them, never shown as 0.
  const known = (k) => runs.every(r => r[k] !== null && r[k] !== undefined);
  wb.usage = { avg_seconds: +(waste.ms / runs.length / 1000).toFixed(1), avg_tokens: known('tokens') ? Math.round(waste.tokens / runs.length) : null, avg_tool_calls: known('toolCalls') ? +(waste.toolCalls / runs.length).toFixed(1) : null };
  const byCase = Object.create(null);   // case ids are user text: "__proto__" or "constructor" must be plain keys (PR #32 review)
  for (const r of stated) (byCase[r.case] ||= []).push(r.state === 'ok');
  const inconsistent = Object.entries(byCase).filter(([, v]) => v.some(Boolean) && v.some(x => !x)).map(([k]) => k);
  return {
    schema: REPORT_SCHEMA, agent: suite.agent, evaluated_at: new Date().toISOString(),
    evidence_level: evidenceLevel, adapter: adapter.name, judge: judgeModel, rubric: 'six-part@0.1',
    instructions_sha: hash(instructions), cases: Object.keys(byCase).length, repeats: suite.repeats || 1,
    // Strict: ok out of every expected case-run, as a raw fraction (rounded only for display).
    counts, pass_rate: counts.expected ? counts.ok / counts.expected : 0, inconsistent_cases: inconsistent, buckets,
    failures: all.filter(f => !f.ok && !f.unsure).map(f => ({ case: f.case, rep: f.rep, bucket: f.bucket, code: f.code, detail: f.detail, quote: f.quote })),
    runs: stated.map(r => ({ case: r.case, rep: r.rep, state: r.state, findings: r.findings, turns: r.turns })),
    legacy: { pass_rate_lenient: runs.length ? runs.filter(r => lenientPassed(r.findings)).length / runs.length : 0,
      note: 'Deprecated: counted unsure answers as passes. Never used for any decision; removed in 0.3.' },
  };
}

// What a tune-up broke: every matched case-run that was ok before and is not ok after (failed, couldn't tell, missing or
// errored), and any "Follows your rules" failure that is new.
/** @param {any} before @param {any} after */
export function regressions(before, after) {
  const id = (r) => `${r.case}#${r.rep}`;
  const okBefore = new Set(before.runs.filter(r => r.state === 'ok').map(id));
  const broke = after.runs.filter(r => okBefore.has(id(r)) && r.state !== 'ok').map(id);
  // Rules failures are compared one by one (case, rule and what was violated, counted), so a second leak in a case
  // that already leaked something else still counts as new.
  // Judge details carry a vote percentage that changes run to run; compare without it.
  const key = (f) => JSON.stringify([f.case, f.code, String(f.code).startsWith('judge:') ? String(f.detail || '').replace(/\s*\(\d+%\)(, unsure)?$/, '') : f.detail]);
  const left = new Map(); for (const f of before.failures.filter(f => f.bucket === 'rules')) left.set(key(f), (left.get(key(f)) || 0) + 1);
  const newRules = after.failures.filter(f => f.bucket === 'rules').filter(f => { const n = left.get(key(f)) || 0; if (n) { left.set(key(f), n - 1); return false; } return true; })
    .map(f => `${f.case} (${f.code}: ${f.detail})`);
  return [...new Set(broke), ...new Set(newRules)].map(cell);   // de-duplicated within each kind, so a case id can't hide a rule failure
}

function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h.toString(16); }

// Table cells: a | or a line break inside a reason or quote would split the row.
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');

const ICON = { pass: '✅ pass', warn: '⚠️ warn', fail: '❌ fail', not_available: '— not available', not_tested: '— not tested' };

// The headline in words, never a percentage: "Passed 7 of 10 runs · 2 couldn't tell · 1 failed". Errored and missing
// runs are named only when there are some.
export function headline(c) {
  const parts = [`**Passed ${c.ok} of ${c.expected} run${c.expected === 1 ? '' : 's'}**`];
  if (c.undetermined) parts.push(`${c.undetermined} couldn't tell`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.errored) parts.push(`${c.errored} errored`);
  if (c.missing) parts.push(`${c.missing} missing`);
  return parts.join(' · ');
}

/** @param {any} rep @param {{ title?: string, lift?: number }} [opts] */
export function toMarkdown(rep, { title, lift } = {}) {
  const L = [];
  L.push(`# ${title || 'Report card'}: ${rep.agent}`, '');
  L.push(`Evidence: Level ${rep.evidence_level} (${['', 'chats only', 're-run tested', 'live telemetry'][rep.evidence_level]}) · ${rep.cases} test cases × ${rep.repeats} runs · judge ${rep.judge} · rubric ${rep.rubric} · ${rep.evaluated_at.slice(0, 10)}`, '');
  if (/^none/.test(rep.judge)) L.push('**Rule checks only.** Most of the report card needs the judge; run again with --consent for the full report.', '');
  L.push(`${headline(rep.counts)}${lift != null ? ` · **Fix lift: ${lift > 0 ? '+' : ''}${lift} run${Math.abs(lift) === 1 ? '' : 's'}**` : ''}${rep.inconsistent_cases.length ? ` · Inconsistent across runs: ${rep.inconsistent_cases.join(', ')}` : ''}`, '');
  L.push('| Part | Result | Why |', '| --- | --- | --- |');
  for (const b of rep.buckets) {
    let why = b.reason + (b.quote ? ` — "${b.quote}"` : '');
    if (b.usage && rep.evidence_level > 1) why += ` (avg ${b.usage.avg_seconds}s, ${b.usage.avg_tokens ?? 'unknown'} tokens, ${b.usage.avg_tool_calls ?? 'unknown'} tool calls per case)`;
    L.push(`| ${b.name} | ${ICON[b.status]} | ${cell(why)} |`);
  }
  return L.join('\n') + '\n';
}
