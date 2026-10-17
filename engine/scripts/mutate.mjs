#!/usr/bin/env node
// Mutation check for the scrubber (docs/SCRUBBER-V2-BRIEF.md, "Assurance"): flips one regex or branch in
// src/redact.js at a time and confirms that at least one test fails. A mutant the tests do not notice (a survivor) is
// a hole in the test suite, or dead code.
//
// Usage: node scripts/mutate.mjs [--out report.md] [--timeout 60000] [--only N]
//   --out      also write the markdown report to this file
//   --timeout  milliseconds each mutant's test run may take before it counts as "killed by timeout" (default 60000)
//   --only N   run N mutants spread evenly over the whole list instead of all of them (a quick check)
//
// Operators (one mutation per mutant, in this order of the report):
//   regex   every regex literal replaced by one that never matches (/(?!)/ with the same flags)
//   and-or  && <-> ||
//   cmp     < -> <=, <= -> <, > -> >=, >= -> >
//   eq      === <-> !==
//   int     every decimal integer literal >= 2 gets +1
//   bool    true <-> false
//   ret     `return <boolean-looking expression>;` becomes `return !(<expression>);`
// Not covered: regexes built at run time with new RegExp(...), and loose ==/!=.
//
// Exit code is 0 (a report, not a gate) unless --fail-on-survivors is given; then any survivor exits 1.
//   --target F  mutate file F instead of src/redact.js     --tests a,b  run only these test files
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
let TARGET = join('src', 'redact.js');   // --target picks another file (the CI gate uses src/gate.js)

// Reads the three command-line options, so the rest of the script never touches process.argv.
function parseArgs(argv) {
  const opt = { out: null, timeout: 60000, only: 0, target: null, tests: null, failOnSurvivors: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opt.out = argv[++i];
    else if (a === '--timeout') opt.timeout = Number(argv[++i]);
    else if (a === '--only') opt.only = Number(argv[++i]);
    else if (a === '--target') opt.target = argv[++i];
    else if (a === '--tests') opt.tests = argv[++i].split(',');
    else if (a === '--fail-on-survivors') opt.failOnSurvivors = true;
    else throw new Error('unknown option ' + a);
  }
  if (!(opt.timeout > 0) || !(opt.only >= 0)) throw new Error('--timeout and --only must be positive numbers');
  return opt;
}

// Splits JavaScript source into comments, strings, regex literals, numbers, names and punctuation. A tolerant scan,
// not a parser: a "/" starts a regex only where an expression can start (after ( , = [ : ? || && ! return and so on),
// and anything inside a string, template text or comment is never offered to a mutation operator.
function lex(src) {
  const toks = []; const n = src.length; let i = 0;
  const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'delete', 'void', 'throw', 'new', 'in', 'of', 'yield', 'await', 'else', 'do']);
  const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
  const NUM = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)n?/;
  const ID = /^[A-Za-z_$#\u0080-\uffff][\w$\u0080-\uffff]*/;
  const push = (t, s, e) => { toks.push({ t, s, e, x: src.slice(s, e) }); };
  const lastSig = () => { for (let k = toks.length - 1; k >= 0; k--) if (toks[k].t !== 'com') return toks[k]; return null; };
  // True when a "/" here would start a regex rather than divide.
  const regexAllowed = () => {
    const p = lastSig(); if (!p) return true;
    if (p.t === 'id') return KEYWORDS_BEFORE_REGEX.has(p.x);
    if (p.t === 'p') return !(p.x === ')' || p.x === ']');
    return false;   // number, string, regex, template end: divide
  };
  // Scans code until the end of input, or until the "}" that closes a template ${ ... } (when `inTemplate`).
  function code(inTemplate) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; push('com', i, end); i = end; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; push('com', i, end); i = end; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
        push('str', i, j + 1); i = j + 1; continue;
      }
      if (c === '`') { template(); continue; }
      if (c === '/' && regexAllowed()) {
        let j = i + 1, cls = false, ok = false;
        for (; j < n && src[j] !== '\n'; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) { ok = true; break; }
        }
        if (ok) { j++; while (j < n && /[a-z]/.test(src[j])) j++; push('re', i, j); i = j; continue; }
      }
      const rest = src.slice(i, i + 40);
      const prev = lastSig();
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || '') && !(prev && (prev.t === 'id' || prev.x === ')' || prev.x === ']')))) {
        const m = NUM.exec(rest); push('num', i, i + m[0].length); i += m[0].length; continue;
      }
      const id = ID.exec(rest);
      if (id) { push('id', i, i + id[0].length); i += id[0].length; continue; }
      if (inTemplate) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) return; depth--; }
      }
      const p = PUNCT.find(x => src.startsWith(x, i)) || c;
      push('p', i, i + p.length); i += p.length;
    }
  }
  // A template literal: its text is never mutated, but the code inside ${ } is scanned like any other code.
  function template() {
    let j = i + 1;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        push('str', i, j); i = j + 2; code(true); j = i + 1; i = j; continue;   // code() stops on the closing }
      }
      j++;
    }
    push('str', i, j + 1); i = j + 1;
  }
  code(false);
  return toks;
}

