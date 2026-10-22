// Calibration runs (docs/CALIBRATION-PLAN.md §3–§5). Pure helpers; run.mjs does the file and network work.
import { createHash } from 'node:crypto';

// Track A compares the judge's `completed` answer with the tau-bench reward (plan §2), not the whole run.
// Held text and judge errors carry no `completed` answer, so they become held-undetermined and errored.
export function completedState(findings) {
  if (!Array.isArray(findings) || !findings.length) return { state: 'missing' };
  if (findings.some(f => f && (f.code === 'judge:error' || f.code === 'agent_error'))) return { state: 'errored' };
  if (findings.some(f => f && f.code === 'judge:held')) return { state: 'undetermined', held: true };
  const c = findings.find(f => f && f.code === 'judge:completed');
  if (!c) return { state: 'missing' };
  if (c.unsure === true) return { state: 'undetermined' };
  return { state: c.ok === true ? 'ok' : 'failed', p: c.p };
}

// The panel answers in free text and must end with "VERDICT: PASS" or "VERDICT: FAIL". The last such line counts;
// anything else is undetermined, never guessed.
export function parseVerdict(text) {
  const all = [...String(text ?? '').matchAll(/^\s*\**\s*VERDICT\s*:\s*\**\s*(PASS|FAIL)\b/gim)];
  if (!all.length) return 'undetermined';
  return all.at(-1)[1].toUpperCase() === 'PASS' ? 'ok' : 'failed';
}

// One fresh request per item and model: no history, temperature 0, fixed seed, the pinned provider only.
export function panelRequest({ model, provider, seed }, guide, text) {
  if (!model || !provider) throw new Error('calibration: panel model and provider must be pinned');
  return {
    model,
    temperature: 0,
    seed,
    provider: { order: [provider], allow_fallbacks: false },
    messages: [
      { role: 'system', content: guide },
      { role: 'user', content: text },
    ],
  };
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// The test split may only run against the exact files and sample that Paul approved (plan §5.1). Returns the list of
// mismatches; an empty list means the run matches the pre-registration.
export function preregMismatches(prereg, actual) {
  if (!prereg || typeof prereg !== 'object' || !prereg.files || !prereg.sampleHash) return ['no valid pre-registration'];
  const out = [];
  if (prereg.sampleHash !== actual.sampleHash) out.push('sample');
  for (const [f, h] of Object.entries(prereg.files)) if (actual.files[f] !== h) out.push(f);
  for (const f of Object.keys(actual.files)) if (!(f in prereg.files)) out.push(f + ' (not pre-registered)');
  return out;
}

// Runs `fn` over items with at most `limit` in flight; results keep the input order. A thrown error becomes an
// errored row for that item, so one bad call never hides the others. The row keeps the error's first line (capped):
// errors from the OpenRouter client name the status and the provider's message, never the text that was sent.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { id: items[i].id, label: items[i].label, state: 'errored', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
