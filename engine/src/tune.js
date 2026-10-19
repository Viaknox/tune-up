// What a tune-up attempt changed, judged with the same classifier as the CI gate (src/gate.js stateOf; docs/CLI-PLAN.md
// S9, checklist PG8/PG13). Pure: no I/O. cli.js reads the files, this decides.
//   lift        = (case-runs failed before and ok after) - (case-runs ok before and not ok after)
//   evidence    = moves into or out of "couldn't tell", kept apart from lift: an answer becoming vaguer is never a gain
//   eligible    = verified (every after-run fully checked, >= 2 runs per test unless overridden), lift > 0, no regressions
import { stateOf } from './gate.js';
import { REPORT_SCHEMA } from './report.js';

export class ReportError extends Error {}

const id = (r) => `${r.case}#${r.rep}`;
const UNCLEAR = new Set(['undetermined', 'missing', 'errored']);
const judgedOf = (rep) => !/^none/.test(String(rep.judge));

/**
 * Refuses a report that cannot be compared: wrong schema, other suite, duplicate or missing case-runs, or stored states
 * and counts that its own findings do not support (checklist 21). Returns the report.
 * @param {any} rep @param {{ suiteId: string, expected: { case: string, rep: number }[] }} ctx
 */
export function checkReport(rep, { suiteId, expected }) {
  if (!rep || typeof rep !== 'object') throw new ReportError('it is not a report');
  if (rep.suite_id !== suiteId) throw new ReportError('it was made from a different suite or settings. Run `run` again with this suite first');
  if (rep.schema !== REPORT_SCHEMA) {
    const older = !rep.schema || /^tune-up\/report@0\.[01]$/.test(rep.schema);
    throw new ReportError(older ? `it is an older report (${rep.schema || 'no schema'}) without the per-run findings this version needs. Make a fresh \`run\` first`
      : `it is a newer report (${rep.schema}) than this version understands. Update agenttuneup`);
  }
  if (!Array.isArray(rep.runs)) throw new ReportError('it has no runs');
  const judged = judgedOf(rep), seen = new Map();
  for (const r of rep.runs) {
    if (seen.has(id(r))) throw new ReportError(`it lists ${id(r)} twice`);
    if (!Array.isArray(r.findings) || !r.findings.length) throw new ReportError(`${id(r)} has no findings`);
    const s = stateOf(r, { judged });
    if (r.state !== s) throw new ReportError(`${id(r)} says ${r.state}, but its findings say ${s}`);
    seen.set(id(r), r);
  }
  for (const e of expected) if (!seen.has(id(e))) throw new ReportError(`it is missing ${id(e)}`);
  if (seen.size !== expected.length) throw new ReportError('it has case-runs this suite does not have');
  const counts = { expected: expected.length, ok: 0, failed: 0, undetermined: 0, missing: 0, errored: 0 };
  for (const r of rep.runs) counts[r.state]++;
  if (JSON.stringify(counts) !== JSON.stringify(rep.counts)) throw new ReportError('its counts do not match its runs');
  if (rep.pass_rate !== counts.ok / counts.expected) throw new ReportError('its pass_rate does not match its counts');
  return rep;
}

/** Every case-run reached a confident answer: ok or failed, nothing undetermined, missing or errored. */
export const fullyEvaluated = (rep) => rep.runs.length > 0 && rep.runs.every(r => r.state === 'ok' || r.state === 'failed');

/** Matched case-run comparison of two checked reports of the same suite. */
export function compare(before, after) {
  const was = new Map(before.runs.map(r => [id(r), r.state]));
  const gains = [], losses = [], evidence = { to_ok: [], from_ok: [], to_unclear: [] };
  for (const r of after.runs) {
    const b = was.get(id(r)), a = r.state;
    if (b === 'failed' && a === 'ok') gains.push(id(r));
    if (b === 'ok' && a !== 'ok') losses.push(id(r));
    if (UNCLEAR.has(b) && a === 'ok') evidence.to_ok.push(id(r));
    if (b === 'ok' && UNCLEAR.has(a)) evidence.from_ok.push(id(r));
    if (b === 'failed' && UNCLEAR.has(a)) evidence.to_unclear.push(id(r));
  }
  return { lift: gains.length - losses.length, gains, losses, evidence };
}

/**
 * Whether an attempt may be proposed, and why not. `verified` is about the evidence only; `eligible` also needs a
 * positive lift and no regressions.
 * @param {any} a attempt with lift, regressions and after (a report)
 * @param {{ repeats: number, allowSingleRepeat?: boolean }} opts
 */
export function eligibility(a, { repeats, allowSingleRepeat = false }) {
  const reasons = [];
  if (!fullyEvaluated(a.after)) reasons.push("Not verified: incomplete evidence (not fully checked: the judge couldn't tell, a call errored, or text was held back)");
  if (repeats < 2 && !allowSingleRepeat) reasons.push('Not verified: only 1 run per test, which cannot tell a real gain from judge noise. Use --repeats 2 or more, or --allow-single-repeat');
  const verified = reasons.length === 0;
  if (!(a.lift > 0)) reasons.push('no lift: no run went from failed to passed overall');
  if (a.regressions.length) reasons.push(`broke something that worked: ${a.regressions.join(', ')}`);
  return { eligible: reasons.length === 0, verified, reasons };
}

/** The best of the eligible attempts: highest lift, then fewest failures after, then the earliest attempt. */
export function pickBest(list) {
  if (!list.length) return null;
  return [...list].sort((x, y) => (y.lift - x.lift) || (x.after.counts.failed - y.after.counts.failed) || (x.attempt - y.attempt))[0];
}
