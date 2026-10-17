// Runs a test suite against an agent: every case `repeats` times, rule checks first, then the judge.
import { checkCase } from './rules.js';
import { judgeCase, judgeHeld, transcript, heldFinding, JUDGE_MODEL } from './judge.js';
import { HeldBack, AgentReplyError } from './openrouter.js';
import { buildReport, runPassed } from './report.js';
import { scrubber } from './redact.js';

export const CONCURRENCY = 4;

// Transport failures from the agent or the replay model: a timeout, a network error or refused redirect, an HTTP error
// status. Only these become an unsure run; every other error is a refusal or a bug and is re-thrown.
export const isOutage = (e) => !!e && (e instanceof AgentReplyError || e.name === 'TimeoutError' || e.name === 'AbortError'
  || (e instanceof TypeError && /fetch failed|network/i.test(e.message)) || /^(?:agent endpoint \d{3}|OpenRouter \/)/.test(String(e.message)));
// The detail names only the HTTP status or "timed out", never the error text, which could carry a URL or a reply body.
export const agentError = (e) => {
  const status = /^(?:agent endpoint|OpenRouter \/\S+) (\d{3})\b/.exec(String(e && e.message));
  const why = e instanceof AgentReplyError ? 'unusable reply' : status ? `HTTP ${status[1]}` : e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timed out' : 'could not connect';
  return { bucket: 'done', code: 'agent_error', ok: false, unsure: true, detail: `unsure: the agent could not be reached or replied with an error (${why}), so this run was not checked` };
};
export async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

// The judge sees a Sanitized only. A ScrubError (the scrubber's size or time cap) means no call for that run: the run is
// marked unsure with the held finding rather than crashing the whole evaluation or sending unscrubbed text.
const judge = (or, scrub, text) => judgeHeld(scrub, text, (sanitized) => judgeCase(or, sanitized));

export async function evaluate({ suite, instructions, adapter, or, log = () => {}, scrub = scrubber() }) {
  // Up to CONCURRENCY cases run at once (bounds cost and rate-limit bursts); repeats of one case run one after another.
  const perCase = await pool(suite.cases, CONCURRENCY, async (c) => {
    const runs = [];
    for (let rep = 1; rep <= (suite.repeats || 1); rep++) {
      const history = []; const turns = []; let held = false, heldCap = false, down = null;
      for (const message of c.turns) {
        let t;
        // The replay model's input was held back (a secret survived scrubbing): no call was made; the run is unsure.
        // The agent being unreachable or erroring is not a failed check: the run is unsure and the other cases still run
        // (PR #32 review). Anything else (a refusal to send, a bug) still stops the run loudly.
        try { t = await adapter.turn({ history, message, instructions }); } catch (e) { if (e instanceof HeldBack) { held = true; heldCap = e.cap; break; } if (isOutage(e)) { down = e; break; } throw e; }
        turns.push(t);
        // Keep tool calls and results in the history when the adapter exposes them (model adapter), not just the reply.
        history.push({ role: 'user', content: message }, ...(t.messages || [{ role: 'assistant', content: t.reply }]));
      }
      // A held run still keeps the failures its completed turns already proved and that later turns cannot undo (a false
      // "done", a forbidden call or phrase); end-of-run expectations are not judged for turns that never ran (PR #16 review).
      const MONOTONE = new Set(['false_done', 'must_not_call', 'must_not_say']);
      const proven = () => (turns.length ? checkCase(c, turns, adapter).filter(f => MONOTONE.has(f.code) && !f.ok && !f.unsure) : []);
      const findings = held ? [heldFinding(heldCap), ...proven()] : down ? [agentError(down), ...proven()]
        : [...checkCase(c, turns, adapter), ...await judge(or, scrub, transcript(c, instructions, turns, adapter.observesTools))];
      const passed = runPassed(findings);
      runs.push({ case: c.id, rep, passed, findings, turns: turns.map(t => ({ reply: t.reply, tools: t.tools, ...(t.truncated ? { truncated: true } : {}) })),
        ms: turns.reduce((a, t) => a + t.ms, 0), tokens: turns.some(t => t.tokens == null) ? null : turns.reduce((a, t) => a + t.tokens, 0),
        toolCalls: adapter.observesTools ? turns.reduce((a, t) => a + ((t.tools || []).length), 0) : null });
      log(`${c.id} run ${rep}: ${passed ? 'pass' : 'FAIL'}`);
    }
    return runs;
  });
  const runs = perCase.flat();
  const rep = buildReport({ suite, instructions, adapter, runs, judgeModel: JUDGE_MODEL, evidenceLevel: 2 });
  // The full findings for the CI gate (src/gate.js). Not enumerable, so it never lands in report.json.
  Object.defineProperty(rep, 'gateRuns', { value: runs, enumerable: false });
  return rep;
}
