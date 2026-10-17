// Loaded with --import into a CLI child process by the package and golden tests: replaces fetch so no test ever reaches
// the network, and records every attempted call. Settings come from TU_TEST_* variables (not TUNEUP_*, which the CLI
// reads and rejects when unknown):
//   TU_TEST_NETLOG   file that gets one line per attempted call
//   TU_TEST_FETCH    JSON: { "throw": true }               every call throws like a dropped connection
//                          { "echoKey": true }             every call is a 401 whose body repeats the bearer token
//                          { "answers": { q: p, ... },     the judge answers each question with probability p
//                            "agentFailOn": "text" }       an agent request whose body contains "text" gets HTTP 503
//                          "decideThrow": true          every judge call throws like a dropped connection
//                          "writer": { ... }            the fix writer (chat completions) replies with this JSON
import { appendFileSync } from 'node:fs';
const cfg = JSON.parse(process.env.TU_TEST_FETCH || '{"throw":true}');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  if (process.env.TU_TEST_NETLOG) appendFileSync(process.env.TU_TEST_NETLOG, String(url) + '\n');
  if (cfg.throw) throw new TypeError('fetch failed');
  const auth = new Headers(init.headers || {}).get('authorization') || '';
  if (cfg.echoKey) return json({ error: { message: 'bad key ' + auth } }, 401);
  const u = String(url), body = String(init.body || '');
  if (u.endsWith('/alpha/decisions') && cfg.decideThrow) throw new TypeError('fetch failed');
  if (u.endsWith('/v1/chat/completions') && cfg.writer) return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(cfg.writer) } }] });
  if (u.endsWith('/alpha/decisions')) {
    const qs = Object.keys(JSON.parse(body).questions);
    return json({ answers: Object.fromEntries(qs.map(k => [k, { noul: cfg.answers[k] ?? 0.5 }])) });
  }
  if (u.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { role: 'assistant', content: 'We open at 9am.' } }] });
  if (cfg.agentFailOn && body.includes(cfg.agentFailOn)) return json({}, 503);
  return json({ reply: 'We open at 9am.' });
};
