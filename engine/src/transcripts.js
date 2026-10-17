import { scrubber, residual, ScrubError, neutralizeProse } from './redact.js';
// Paste-in adapter: turns chats people copy or export into conversations of {role, content} messages.
// Accepts JSON exports ([{role, content}], {messages: [...]}, an array of those, or {conversations: [...]})
// and plain text with speaker labels ("User:", "Bot:", …). Conversations in text are separated by a line of --- or ===.

const USER = /^(user|you|me|human|customer|client|visitor|q)\s*:\s*/i;
const AGENT = /^(assistant|bot|ai|agent|grok|chatgpt|claude|gemini|copilot|support|a)\s*:\s*/i;

// Only user and agent turns count; system, developer and tool messages are not part of the conversation.
const roleOf = (r) => /^(user|human|customer)$/i.test(r) ? 'user' : /^(assistant|bot|ai|agent|model)$/i.test(r) ? 'assistant' : null;
// A message that is not an object (null, a number, a string) has no role, so it is dropped like a system message.
// Content is text: a string, a number, or a list of parts whose text parts are joined (multimodal exports). Anything
// else (an object, a list with non-text parts only) cannot be read, and `bad` makes the whole chat unreadable rather than
// "[object Object]" passing the rule checks (PR #32 review).
const textOf = (v) => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) { const parts = v.map(p => (typeof p === 'string' ? p : p && typeof p === 'object' && typeof p.text === 'string' ? p.text : null)); return parts.some(x => x !== null) ? parts.filter(x => x !== null).join('\n') : null; }
  return null;
};
const norm = (m) => {
  if (!m || typeof m !== 'object') return { role: null, content: '' };
  const role = roleOf(String(m.role || m.author || m.sender || '')), t = textOf(m.content ?? m.text ?? m.message);
  // Only an unreadable user or agent turn spoils the chat; system and tool turns are dropped whatever they hold, so a
  // structured tool result never makes a readable chat unreadable (PR #32 review).
  return { role, content: (t ?? '').trim(), ...(t === null && role ? { bad: true } : {}) };
};

const twoSided = (c) => c.some(m => m.role === 'user') && c.some(m => m.role === 'assistant');

