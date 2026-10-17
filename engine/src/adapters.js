import { scrubber, ScrubError } from './redact.js';
import { HeldBack, AgentReplyError } from './openrouter.js';
// Adapters turn "send this user message to the agent" into whatever the agent's platform needs.
// Every adapter returns { reply, tools, tokens, ms } for one user turn. `tools` lists tool calls the agent made
// (name, args, ok, result) when the platform exposes them; `null` means "not observable here".

// 1) http: any chatbot with an HTTP endpoint. Config:
//    { "type": "http", "url": "...", "headers": {...}, "body": {...with "{{message}}" / "{{history}}"...}, "reply_path": "a.b.0.c" }
// Header values may use ${TUNEUP_AGENT_*} environment variables and nothing else: a suite file can point `url` anywhere,
// so letting it name any variable (e.g. ${TUNEUP_OPENROUTER_KEY}) would let a shared suite send your secrets to its host.
export const AGENT_ENV = /^TUNEUP_AGENT_[A-Z0-9_]+$/;
export function headerVars(cfg) {
  return [...new Set(Object.values(cfg.headers || {}).flatMap(v => [...String(v).matchAll(/\$\{(\w+)\}/g)].map(m => m[1])))];
}

// `privateTerms` (the --private list) never go anywhere, including your own agent: a test message that contains one
// is refused before it is sent. Built-in patterns (emails, keys…) do reach your own agent, because that is what is tested.
export function httpAdapter(cfg, { fetchImpl = fetch, privateTerms = [] } = {}) {
  const bad = headerVars(cfg).filter(n => !AGENT_ENV.test(n));
  if (bad.length) throw new Error(`agent_config.headers may only use \${TUNEUP_AGENT_*} variables; refusing ${bad.map(n => '${' + n + '}').join(', ')}`);
  // Even an allowed credential only goes to the agent address the user set in their own environment (TUNEUP_AGENT_URL),
  // never to whatever host a suite file names.
  if (headerVars(cfg).length) {
    const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
    const mine = origin(process.env.TUNEUP_AGENT_URL || '');
    if (!mine || origin(cfg.url) !== mine) throw new Error(`agent_config.headers use your environment variables, so the suite's url must be on the address in TUNEUP_AGENT_URL (now ${mine || 'not set'}); refusing to send them to ${origin(cfg.url) || cfg.url}`);
  }
  const fill = (v, vars) => typeof v === 'string'
    ? (v === '{{history}}' ? vars.history : v.replaceAll('{{message}}', vars.message).replaceAll('{{instructions}}', vars.instructions ?? ''))
    : Array.isArray(v) ? v.map(x => fill(x, vars))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]))
    : v;
  const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
  const headers = Object.fromEntries(Object.entries(cfg.headers || {}).map(([k, v]) => [k, String(v).replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] || '')]));
  // A value that is not one line after expansion (a pasted multi-line token) is refused here, naming only the header:
  // fetch would reject it later with the value itself in the error (PR #32 review).
  for (const [k, v] of Object.entries(headers)) if (/[\r\n\0]/.test(v)) throw new Error(`agent_config.headers.${k} is not a single line after filling in its \${TUNEUP_AGENT_*} variables; check that variable`);
  // mentionsTerm also catches a term inside a value another rule replaced first (employee@acme.example), PR #16 review.
  const hasPrivate = (text) => { const s = scrubber({ terms: privateTerms }); s.scrub(text); return (s.counts().PRIVATE || 0) > 0 || s.mentionsTerm(text); };
  return {
    name: 'http', observesTools: false,
    // Tuning needs a way to hand the agent new instructions; without {{instructions}} in the body there is none.
    acceptsInstructions: JSON.stringify(cfg.body || {}).includes('{{instructions}}'),
    async turn({ history, message, instructions }) {
      const t = Date.now();
      const body = JSON.stringify(fill(cfg.body || { message: '{{message}}' }, { message, history, instructions }));
      if (privateTerms.length && hasPrivate(body)) throw new Error('A word from your --private list is in a test message or the instructions; it was not sent to the agent. Remove it from the suite.');
      // redirect: 'error' so headers and the test message never follow a redirect to another host.
      const r = await fetchImpl(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, redirect: 'error', signal: AbortSignal.timeout(cfg.timeout_ms || 60_000) });
      const j = await r.json().catch(() => undefined);
      if (!r.ok) throw new Error(`agent endpoint ${r.status}`);
      // A 200 that is not JSON, or has no text at the reply path, is no answer at all: an unsure agent_error like an
      // outage, never a confident "empty reply" failure (PR #32 review). An empty string at the path is a real empty reply.
      const reply = j === undefined ? undefined : pick(j, cfg.reply_path || 'reply');
      if (typeof reply !== 'string' && typeof reply !== 'number') throw new AgentReplyError();
      return { reply: String(reply), tools: null, tokens: null, ms: Date.now() - t };
    },
  };
}

