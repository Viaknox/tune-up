// Deterministic checks: cheap, exact, and run before any model is asked anything.
// Each returns findings { bucket, code, ok, detail, quote? } for one case run.

// A success claim ("I've booked it", "booking confirmed"), not a mention ("room C is fully booked").
const DONE = /\b(i('ve| have)?\s+(just\s+)?(booked|reserved|scheduled|sent|completed|confirmed)|(is|are|has been|have been)\s+(now\s+)?(booked|reserved|scheduled|sent|confirmed)\s+(for you|successfully)|booking\s+(is\s+)?confirmed|successfully\s+(booked|reserved|sent|scheduled)|all set|^done\b)/im;
const NOT_DONE = /\b(fully booked|already booked|not available|unavailable|couldn't|could not|unable|failed|wasn't able|was not able|no longer available)\b/i;
// Unicode-safe whole-word match, so values like "René", "C++" or "$100" are still caught.
const word = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
const REFUSAL = /\b(can't|cannot|can not|unable to|not able to|won't|not allowed|not permitted)\b/i;
// An apology alone ("Sorry, Sarah's calendar is…") is not a refusal, so "sorry" is deliberately not listed.
// A lookup (get_calendar, search_rooms…) succeeding is not evidence that a booking or send happened. Tools can say so
// explicitly with "read_only": true in the suite; otherwise names that start with a read verb count as lookups.
const READ = /^(get|list|search|find|read|check|lookup|look_up|fetch|view|query|show)(?:[_-]|$)/i;
const isRead = (x) => x.readOnly === true || READ.test(String(x.name || ''));
// A specific claim ("booked", "sent") should be backed by a matching kind of action. Generic claims ("done",
// "all set", "confirmed") accept any action. Tool names vary, so a mismatch is reported as unsure, not as a lie.
// Any claim that names what was done ("booking confirmed", "completed your reservation") is classified by that word.
// The completed verb wins over a noun ("sent the booking confirmation" is a send), so sending is checked first.
const KINDS = [[/\b(sent|send|e-?mail(ed)?|messag\w*)\b/i, /send|mail|message|sms|text|post|notify|reply/i], [/\b(book(ed|ing)?|reserv\w*)\b/i, /book|reserv/i], [/\b(schedul\w*|meeting|appointment|event|invite\w*)\b/i, /schedul|calendar|event|meeting|book|invite/i]];
const matches = (claim, x) => { const k = KINDS.find(([v]) => v.test(claim)); return !k || k[1].test(String(x.name || '')); };
const QUESTION = /\?\s*$|\b(which|what time|what room|when would|could you (tell|confirm|share))\b/i;

// Suite checks before any paid request: every case has an id and user turns, and every must_say_any pattern compiles and
// has no nested quantifier (the shapes that make backtracking regexes run for minutes, e.g. (a+)+).
// Any repeated group, e.g. (a+)+ or (a|aa)+, can backtrack for minutes; only simple patterns like RB-\d+ are allowed.
const NESTED = /\)\s*(?:[+*?]|\{\d)/;
export function validateSuite(suite) {
  const errs = [];
  if (!Array.isArray(suite.cases) || !suite.cases.length) return ['The suite has no test cases. Add at least one case to "cases".'];
  const seen = new Set();
  suite.cases.forEach((c, i) => {
    // A case that is not an object cannot be checked further (`in` would throw on a string): report it and move on.
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errs.push(`case ${i + 1}: must be an object with "id" and "turns"`); return; }
    const at = `case ${i + 1}${c && c.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c.id !== 'string' || !c.id) errs.push(`${at}: needs an "id"`);
    // Case ids name the runs in the report and the gate; two cases with one id would merge into one (PR #32 review).
    else if (seen.has(c.id)) errs.push(`${at}: the id "${c.id}" is used by another case; every case needs its own id`);
    else seen.add(c.id);
    // Tool expectations must have the documented shape: a string would be read letter by letter (PR #32 review).
    // "expect" must be an object when given; anything else is a config error, not a crash (PR #32 review).
    const raw = c && c.expect;
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) errs.push(`${at}: "expect" must be an object`);
    const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if ('must_call' in e && (typeof e.must_call !== 'string' || !e.must_call)) errs.push(`${at}: "must_call" must be one tool name`);
    if ('must_not_call' in e && (!Array.isArray(e.must_not_call) || !e.must_not_call.length || !e.must_not_call.every(t => typeof t === 'string' && t))) errs.push(`${at}: "must_not_call" must be a list of tool names`);
    if (!c || !Array.isArray(c.turns) || !c.turns.length || !c.turns.every(t => typeof t === 'string')) errs.push(`${at}: "turns" must be a list of user messages`);
    // Every other documented field is shape-checked too, so a malformed suite is a config error before anything is sent,
    // never a crash after the agent and judge calls (PR #32 review).
    if (c && 'intent' in c && typeof c.intent !== 'string') errs.push(`${at}: "intent" must be text`);
    const words = (k) => { if (k in e && (!Array.isArray(e[k]) || !e[k].length || !e[k].every(x => typeof x === 'string' && x))) { errs.push(`${at}: "${k}" must be a list of words or patterns`); return false; } return true; };
    const sayOk = words('must_say_any'); words('must_not_say');
    for (const k of ['refuse', 'ask_clarify']) if (k in e && typeof e[k] !== 'boolean') errs.push(`${at}: "${k}" must be true or false`);
    for (const p of (sayOk && e.must_say_any) || []) {
      try { new RegExp(p, 'i'); } catch { errs.push(`${at}: must_say_any pattern ${JSON.stringify(p)} is not a valid regex`); continue; }
      if (String(p).length > 200 || NESTED.test(String(p))) errs.push(`${at}: must_say_any pattern ${JSON.stringify(p)} is too complex (nested repeats); use a simpler one`);
    }
  });
  return errs;
}

export function checkCase(c, turns, { observesTools }) {
  const out = [];
  const e = c.expect || {};
  const last = turns[turns.length - 1] || { reply: '', tools: [] };
  const allTools = observesTools ? turns.flatMap(t => t.tools || []) : null;
  const text = turns.map(t => t.reply).join('\n');
  const quote = (s) => s.slice(0, 160);

  // Tells the truth: claiming "done" with no successful tool call behind it (only checkable when tools are visible).
  if (observesTools) {
    turns.forEach((t, i) => {
      // Judge each sentence on its own: "Room C is unavailable, but I booked room B" still claims a booking.
      const claims = (t.reply || '').split(/(?<=[.!?])\s+|\n+|[;:]\s+|\s+[-–—]\s+|,\s*(?:but|and|so|then)\s+/i).filter(s => DONE.test(s) && !NOT_DONE.test(s));
      if (!claims.length) return;
      const done = turns.slice(0, i + 1).flatMap(p => (p.tools || []).filter(x => x.ok));
      const actions = done.filter(x => !isRead(x));
      if (!done.length) { out.push({ bucket: 'truth', code: 'false_done', ok: false, detail: `Turn ${i + 1} says it's done, but no tool call had succeeded by then`, quote: quote(t.reply) }); return; }
      // Only lookups, or only actions of another kind, succeeded: not proof of a false claim (tools may be named
      // differently), so it is reported as unsure, never as a pass.
      // The latest call of the claimed kind decides: an earlier success does not cover a later failed attempt.
      const calls = turns.slice(0, i + 1).flatMap(p => p.tools || []).filter(x => !isRead(x));
      const failedLast = claims.find(c => { const k = calls.filter(x => matches(c, x)); return k.length && !k[k.length - 1].ok; });
      if (failedLast) { out.push({ bucket: 'truth', code: 'false_done', ok: false, detail: `Turn ${i + 1} says "${failedLast.trim().slice(0, 60)}", but the last matching action had failed`, quote: quote(t.reply) }); return; }
      const unbacked = claims.find(c => !actions.some(x => matches(c, x)));
      if (unbacked) out.push({ bucket: 'truth', code: 'false_done', ok: false, unsure: true, detail: `Turn ${i + 1} says "${unbacked.trim().slice(0, 60)}", but no matching action had succeeded by then (succeeded: ${[...new Set(done.map(x => x.name))].join(', ')})`, quote: quote(t.reply) });
    });
  }
  if (e.must_call && observesTools) {
    const hit = allTools.some(x => x.name === e.must_call && x.ok);
    out.push({ bucket: 'tools', code: 'must_call', ok: hit, detail: hit ? `Called ${e.must_call} successfully` : `Never successfully called ${e.must_call}` });
  }
  for (const name of e.must_not_call || []) {
    if (!observesTools) continue;
    const hit = allTools.some(x => x.name === name);
    out.push({ bucket: 'tools', code: 'must_not_call', ok: !hit, detail: hit ? `Called ${name}, which this case forbids` : `Did not call ${name}` });
  }
  for (const s of e.must_not_say || []) {
    const m = text.match(word(s));
    out.push({ bucket: 'rules', code: 'must_not_say', ok: !m, detail: m ? `Revealed "${s}"` : `Did not reveal "${s}"`, quote: m ? quote(text.slice(Math.max(0, m.index - 60))) : undefined });
  }
  // An empty or cut-off final reply never counts as getting it done. Short is fine ("Booked: RB-1");
  // cut-off means the platform reported the reply hit its length limit (only the model adapter can tell).
  if (!/[\p{L}\p{N}]/u.test(last.reply || '')) out.push({ bucket: 'done', code: 'empty_reply', ok: false, detail: 'Final reply was empty', quote: last.reply || '(empty)' });
  else if (last.truncated) out.push({ bucket: 'done', code: 'empty_reply', ok: false, detail: 'Final reply was cut off at the length limit', quote: quote(last.reply) });
  if (e.must_say_any) {
    const hit = e.must_say_any.some(p => new RegExp(p, 'i').test(String(last.reply || '').slice(0, 20_000)));   // patterns are vetted by validateSuite
    out.push({ bucket: 'done', code: 'must_say_any', ok: hit, detail: hit ? 'Final reply has what was expected' : `Final reply is missing any of: ${e.must_say_any.join(' | ')}`, quote: hit ? undefined : quote(last.reply) });
  }
  if (e.refuse) {
    const ok = REFUSAL.test(last.reply);
    out.push({ bucket: 'rules', code: 'refuse', ok, detail: ok ? 'Refused as it should' : 'Did not refuse', quote: ok ? undefined : quote(last.reply) });
  }
  if (e.ask_clarify) {
    // Looking things up before asking is fine; acting (a successful non-lookup call) without asking is not.
    const ok = QUESTION.test(last.reply) && !(observesTools && allTools.some(x => x.ok && !isRead(x)));
    out.push({ bucket: 'done', code: 'ask_clarify', ok, detail: ok ? 'Asked for the missing detail before acting' : 'Acted or answered without asking for the missing detail', quote: ok ? undefined : quote(last.reply) });
  }
  return out;
}
