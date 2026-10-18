// Minimal OpenRouter client. The key comes from the environment (TUNEUP_OPENROUTER_KEY) or a .env-style file
// passed with --keyfile; it is never logged.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Sanitized } from './redact.js';

export function loadKey(keyfile) {
  // A key that is only spaces or newlines is no key: never send an empty bearer token (PR #32 review).
  // A key with a line break or NUL inside cannot be a header value; refuse it here, without echoing it (PR #32 review).
  const oneLine = (k, where) => { if (/[\r\n\0]/.test(k)) throw new Error(`The OpenRouter key in ${where} has a line break inside it`); return k; };
  const env = (process.env.TUNEUP_OPENROUTER_KEY || '').trim();
  if (env) return oneLine(env, 'TUNEUP_OPENROUTER_KEY');
  if (process.env.TUNEUP_OPENROUTER_KEY !== undefined && !keyfile) throw new Error('TUNEUP_OPENROUTER_KEY is set but empty');
  if (!keyfile) throw new Error('No OpenRouter key: set TUNEUP_OPENROUTER_KEY or pass --keyfile');
  // Node's own dotenv parser: handles quotes, `export`, trailing comments and CRLF, and never runs shell syntax.
  const vars = parseEnv(readFileSync(keyfile, 'utf8').replace(/^\uFEFF/, ''))   // Windows editors may add a BOM;
  // Only credential names, in this order; settings like OPENROUTER_BASE_URL or OPENROUTER_MODEL are never used as a key.
  const PREF = ['TUNEUP_OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY', 'OPENROUTER'];
  const name = PREF.find(k => vars[k] && vars[k].trim()) || Object.keys(vars).find(k => /^[A-Z_]*OPENROUTER[A-Z_]*(KEY|TOKEN)$/i.test(k) && vars[k].trim());
  if (!name) throw new Error('No OPENROUTER line found in ' + keyfile);
  return oneLine(vars[name].trim(), keyfile);
}

export function client(key, { base = 'https://openrouter.ai/api', fetchImpl = fetch, timeoutMs = 90_000, retries = 4 } = {}) {
  let spent = 0;
  // Retries rate limits and provider hiccups (429/5xx) with back-off; other errors fail at once.
  async function post(path, body, attempt = 0) {
    const r = await fetchImpl(base + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'x-title': 'Agent Tune-Up' },
      // Never let the provider keep or train on the text (no training, zero data retention): OpenRouter fails the call (no fallback) if no provider agrees.
      body: JSON.stringify({ ...body, provider: { ...(body && body.provider), data_collection: 'deny', zdr: true } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if ((r.status === 429 || r.status >= 500) && attempt < retries) {
      await new Promise(res => setTimeout(res, (2 ** attempt) * 1500 + Math.random() * 500));
      return post(path, body, attempt + 1);
    }
    if (!r.ok) throw new Error(`OpenRouter ${path} ${r.status}: ${(j.error && j.error.message) || 'error'}`.slice(0, 300));
    spent += (j.usage && j.usage.cost) || 0;
    return j;
  }
  return {
    chat: (body) => post('/v1/chat/completions', body),
    decide: (body) => post('/alpha/decisions', body),
    spent: () => spent,
  };
}

// The agent (or the replay model standing in for it) answered, but not with anything usable: no choices, no message.
// Treated like an outage (unsure agent_error), never as a crash or a check result (PR #32 review).
export class AgentReplyError extends Error {
  constructor() { super('the agent replied with something unusable'); this.name = 'AgentReplyError'; }
}

// Raised instead of a call when the residual scan found something secret-looking, or (cap = true) when the scrubber hit
// its size, time or work cap, so the finding can name the right fix (tune-up PR #21 review). The message is what the user sees.
export class HeldBack extends Error {
  constructor(cap = false) { super(cap ? 'unsure: we held back this chat because it was too long or complex to scrub safely' : 'unsure: we held back part of this chat to protect a secret'); this.name = 'HeldBack'; this.cap = cap; }
}

// The ONE door through which judge and writer text leaves this machine (brief item 7). It accepts only a Sanitized
// made by the scrubber (a plain object with the same shape is refused, so no caller can hand over raw text by mistake),
// refuses to call at all when the residual scan held the text, and gives `build` nothing but the scrubbed string. It
// never logs, never keeps the text, and never attaches the text or the hold reasons to an error, so a stack trace or a
// crash report cannot carry a secret either.
export async function outbound(or, kind, sanitized, build) {
  if (kind !== 'chat' && kind !== 'decide') throw new TypeError('outbound: kind must be "chat" or "decide"');
  if (!Sanitized.is(sanitized)) throw new TypeError('outbound: only a Sanitized value from the scrubber may leave this machine');
  if (sanitized.held) throw new HeldBack();
  return or[kind](build(sanitized.text));
}