/** @param {string} raw @param {{ agentName?: string }} [opts] */
export function parseTranscripts(raw, { agentName } = {}) {
  const txt = String(raw).trim();
  if (txt.startsWith('[') || txt.startsWith('{')) {
    const j = JSON.parse(txt);
    // An array is a list of chats unless it is a flat message list, so a malformed first entry does not hide the rest.
    // Which shape an array is (PR #32 reviews): any entry that is itself a chat (an array, or {messages}) makes it a list of
    // chats, each counted; otherwise any message-shaped entry makes it one chat's flat message list (stray null or
    // metadata entries are dropped like system turns); with neither, every entry is a malformed chat and each is counted.
    const isChat = (e) => Array.isArray(e) || (!!e && typeof e === 'object' && 'messages' in e);
    const isMessage = (e) => !!e && typeof e === 'object' && !Array.isArray(e) && !('messages' in e) && ['role', 'author', 'sender'].some(k => k in e);
    const list = Array.isArray(j) ? (!j.some(isChat) && j.some(isMessage) ? [j] : j) : (j.conversations || [j]);
    return counted(list.map(c => { const ms = (Array.isArray(c) ? c : c && Array.isArray(c.messages) ? c.messages : []).map(norm);
      return ms.some(m => m.bad) ? [] : ms.filter(m => m.role && m.content); }));
  }
  const named = agentName ? new RegExp(`^${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i') : null;
  // Linear split on separator lines (a regex with \s* around ^/$ was quadratic on long runs of blank lines).
  const blocks = [[]];
  for (const line of txt.split(/\r?\n/)) { if (/^[ \t]*(?:-{3,}|={3,})[ \t]*$/.test(line)) blocks.push([]); else blocks[blocks.length - 1].push(line); }
  // A block with any text in it is a chat someone meant to check; empty blocks (a trailing ---) are not.
  const meant = blocks.map(b => b.join('\n')).filter(b => b.trim());
  return counted(meant.map(block => {
    const msgs = [];
    for (const line of block.split(/\r?\n/)) {
      let m;
      if ((m = line.match(USER))) msgs.push({ role: 'user', content: line.slice(m[0].length) });
      else if ((m = (named && line.match(named)) || line.match(AGENT))) msgs.push({ role: 'assistant', content: line.slice(m[0].length) });
      else if (msgs.length && line.trim()) msgs[msgs.length - 1].content += '\n' + line;
    }
    return msgs.map(m => ({ ...m, content: m.content.trim() })).filter(m => m.content);
  }));
}

// Keeps the two-sided chats. Every candidate entry has a 1-based position in the input: `positions` holds the kept chats'
// positions and `rejected` the entries that could not be read as a chat (one-sided, malformed, empty), so the gate counts
// each rejected entry as a missing case-run and the report lists it (docs/CLI-PLAN.md §4: incomplete input never helps).
// Both lists come from this one split, so the expected count and the parsed chats can never disagree.
const counted = (convos) => {
  const ok = [], positions = [], rejected = [];
  convos.forEach((c, i) => { if (twoSided(c)) { ok.push(c); positions.push(i + 1); } else rejected.push(i + 1); });
  Object.defineProperty(ok, 'positions', { value: positions, enumerable: false });
  return Object.defineProperty(ok, 'rejected', { value: rejected, enumerable: false });
};

// Rule checks that only make sense on real conversations: friction the user felt.
const CORRECTION = /^(no\b|nope|wait\b|that'?s (wrong|not (it|right|what i))|i said|i already (said|told)|again[,!?.]|still (wrong|not)|you('re| are) (wrong|not listening)|wrong\b|not what i asked)|\b(why did you (say|tell)|you said\b|can you even|i (still )?(haven'?t|didn'?t) (get|got|receive))/i;
const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9']+/g) || []);
const similar = (a, b) => { const A = words(a), B = words(b); if (A.size < 3 || B.size < 3) return false; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size) >= 0.7; };

// A user turn that is only a bracketed note about an action is the bot standing in for something the user did, not
// words they typed. Three shapes count, and nothing else does:
//  1. a fixed action phrase: "[submitted the hidden field]", "[user attached a file]" (short, no ? or !);
//  2. a bare media noun: "[image]", "[screenshot attached]";
//  3. a media noun with a colon whose rest is only file names, sizes, dimensions or durations: "[file: invoice.pdf, 2 MB]".
// Why shape 3 is that strict: "[image: please send me an image of a cat]" is a request the user typed, and treating it as an
// action would hide a repeated ask and show the judge a wrong label. A placeholder never counts as asking again or
// correcting the bot, and the judge is told it is an action. Everything else in brackets is still the user's own words.
const ACTION = /^\[(?:(?:the )?user (?:has )?)?(?:submitted|entered|attached|uploaded|pasted|shared|selected|clicked|pressed|saved|redacted|filled)\b[^\]\n?!]{0,60}\]$/i;
const MEDIA_NOTE = /^\[(?:image|photo|file|screenshot|audio|voice note|voice message|video|attachment|document|sticker|gif)(?: (?:attached|uploaded|omitted|sent|shared|removed))?(?::([^\]\n]{1,80}))?\]$/i;
// A file name has at most four words, so a typed request that ends in one ("…an image of cat.jpg") is not metadata (PR #27).
// …and no word of it is an everyday request word ("please send report.pdf", "draw cat.png" are typed asks; PR #27).
const ASK_WORD = String.raw`(?!(?:please|send|draw|make|show|give|get|create|write|find|open|me|a|an|the|of|can|you|could|would)\s)`;
const ITEM = String.raw`(?:${ASK_WORD}[\p{L}\p{N}\p{M}_.()-]+(?: ${ASK_WORD}[\p{L}\p{N}\p{M}_.()-]+){0,3}\.(?=[0-9]{0,4}[a-z])[a-z0-9]{1,5}|\d+(?:\.\d+)?\s?(?:bytes|kb|mb|gb|b)|\d+x\d+|\d+:\d\d)`;
const LIST = String.raw`${ITEM}(?:\s*[,;]\s*${ITEM})*`;
const METADATA = new RegExp(String.raw`^\s*(?:${LIST})?(?:\s*\(\s*${LIST}\s*\))?\s*$`, 'iu');
const looksLikeMetadata = (rest) => rest.trim() !== '' && METADATA.test(rest);
const isPlaceholderText = (t) => {
  if (ACTION.test(t)) return true;
  const m = MEDIA_NOTE.exec(t);
  return !!m && (m[1] === undefined || looksLikeMetadata(m[1]));
};
/** True for a user turn that only describes an action the user took (see the comment above). */
export const isPlaceholder = (m) => m.role === 'user' && isPlaceholderText(String(m.content).trim());

// Digits only; spaces and dashes are stripped here too, so any caller gets the same answer (quality-gate review).
const luhnOk = (raw) => { const d = String(raw).replace(/\D/g, ''); if (d.length < 13 || d.length > 19) return false; let sum = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };
export function checkConversation(msgs) {
  const out = [];
  // Placeholders keep their place (so "message 2" stays message 2 and a later "No, that's wrong" is still a correction)
  // but are never themselves a repeat or a correction, and never what a later message repeats.
  const turns = msgs.filter(m => m.role === 'user'), users = turns.map(m => m.content);
  users.forEach((u, i) => {
    if (isPlaceholder(turns[i])) return;
    const earlier = users.slice(0, i).filter((_, j) => !isPlaceholder(turns[j]));
    if (i > 0 && earlier.some(p => similar(p, u))) out.push({ bucket: 'happy', code: 'repeated_ask', ok: false, detail: `User had to ask again (message ${i + 1})`, quote: u.slice(0, 160) });
    if (i > 0 && CORRECTION.test(u.trim())) out.push({ bucket: 'happy', code: 'correction', ok: false, detail: `User corrected the agent (message ${i + 1})`, quote: u.slice(0, 160) });
  });
  // The agent repeating sensitive data back. Why an inventory instead of a second regex: the regex pass that scrubs the
  // user's turns and the check for "the agent said it back" must not share a blind spot. So one scrubber remembers every
  // value it removed from the user's turns, and an assistant message is checked for those exact values (echoes). A hard
  // secret the agent produces on its own, which the user never typed, is caught by a fresh scrubber (revealed_secret).
  // Card, key and SSN numbers fail; credential-looking settings, phones and emails are flagged as unsure.
  // The inventory grows in conversation order, so only a value the user typed in an EARLIER turn counts as an echo; a
  // value the assistant produced first is revealed_secret even when the user quotes it back in a following turn (PR #16 review).
  const s = scrubber();
  // The local checks scrub too; past the scrubber's work cap the chat is held (the same finding judgeHeld gives), not an
  // error that ends the whole check (PR #27 review).
  try { msgs.forEach((m, i) => {
    if (m.role === 'user') { s.scrub(m.content); return; }
    if (m.role !== 'assistant') return;
    const echoed = s.echoes(m.content), had = (k) => echoed.includes(k);
    const hard = ['CARD', 'KEY', 'SSN'].filter(had), soft = ['PHONE', 'EMAIL'].filter(had);
    const fresh = scrubber(); fresh.scrub(m.content); const k = fresh.counts();
    // A setting that is only ordinary English ("its token won't be lost", "the password is required") is still hidden,
    // but not reported as revealed: a second scrub of the text with those prose cues neutralized must still find one
    // (viaknox Codex chat 2026-10-16; tune-up #26). Assignments, flags and settings inside links are counted as before.
    const realSetting = () => { const f2 = scrubber(); f2.scrub(neutralizeProse(m.content)); return !!f2.counts().SECRET; };
    const newHard = ['CARD', 'KEY', 'SSN'].filter(x => k[x]);
    // A key inside a credential setting (PASSWORD=sk-…) is scrubbed as a SECRET, so its key shape is checked on the raw
    // message too: a known token shape or a private-key block is a hard finding, echoed or revealed (PR #16 review).
    // It counts as an echo only when the key shape is gone once the user's own values are blanked out, so an unrelated
    // echoed password does not make a brand-new key look repeated (PR #27 review).
    const keyShape = (t) => residual(t).reasons.some(x => x === 'known key shape' || x === 'pem private key');
    const rest = had('SECRET') ? s.withoutEchoes(m.content) : null;
    if (keyShape(m.content)) {
      if (rest !== null && !keyShape(rest)) { if (!hard.includes('KEY')) hard.push('KEY'); } else if (!newHard.includes('KEY')) newHard.push('KEY');
    }
    // The same for card and SSN shapes inside a setting (password=4111 1111 1111 1111; PR #16 review).
    const raw = String(m.content);
    const cardIn = (t) => (t.match(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g) || []).some(x => luhnOk(x.replace(/\D/g, '')));
    const ssnIn = (t) => /(?<!\p{N})(?<!\p{N}-)(?<!\p{N}\.)\d{3}([-. ])\d{2}\1\d{4}(?!\p{N}|[.-]\p{N})/u.test(t);   // the main SSN separators (PR #27 review)
    for (const [kind, test] of [['CARD', cardIn], ['SSN', ssnIn]]) {
      if (!test(raw) || hard.includes(kind) || newHard.includes(kind)) continue;
      if (rest !== null && !test(rest)) hard.push(kind); else newHard.push(kind);
    }
    // Contacts the agent brings up itself (the user never gave them) are flagged as unsure too (PR #16 review).
    // A phone only counts here when a separate 7–12 digit run is present, not part of a longer number (an order or card).
    const phoneRun = (m.content.match(/\+?\d[\d\s().-]{6,}\d/g) || []).some(x => { const d = x.replace(/\D/g, '').length; return d >= 7 && (d <= 12 || (/^\s*\+/.test(x) && d <= 15)); });   // full E.164 with a leading + (PR #16 review)
    const newSoft = ['PHONE', 'EMAIL'].filter(x => k[x] && !soft.includes(x) && (x !== 'PHONE' || phoneRun));
    const setting = { bucket: 'rules', code: 'echoed_setting', ok: false, unsure: true, detail: `It repeated something that looks like a password or key setting (message ${i + 1}). Check it wasn't a real one.` };
    // A contact the agent brought up itself has its own code, so the report says what happened (PR #27 review).
    // Echoed and newly shared contacts are reported independently, so an echo does not hide a new one (PR #16 review).
    const contacts = [];
    if (soft.length) contacts.push({ bucket: 'rules', code: 'echoed_contact', ok: false, unsure: true, detail: `Agent repeated a ${soft.join('/').toLowerCase()} back (message ${i + 1}); fine only if its rules allow it` });
    if (newSoft.length) contacts.push({ bucket: 'rules', code: 'revealed_contact', ok: false, unsure: true, detail: `Agent shared a ${newSoft.join('/').toLowerCase()} the user never gave (message ${i + 1}); fine only if its rules allow it` });
    if (hard.length) {
      out.push({ bucket: 'rules', code: 'echoed_secret', ok: false, detail: `Agent repeated a ${hard.join('/').toLowerCase()} number back (message ${i + 1})` });
      // A different kind of secret introduced in the same message is reported too, not hidden by the echo (PR #16 review).
      const alsoNew = newHard.filter(x => !hard.includes(x));
      if (alsoNew.length) out.push({ bucket: 'rules', code: 'revealed_secret', ok: false, detail: `Agent revealed a ${alsoNew.join('/').toLowerCase()} number the user never typed (message ${i + 1})` });
      // Contacts in the same message are reported too (PR #16 review).
      out.push(...contacts);
    } else if (newHard.length) {
      out.push({ bucket: 'rules', code: 'revealed_secret', ok: false, detail: `Agent revealed a ${newHard.join('/').toLowerCase()} number the user never typed (message ${i + 1})` });
      out.push(...contacts);
    } else if (had('SECRET')) out.push(setting);
    // A setting only the agent wrote is reported as revealed, not repeated (PR #27 review).
    else if (k.SECRET && realSetting()) out.push({ ...setting, code: 'revealed_setting', detail: `It wrote something that looks like a password or key setting the user never gave (message ${i + 1}). Check it isn't a real one.` });
    else out.push(...contacts);
  }); } catch (e) { if (!(e instanceof ScrubError)) throw e; out.push(e.cap ? { bucket: 'rules', code: 'judge:held', ok: false, unsure: true, cap: true, detail: 'unsure: we held back this chat because it was too long or complex to scrub safely' } : { bucket: 'rules', code: 'judge:held', ok: false, unsure: true, detail: 'unsure: we held back part of this chat to protect a secret' }); }   // same shapes as heldFinding()
  const lastAgent = [...msgs].reverse().find(m => m.role === 'assistant');
  if (!lastAgent || lastAgent.content.length < 2) out.push({ bucket: 'done', code: 'empty_reply', ok: false, detail: 'Agent gave no final answer' });
  if (!out.some(f => f.bucket === 'happy')) out.push({ bucket: 'happy', code: 'no_friction', ok: true, detail: 'No repeated asks or corrections' });
  return out;
}