// Builds the list of mutants for `src`: every place one operator applies, as a set of text edits plus a label.
function mutants(src, toks) {
  const sig = toks.filter(t => t.t !== 'com');
  const out = [];
  const add = (op, tok, edits) => out.push({ op, at: tok.s, edits });
  const BOOL_CALLS = new Set(['test', 'has', 'includes', 'some', 'every', 'startsWith', 'endsWith', 'isArray', 'isInteger', 'isFinite']);
  sig.forEach((tk, k) => {
    const x = tk.x;
    if (tk.t === 're') {
      const flags = /[a-z]*$/.exec(x)[0];
      const repl = '/(?!)/' + flags;
      if (repl !== x) add('regex', tk, [{ s: tk.s, e: tk.e, text: repl }]);
    } else if (tk.t === 'p') {
      const swap = { '&&': '||', '||': '&&', '<': '<=', '<=': '<', '>': '>=', '>=': '>', '===': '!==', '!==': '===' };
      if (swap[x]) add(x === '&&' || x === '||' ? 'and-or' : x === '===' || x === '!==' ? 'eq' : 'cmp', tk, [{ s: tk.s, e: tk.e, text: swap[x] }]);
    } else if (tk.t === 'num') {
      if (/^\d+$/.test(x) && Number(x) >= 2 && Number(x) < 2 ** 52 && !(sig[k - 1] && sig[k - 1].x === '.')) add('int', tk, [{ s: tk.s, e: tk.e, text: String(Number(x) + 1) }]);
    } else if (tk.t === 'id') {
      if ((x === 'true' || x === 'false') && !(sig[k - 1] && sig[k - 1].x === '.')) add('bool', tk, [{ s: tk.s, e: tk.e, text: x === 'true' ? 'false' : 'true' }]);
      if (x === 'return') {
        // Walk to the ";" that ends this return at depth 0, giving up on blocks, arrows and commas.
        let depth = 0, j = k + 1, boolish = false, ok = false;
        for (; j < sig.length; j++) {
          const q = sig[j];
          if (q.t === 'p') {
            if (q.x === '(' || q.x === '[') depth++;
            else if (q.x === ')' || q.x === ']') { if (--depth < 0) break; }
            else if (q.x === '{' || q.x === '}' || q.x === '=>') break;
            else if (q.x === ',' && depth === 0) break;
            else if (q.x === ';' && depth === 0) { ok = j > k + 1; break; }
            if (['===', '!==', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '!'].includes(q.x)) boolish = true;
            if (q.x === '(' && sig[j - 1] && sig[j - 1].t === 'id' && sig[j - 2] && sig[j - 2].x === '.' && BOOL_CALLS.has(sig[j - 1].x)) boolish = true;
          } else if (q.t === 'id' && (q.x === 'true' || q.x === 'false')) boolish = true;
          else if (q.t === 'id' && q.x === 'return') break;
        }
        if (ok && boolish) add('ret', tk, [{ s: tk.e, e: tk.e, text: ' !(' }, { s: sig[j].s, e: sig[j].s, text: ')' }]);
      }
    }
  });
  return out.sort((a, b) => a.at - b.at);
}

// Applies a mutant's edits to the source (from the end backwards, so earlier offsets stay valid).
function apply(src, edits) {
  let s = src;
  for (const e of [...edits].sort((a, b) => b.s - a.s)) s = s.slice(0, e.s) + e.text + s.slice(e.e);
  return s;
}