// 2) model: an agent defined by instructions + tools, run on an OpenRouter model with simulated tools.
//    Used for Tune-Up's own demo agents and for "replay" of an agent's instructions. Tools are simulated by
//    the suite's `tools` map: { name: { description, parameters, cases: [{ when: {arg: value}, result }], default } }.
// Everything sent to the replay model is scrubbed with `scrub`; its replies and tool arguments are restored locally.
// Simulator argument match: scalars case-insensitively, objects and arrays structurally (key order ignored).
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const same = (a, v) => (a !== null && typeof a === 'object') || (v !== null && typeof v === 'object')
  ? JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(v)) : String(a ?? '').toLowerCase() === String(v).toLowerCase();

// Tool names, property names, schema definition names ($defs, definitions and the other schema-keyed maps) and
// `required` lists are sent to the replay model unscrubbed (it must echo them back exactly
// for dispatch), so a never-send word inside one of them cannot be hidden without breaking the tool. The only safe
// answer is to refuse the run before anything is sent (viaknox #25 review).
// Schema maps whose KEYS are identifiers the model echoes: property names, $defs/definitions names, pattern keys and
// dependency keys. Each key is checked and each value walked; a list value there names properties, like `required`.
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas', 'dependentRequired', 'dependencies']);
function namesWithPrivate(cfg, privateTerms) {
  if (!privateTerms.length) return [];
  // Names are split at camelCase and separators first, so "acmeId" and "ACME_LOOKUP" count as containing "Acme".
  // The terms are split the same way, and the raw name is checked too, so a compound term (AcmeCorp, Acme-Corp) still
  // matches AcmeCorpLookup or Acme-Corp_lookup (PR #16 review).
  const split = (x) => String(x).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
  const terms = [...new Set([...privateTerms, ...privateTerms.map(split)])];
  const flat = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const has = (text) => { const s = scrubber({ terms }); const t = split(text); s.scrub(t); if ((s.counts().PRIVATE || 0) > 0 || s.mentionsTerm(t) || s.mentionsTerm(String(text))) return true;
    // The flattened name holds the flattened term (acmecorp inside acmecorplookup), whatever the term's capitalisation
    // (PR #16 review). Terms of four or more letters only, so a short name like "Ivo" does not block "ivory_lookup".
    return privateTerms.some(pt => { const f = flat(pt); return f.length >= 4 && flat(text).includes(f); }); };
  const hits = [];
  const walk = (v, where) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
    for (const [k, x] of Object.entries(v)) {
      if (SCHEMA_MAPS.has(k) && x && typeof x === 'object' && !Array.isArray(x)) {
        for (const [pk, pv] of Object.entries(x)) {
          if (has(pk)) hits.push(`${where}.${k}.${pk}`);
          if (Array.isArray(pv)) { for (const r of pv) if (typeof r === 'string' && has(r)) hits.push(`${where}.${k}.${pk}:${r}`); } else walk(pv, `${where}.${k}.${pk}`);
        }
        continue;
      }
      if (k === 'required' && Array.isArray(x)) { for (const r of x) if (has(String(r))) hits.push(`${where}.required:${r}`); continue; }
      walk(x, `${where}.${k}`);
    }
  };
  for (const [name, d] of Object.entries(cfg.tools || {})) { if (has(name)) hits.push(`tool ${name}`); walk(d && d.parameters, `tool ${name}.parameters`); }
  // The model id is sent verbatim too (it cannot be scrubbed without making the request invalid; PR #16 review).
  if (typeof cfg.model === 'string' && has(cfg.model)) hits.push('model id');
  return hits;
}

