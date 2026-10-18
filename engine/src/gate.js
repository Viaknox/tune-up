// The CI gate (docs/CLI-PLAN.md §4). Classifies every expected case-run from the findings in memory, never from
// report.json, and turns the counts into one verdict and exit code:
//   0  PASS (judged), or PASS: local rules only (no --consent; never badge-eligible)
//   1  FAIL: below --min, too many undetermined, or a "Follows your rules" failure (unless --allow-rules-fail)
//   3  UNDETERMINED: nothing evaluated, expected results missing, a requested judge or agent call failed, or every
//      case-run was held back (the scrubber could not make the text safe to check, so nothing was judged)
//   2  usage/config errors are decided in cli.js before anything runs, never here
// Defaults are strict (--min 100, --max-undetermined 0, rules veto on). Loosened settings are listed in the verdict.
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 2, UNDETERMINED: 3 });
export const DEFAULT_POLICY = Object.freeze({ min: 100, maxUndetermined: 0, allowRulesFail: false });

const ANSWER = /^judge:(?!held$|error$)/;   // a judge question that was actually answered
const ERRORED = new Set(['judge:error', 'agent_error']);
const failedF = (f) => !f || (f.ok !== true && f.unsure !== true);
const unsureF = (f) => !!f && f.unsure === true;
const findingsOf = (r) => (r && Array.isArray(r.findings) ? r.findings : null);

// One case-run's state, by precedence: errored > failed > missing > undetermined > ok (§4 "Unit of scoring").
// `judged`: the judge was requested, so a run with no judge answer and no held finding lacks required evidence.
export function stateOf(run, { judged }) {
  const fs = findingsOf(run);
  if (!fs || !fs.length) return 'missing';
  if (fs.some(f => f && ERRORED.has(f.code))) return 'errored';
  if (fs.some(failedF)) return 'failed';
  if (judged && !fs.some(f => ANSWER.test(String(f.code)) || f.code === 'judge:held')) return 'missing';
  if (fs.some(unsureF)) return 'undetermined';   // past the failed check, every finding that is not ok is unsure
  return 'ok';
}

/**
 * @param {any[]} runs produced case-runs ({case, rep, findings})
 * @param {{expected: {case: string, rep: number}[], judged: boolean, policy?: Partial<typeof DEFAULT_POLICY>, unreadable?: number[]}} opts
 *   `unreadable`: 1-based positions of input entries the parser could not read as a chat; each is a missing case-run.
 */
