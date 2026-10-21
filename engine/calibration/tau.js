// tau-bench Track A (docs/CALIBRATION-PLAN.md §3): turn sierra-research/tau-bench historical trajectories into the
// engine's Level 2 shape, and draw the pre-registered stratified sample. Pure: callers read the files.
import { createHash } from 'node:crypto';
import { transcript } from '../src/judge.js';

// File names look like "gpt-4o-retail.json" or "sonnet-35-new-airline.json".
export function sourceOf(file) {
  const m = /^(.+)-(airline|retail)\.json$/.exec(file);
  if (!m) throw new Error(`tau: unexpected file name ${file}`);
  return { model: m[1], domain: m[2] };
}

// One trajectory -> { id, group, label, instructions, case, turns }. The judge only ever sees instructions, case and
// turns; reward, reference actions and outputs stay out (the plan forbids exposing them), and so does the user
// simulator's hidden instruction text except as the test intent (it is what the user wanted).
export function adapt(file, t) {
  const { model, domain } = sourceOf(file);
  if (!t || !Array.isArray(t.traj) || !t.info || !t.info.task) throw new Error('tau: malformed trajectory');
  const msgs = t.traj;
  const sys = msgs.find(m => m.role === 'system');
  const userTurns = [], turns = [];
  let cur = null;
  const pending = new Map();
  for (const m of msgs) {
    if (m.role === 'user') { userTurns.push(String(m.content ?? '')); cur = { tools: [], replies: [] }; turns.push(cur); continue; }
    if (!cur) continue;   // anything before the first user message (the system prompt) is not a turn
    if (m.role === 'assistant') {
      if (m.content) cur.replies.push(String(m.content));
      for (const call of m.tool_calls || []) {
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { args = call.function.arguments; }
        const tool = { name: call.function.name, args, result: undefined };
        cur.tools.push(tool);
        pending.set(call.id, tool);
      }
    } else if (m.role === 'tool') {
      const tool = pending.get(m.tool_call_id);
      if (tool) tool.result = m.content;
    }
  }
  // The user simulator ends a chat with "###STOP###", a harness token no real user types. Strip it; a final stop
  // message that drew no agent reply or tool call is dropped, since there is nothing to judge in it.
  for (let i = 0; i < userTurns.length; i++) userTurns[i] = userTurns[i].replace(/\s*###STOP###\s*/g, ' ').trim();
  const last = turns.length - 1;
  if (last >= 0 && /###STOP###/.test(String(msgs.filter(m => m.role === 'user').at(-1)?.content)) && !turns[last].replies.length && !turns[last].tools.length) {
    turns.pop(); userTurns.pop();
  }
  return {
    id: `${model}-${domain}:${t.task_id}:${t.trial}`,
    group: `${domain}:${t.task_id}`,   // repeats of one task stay on one side of the dev/test split
    model, domain,
    label: t.reward === 1 ? 'pass' : 'fail',
    instructions: sys ? String(sys.content) : '',
    case: { id: `${domain}:${t.task_id}`, intent: String(t.info.task.instruction), turns: userTurns },
    turns: turns.map(x => ({ tools: x.tools, reply: x.replies.join('\n') })),
  };
}

// The exact text the judge would receive (before scrubbing), via the engine's own Level 2 transcript.
export const judgeText = (a) => transcript(a.case, a.instructions, a.turns, true);

// Deterministic PRNG (mulberry32) and Fisher-Yates shuffle: the same seed always gives the same sample.
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffle(xs, rand) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Grouped split, then a balanced draw per stratum (model x domain x label).
 * @param {{id,group,model,domain,label}[]} items
 * @param {{seed:number, devGroupShare?:number, perStratum:{dev:number,test:number}}} opts
 */
export function sample(items, { seed, devGroupShare = 0.2, perStratum }) {
  const ids = new Set();
  for (const it of items) { if (ids.has(it.id)) throw new Error(`tau: duplicate id ${it.id}`); ids.add(it.id); }
  const rand = rng(seed);
  const groups = [...new Set(items.map(i => i.group))].sort();
  const shuffled = shuffle(groups, rand);
  const devGroups = new Set(shuffled.slice(0, Math.round(shuffled.length * devGroupShare)));
  const out = { dev: [], test: [] };
  const strata = new Map(), byId = new Map(items.map(i => [i.id, i]));
  for (const it of [...byId.keys()].sort().map(k => byId.get(k))) {
    const side = devGroups.has(it.group) ? 'dev' : 'test';
    const key = `${side}|${it.model}|${it.domain}|${it.label}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(it);
  }
  for (const key of [...strata.keys()].sort()) {
    const side = key.split('|')[0];
    const want = perStratum[side];
    const pool = strata.get(key);
    if (pool.length < want) throw new Error(`tau: stratum ${key} has ${pool.length} items, needs ${want}`);
    out[side].push(...shuffle(pool, rand).slice(0, want).map(i => i.id));
  }
  out.dev.sort(); out.test.sort();
  return { ...out, devGroups: [...devGroups].sort(), hash: hashIds(out) };
}

export const hashIds = ({ dev, test }) => createHash('sha256').update(JSON.stringify({ dev, test })).digest('hex');