// A markdown-safe one-line excerpt of the source line the mutation sits on, centred on it, at most 120 characters.
function snippet(src, at) {
  const a = src.lastIndexOf('\n', at - 1) + 1; const b = src.indexOf('\n', at); const line = src.slice(a, b < 0 ? src.length : b);
  const col = at - a; let width = 100;
  const esc = (t) => t.replace(/\|/g, '\\|').replace(/`/g, "'");
  for (;; width -= 5) {
    const from = Math.max(0, Math.min(col - Math.floor(width / 2), line.length - width));
    let t = esc(line.slice(from, from + width).trim());
    if (t.endsWith('\\')) t = t.slice(0, -1);
    if (t.length <= 120 || width <= 10) return t.slice(0, 120);
  }
}

// Reads the files that `npm test` runs from package.json, so the mutation check judges the same suite CI does.
function testFiles() {
  const script = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8')).scripts.test;
  // `npm test` (scripts/test.mjs) runs every test/*.test.js; list the same files here.
  const files = /test\/\*\.test\.js|scripts\/test\.mjs/.test(script) ? readdirSync(join(ENGINE, 'test')).filter(f => f.endsWith('.test.js')).map(f => join('test', f))
    : script.split(/\s+/).filter(w => /\.[cm]?js$/.test(w));
  if (!files.length) throw new Error('no test files found in the "test" script: ' + script);
  return files;
}

// Copies the engine into a fresh temp directory with the mutated redact.js, runs the suite there, and reports how it
// ended. The copy is always removed. A hung run is killed on Windows with taskkill because its children outlive it.
function run(mutatedSource, files, timeout) {
  const dir = mkdtempSync(join(tmpdir(), 'scrub-mutant-'));
  // The copy keeps the repository layout (engine/ next to .github/), because some tests read ../.github workflows and
  // scripts/test.mjs; a copy missing them fails every run, the baseline included (PR #32 reviews).
  const eng = join(dir, 'engine');
  try {
    cpSync(ENGINE, eng, { recursive: true, filter: (p) => !/^(?:node_modules|\.git)$/.test(relative(ENGINE, p).split(sep)[0]) });
    const gh = join(ENGINE, '..', '.github');
    if (existsSync(gh)) cpSync(gh, join(dir, '.github'), { recursive: true });
    writeFileSync(join(eng, TARGET), mutatedSource);
    writeFileSync(join(eng, 'check.mjs'), mutatedSource);
    const syntax = spawnSync(process.execPath, ['--check', join(eng, 'check.mjs')], { encoding: 'utf8' });
    if (syntax.status !== 0) return 'invalid';
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: eng, encoding: 'utf8', timeout, env: process.env, maxBuffer: 64 * 1024 * 1024 });
    if (r.error && r.error.code === 'ETIMEDOUT') {
      if (process.platform === 'win32' && r.pid) spawnSync('taskkill', ['/PID', String(r.pid), '/T', '/F']);
      return 'timeout';
    }
    return r.status === 0 ? 'survived' : 'killed';
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir left to the OS */ }
  }
}

// Builds the markdown report from the mutant results.
function report(results, seconds, total) {
  const count = (s) => results.filter(r => r.status === s).length;
  const surv = results.filter(r => r.status === 'survived');
  const lines = [
    `# Mutation report: ${TARGET.split(sep).join('/')}`, '',
    `- Mutants generated: ${total}${results.length < total ? ` (ran ${results.length}, spread evenly)` : ''}`,
    `- Killed: ${count('killed')}`,
    `- Killed by timeout: ${count('timeout')}`,
    `- Survivors: ${surv.length}`,
    ...(count('invalid') ? [`- Invalid (syntax error, not counted): ${count('invalid')}`] : []),
    `- Run time: ${seconds.toFixed(1)} s`, '',
  ];
  if (surv.length) {
    lines.push('## Survivors', '', '| Line | Operator | Snippet |', '| --- | --- | --- |');
    for (const r of surv) lines.push(`| ${r.line} | ${r.op} | ${r.snippet} |`);
  } else lines.push('No survivors.');
  const ops = {}; for (const r of results) { ops[r.op] ??= { n: 0, s: 0 }; ops[r.op].n++; if (r.status === 'survived') ops[r.op].s++; }
  lines.push('', '## By operator', '', '| Operator | Mutants | Survivors |', '| --- | --- | --- |');
  for (const [op, v] of Object.entries(ops)) lines.push(`| ${op} | ${v.n} | ${v.s} |`);
  return lines.join('\n') + '\n';
}

// Entry point: generate, run, report. Exits 1 only with --fail-on-survivors and a survivor.
function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.target) TARGET = join(...opt.target.split('/'));
  const src = readFileSync(join(ENGINE, TARGET), 'utf8');
  const all = mutants(src, lex(src)).map(m => ({ ...m, line: src.slice(0, m.at).split('\n').length, snippet: snippet(src, m.at), source: apply(src, m.edits) }))
    .filter(m => m.source !== src);
  const chosen = opt.only && opt.only < all.length ? Array.from({ length: opt.only }, (_, k) => all[Math.floor((k * all.length) / opt.only)]) : all;
  const files = opt.tests || testFiles();
  // The unmutated code must pass first; otherwise every mutant would count as killed and the report would mean nothing
  // (PR #32 review). A failing baseline always exits 1.
  const base = run(src, files, opt.timeout);
  if (base !== 'survived') { process.stderr.write(`Baseline failed (${base}): the tests do not pass on the unmutated ${TARGET} in the mutation copy. No mutants were run.\n`); process.exitCode = 1; return; }
  const t0 = Date.now(); const results = [];
  for (const [k, m] of chosen.entries()) {
    const status = run(m.source, files, opt.timeout);
    results.push({ line: m.line, op: m.op, snippet: m.snippet, status });
    process.stderr.write(`mutant ${k + 1}/${chosen.length} line ${m.line} ${m.op}: ${status}\n`);
  }
  const text = report(results, (Date.now() - t0) / 1000, all.length);
  process.stdout.write(text);
  if (opt.out) writeFileSync(opt.out, text);
  // --fail-on-survivors turns the report into a gate: a mutant the tests did not notice fails CI (agenttuneup CLI plan T7).
  if (opt.failOnSurvivors && results.some(r => r.status === 'survived')) process.exitCode = 1;
}

main();