export function gate(runs, { expected, judged, policy = {}, unreadable = [] }) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const key = (c, r) => JSON.stringify([String(c), Number(r)]);
  const want = new Set(expected.map(e => key(e.case, e.rep)));
  // Produced results are matched one-to-one to expected identities; duplicates and extras never count (G13c).
  const got = new Map(), ignored = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    const k = r && key(r.case, r.rep);
    if (!r || !want.has(k) || got.has(k)) ignored.push({ case: r && r.case, rep: r && r.rep });
    else got.set(k, r);
  }
  const rows = expected.map(e => { const r = got.get(key(e.case, e.rep)); return { case: e.case, rep: e.rep, state: r ? stateOf(r, { judged }) : 'missing' }; });
  for (const pos of unreadable) rows.push({ case: `chat-${pos}`, rep: 1, state: 'missing', unreadable: true });
  const counts = { expected: rows.length, ok: 0, failed: 0, undetermined: 0, missing: 0, errored: 0 };
  for (const r of rows) counts[r.state]++;
  // The matched runs that carry findings (a run without a findings list is already counted as missing above).
  const produced = expected.map(e => got.get(key(e.case, e.rep))).filter(findingsOf);
  const total = rows.length;
  // Undetermined rate: runs with any unsure or held finding, out of the judged runs. A failed run still counts here.
  const undRuns = judged ? produced.filter(r => findingsOf(r).some(unsureF)).length : 0;
  // Held: the text could not be made safe to send or check. Reached only when nothing is missing, so `produced` is never empty.
  const heldAll = produced.every(r => { const fs = findingsOf(r); return fs.some(f => f && f.code === 'judge:held') && !fs.some(f => f && ANSWER.test(String(f.code))); });
  const rulesFail = produced.some(r => findingsOf(r).some(f => !!f && f.bucket === 'rules' && failedF(f)));
  const failedCodes = [...new Set(produced.flatMap(r => findingsOf(r).filter(failedF).map(f => (f && f.code) || 'malformed finding')))];
  const reasons = [];
  let exit;
  if (!total) { exit = EXIT.UNDETERMINED; reasons.push('nothing was evaluated'); }
  else if (counts.errored) { exit = EXIT.UNDETERMINED; reasons.push(`${counts.errored} case-run(s) errored: a requested judge or agent call failed`); }
  else if (counts.missing) { exit = EXIT.UNDETERMINED; reasons.push(`${counts.missing} expected case-run(s) missing`); }
  else if (heldAll) { exit = EXIT.UNDETERMINED; reasons.push('every case-run was held back to protect a secret or because it was too large to scrub'); }
  else {
    // Raw counts, never rounded (G3b): ok/total >= min/100  <=>  ok*100 >= min*total.
    if (counts.ok * 100 < p.min * total) reasons.push(`strict pass rate ${(100 * counts.ok / total).toFixed(1)}% is below --min ${p.min}`);
    if (judged && undRuns * 100 > p.maxUndetermined * produced.length) reasons.push(`undetermined rate ${(100 * undRuns / produced.length).toFixed(1)}% is above --max-undetermined ${p.maxUndetermined}`);
    if (rulesFail && !p.allowRulesFail) reasons.push('a "Follows your rules" check failed');
    exit = reasons.length ? EXIT.FAIL : EXIT.PASS;
  }
  const loosened = [];
  if (p.min !== DEFAULT_POLICY.min) loosened.push(`--min ${p.min}`);
  if (p.maxUndetermined !== DEFAULT_POLICY.maxUndetermined) loosened.push(`--max-undetermined ${p.maxUndetermined}`);
  if (p.allowRulesFail) loosened.push('--allow-rules-fail');
  const verdict = exit === EXIT.PASS ? (judged ? 'PASS (judged)' : 'PASS: local rules only') : exit === EXIT.FAIL ? 'FAIL' : 'UNDETERMINED';
  return {
    exit, verdict, reasons, failed_codes: failedCodes, loosened, evidence: judged ? 'judged' : 'rules-only',
    policy: { min: p.min, max_undetermined: p.maxUndetermined, allow_rules_fail: p.allowRulesFail },
    counts, strict_pass_rate: total ? +(100 * counts.ok / total).toFixed(4) : 0,
    undetermined_rate: judged && produced.length ? +(100 * undRuns / produced.length).toFixed(4) : null,
    missing: rows.filter(r => r.state === 'missing').map(({ state, ...r }) => r),
    errored: rows.filter(r => r.state === 'errored').map(({ state, ...r }) => r),
    ignored,
  };
}

// The CI log line: the verdict, every loosened setting, why, and the failing checks (F1 "names both").
export function line(g) {
  return `agenttuneup: ${g.verdict}` + (g.loosened.length ? ` [loosened: ${g.loosened.join(', ')}]` : '')
    + (g.reasons.length ? ` - ${g.reasons.join('; ')}` : '') + (g.failed_codes.length ? ` (failed: ${g.failed_codes.join(', ')})` : '');
}

// gate.json (G14): a frozen shape. Adding or renaming a key is a schema change.
export function gateJson(g, { engineVersion, gating, suiteId, judgeModel }) {
  return {
    schema: 'agenttuneup/gate@0.1', engine_version: engineVersion, gating, verdict: g.verdict, exit: gating ? g.exit : EXIT.PASS,
    reasons: g.reasons, failed_codes: g.failed_codes, policy: g.policy, loosened: g.loosened, evidence: g.evidence,
    suite_id: suiteId ?? null, judge_model: judgeModel, counts: g.counts, strict_pass_rate: g.strict_pass_rate,
    undetermined_rate: g.undetermined_rate, missing: g.missing, errored: g.errored, ignored: g.ignored,
  };
}
