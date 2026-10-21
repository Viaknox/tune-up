// Judge calibration scorer (docs/CALIBRATION-PLAN.md §4). Pure: rows in, numbers and a per-bar verdict out.
// A row is { id, label: 'pass' | 'fail', state: 'ok' | 'failed' | 'undetermined' | 'missing' | 'errored', held?: boolean }.
// `label` is the truth (tau-bench reward or Paul's blind label); `state` is the engine's stateOf for that run.
// Only ok and failed are "decided". Missing and errored are never credited as handled uncertainty.
export const STATES = Object.freeze(['ok', 'failed', 'undetermined', 'missing', 'errored']);
export const BARS = Object.freeze({ agreementLower: 0.8, falsePass: 0.1, unsure: 0.2, kappa: 0.6 });

const Z2 = 1.959963984540054;   // two-sided 95%
const Z1 = 1.6448536269514722;  // one-sided 95%

// Wilson score interval for k successes in n trials; null when n is 0 (no evidence is never a pass).
export function wilson(k, n, z = Z2) {
  if (!(n > 0)) return null;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
  return { lower: Math.max(0, c - h), upper: Math.min(1, c + h) };
}

// Cohen's kappa for two binary raters given a 2x2 table; null when undefined (no items, or chance agreement is 1).
export function kappa(a, b, c, d) {
  const n = a + b + c + d;
  if (!(n > 0)) return null;
  const po = (a + d) / n;
  const pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n);
  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

/**
 * @param {{id:string,label:string,state:string,held?:boolean}[]} rows
 * @param {{falsePassRule?: 'upper'|'observed', bars?: Partial<typeof BARS>}} [opts]
 *   falsePassRule 'upper': the one-sided 95% upper bound must be within the bar (Track A);
 *   'observed': the observed rate must be, and the bound is still reported (Track B, Paul 2026-10-20).
 */
export function score(rows, { falsePassRule = 'upper', bars = {} } = {}) {
  const b = { ...BARS, ...bars };
  const seen = new Set();
  const matrix = { pass: Object.fromEntries(STATES.map(s => [s, 0])), fail: Object.fromEntries(STATES.map(s => [s, 0])) };
  let held = 0, unsure = 0;
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || seen.has(r.id)) throw new Error(`calibration: missing or duplicate id ${r && r.id}`);
    seen.add(r.id);
    if (r.label !== 'pass' && r.label !== 'fail') throw new Error(`calibration: bad label for ${r.id}`);
    if (!STATES.includes(r.state)) throw new Error(`calibration: bad state for ${r.id}`);
    matrix[r.label][r.state]++;
    if (r.state === 'undetermined') { if (r.held === true) held++; else unsure++; }
  }
  const n = rows.length;
  if (n === 0) throw new Error('calibration: no rows');
  // Decided runs: judge ok vs label pass (a), ok vs fail (b), failed vs pass (c), failed vs fail (d).
  const a = matrix.pass.ok, bb = matrix.fail.ok, c = matrix.pass.failed, d = matrix.fail.failed;
  const decided = a + bb + c + d;
  const agree = a + d;
  const agreement = wilson(agree, decided);
  const fails = STATES.reduce((s, k) => s + matrix.fail[k], 0);   // every label fail is in the denominator
  const fpBound = wilson(bb, fails, Z1);
  const fpRate = fails ? bb / fails : null;
  const k = kappa(a, bb, c, d);
  const unsureRate = unsure / n;
  const checks = {
    agreement: agreement !== null && agreement.lower >= b.agreementLower,
    falsePass: fails > 0 && (falsePassRule === 'observed' ? fpRate <= b.falsePass : fpBound.upper <= b.falsePass),
    unsure: unsureRate <= b.unsure,
    kappa: k !== null && k >= b.kappa,
  };
  return {
    n, decided, matrix, held, unsure,
    agreement: decided ? { rate: agree / decided, lower: agreement.lower, upper: agreement.upper } : null,
    falsePass: fails ? { count: bb, of: fails, rate: fpRate, upper: fpBound.upper, rule: falsePassRule } : null,
    precisionOfOk: a + bb ? a / (a + bb) : null,
    unsureRate, heldRate: held / n, kappa: k,
    checks, pass: Object.values(checks).every(Boolean),
  };
}

// Stability (§4): share of items whose state differs between two repeat runs. Ids must match exactly.
export function flipRate(runA, runB) {
  const m = new Map(runA.map(r => [r.id, r.state]));
  if (m.size !== runA.length || runB.length !== runA.length) throw new Error('calibration: repeat runs differ in size or ids');
  let flips = 0;
  for (const r of runB) {
    if (!m.has(r.id)) throw new Error(`calibration: id ${r.id} missing from first run`);
    if (m.get(r.id) !== r.state) flips++;
  }
  return runA.length ? flips / runA.length : null;
}