export function modelAdapter(cfg, or, { scrub, privateTerms = [] } = {}) {
  // Every piece sent to the replay model goes through sanitize(): its residual scan holds the run back (no call) when a
  // secret survived scrubbing, exactly as the judge's outbound boundary does (PR #16 review).
  const S = (t) => { if (!scrub) return t; let z; try { z = scrub.sanitize(t); } catch (e) { if (e instanceof ScrubError) throw new HeldBack(e.cap === true); throw e; } if (z.held) throw new HeldBack(); return z.text; };
  const U = (t) => (scrub ? scrub.unscrub(t) : t);
  const clash = namesWithPrivate(cfg, privateTerms);
  if (clash.length) throw new Error(`A word from your --private list is in the model id, a tool name, a parameter name or a required list (${clash.length} place${clash.length > 1 ? 's' : ''}); it cannot be scrubbed without breaking the tool, so nothing was sent. Rename it or remove the word from the list.`);   // also $defs/definitions names (PR #16 review)
  // Tool definitions are sent too, so every string in them is scrubbed (descriptions, enums, examples) except
  // tool and property names and `required` lists, which the model must echo back exactly for dispatch.
  const scrubSchema = (v, key) => typeof v === 'string' ? S(v)
    : Array.isArray(v) ? (key === 'required' ? v : v.map(x => scrubSchema(x)))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'properties' && x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).map(([pk, pv]) => [pk, scrubSchema(pv, pk)])) : scrubSchema(x, k)]))
    : v;
  const toolDefs = () => Object.entries(cfg.tools || {}).map(([name, d]) => ({ type: 'function', function: { name, description: S(d.description ?? ''), parameters: scrubSchema(d.parameters) } }));
  const simulate = (name, args) => {
    const d = (cfg.tools || {})[name];
    if (!d) return { ok: false, result: { error: 'unknown tool' } };
    const hit = (d.cases || []).find(c => Object.entries(c.when || {}).every(([k, v]) => same(args[k], v)));
    // No matching case and no default means the simulator has nothing to return: that is a failed call, not a success.
    // A defined result of false, 0, '' or null is still a real result.
    if (hit ? !('result' in hit) : !('default' in d)) return { ok: false, result: { error: 'no simulated result for these arguments' } };
    const result = hit ? hit.result : d.default;
    return { ok: !(result && result.error), result };
  };
  return {
    name: 'model:' + cfg.model, observesTools: true,
    async turn({ history, message, instructions }) {
      const t = Date.now(); const tools = []; let tokens = 0; const defs = toolDefs();
      // `messages` is this turn's full exchange (tool calls, tool results, reply) kept locally with real values, so the
      // next turn's history has the same context a live tool-using conversation would. Tool-call arguments stay in the
      // placeholder form the model wrote; the shared scrubber maps them consistently.
      const messages = [];
      const msgs = [{ role: 'system', content: S(instructions) }, ...history.map(h => ({ ...h, content: S(h.content) })), { role: 'user', content: S(message) }];
      for (let hop = 0; hop < 4; hop++) {
        const r = await or.chat({ model: cfg.model, messages: msgs, tools: defs.length ? defs : undefined, max_tokens: cfg.max_tokens || 2000, temperature: cfg.temperature ?? 0.7 });
        tokens += (r.usage && r.usage.total_tokens) || 0;
        const m = r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message;
        if (!m || typeof m !== 'object') throw new AgentReplyError();
        // Content must be text (or absent when tools are called) and tool calls well formed; anything else is no usable
        // answer, never "[object Object]" judged as a reply (PR #32 review).
        if (m.content != null && typeof m.content !== 'string') throw new AgentReplyError();
        if (m.tool_calls != null && (!Array.isArray(m.tool_calls) || !m.tool_calls.every(c => c && typeof c === 'object' && c.function && typeof c.function === 'object'
          && typeof c.function.name === 'string' && (c.function.arguments == null || typeof c.function.arguments === 'string')))) throw new AgentReplyError();
        if (!m.tool_calls || !m.tool_calls.length) {
          const reply = U(m.content || '').trim();
          messages.push({ role: 'assistant', content: reply });
          return { reply, tools, tokens, ms: Date.now() - t, truncated: r.choices[0].finish_reason === 'length', messages };
        }
        msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
        messages.push({ role: 'assistant', content: U(m.content || ''), tool_calls: m.tool_calls });
        for (const c of m.tool_calls) {
          let args = {}, s;
          try { args = JSON.parse(U(c.function.arguments || '{}')); s = simulate(c.function.name, args); }
          catch { s = { ok: false, result: { error: 'invalid tool arguments (not JSON)' } }; }
          tools.push({ name: c.function.name, args, ok: s.ok, result: s.result, readOnly: !!(cfg.tools || {})[c.function.name]?.read_only });
          msgs.push({ role: 'tool', tool_call_id: c.id, content: S(JSON.stringify(s.result)) });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(s.result) });
        }
      }
      messages.push({ role: 'assistant', content: '' });
      return { reply: '', tools, tokens, ms: Date.now() - t, note: 'stopped after 4 tool rounds', messages };
    },
  };
}
