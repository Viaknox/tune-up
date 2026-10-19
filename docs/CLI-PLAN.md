# Agent Tune-Up CLI: plan

**Status:** plan for Paul's sign-off. Nothing built yet. **Owner:** Paul (decides, merges, approves releases).
**Builder:** a Claude Code session after sign-off. Same pattern as `docs/SCRUBBER-V2-PLAN.md`: tests first, then build,
then attack and mutation, then frontier-gate `verify` against the checklists below.

## 1. Decisions (final, 2026-10-16)

| # | Decision | Choice | How decided |
|---|---|---|---|
| D1 | npm name | `agenttuneup` (unscoped). Also reserve the `@viaknox` npm org | Paul |
| D2 | Releases | Release PR → Paul merges → Paul clicks **Approve** on the release job → npm publish (trusted publishing, provenance) → verify → workflow creates the `cli-vX.Y.Z` tag and GitHub release | Frontier panel, unanimous (0.98); order fixed after Codex review |
| D6 | Who approves PRs | Claude opens PRs under its own GitHub App identity; Paul approves and merges as the code owner | Paul (option A) |
| D3–D5 | Gate policy | **Strict everywhere, sequenced:** strict CI gate ships first (R1); then pass / fail / undetermined in the report and `tune` (R2), with the hosted connector re-copied the same day | Panel split (0.31); Paul chose B |
| Q3 | Judge in CI | Opt-in only (`--consent`). Without it the result reads **PASS: local rules only** | Panel checklist |
| R2-1 | How R2 wires the classifier | **Strict everywhere:** report.json (`tune-up/report@0.2`), report.md, `tune` and the hosted card all use `gate.js` `stateOf`; lift = failed→ok minus ok→not-ok on matched case-runs; "couldn't tell" moves are evidence changes, never lift | Frontier panel 4/4, consensus 0.98 (`2026-10-19-r2-classifier`); Paul chose A |
| R2-2 | "Verified" with one run per test | Not verified unless `--allow-single-repeat` (printed in the verdict): one run cannot tell a gain from judge noise | Panel item; Paul, 2026-10-19 |
| R2-3 | Old lenient number (PG15) | Kept for one release in `report.json` only (`legacy.pass_rate_lenient`), never in report.md or tune output, never used for a decision | Paul, 2026-10-19 |

Panel records: `F:\ENV\Claude outputs\frontier-gate\2026-10-16-cli-gate-policy\` and `...-cli-release-tags\`.

### D6, review policy: decided A (Paul, 2026-10-16)

Every PR here used to be opened under Paul's account, and GitHub does not let an author approve their own PR. **Claude
gets its own GitHub identity** (a GitHub App), so Claude-authored PRs can be approved by Paul as a real second person and
"Code Owner review required" works. Set up in story S0a before S0. The repo already uses the same pattern
(`SathiaAI/quality-gate`'s read-only App with one-hour installation tokens).

## 2. Facts this plan rests on (verified 2026-10-16)

| Fact | Where |
|---|---|
| A local CLI exists (`check`, `run`, `tune`), not installable (`private: true`, no `bin`), zero dependencies | `engine/cli.js`, `engine/package.json` |
| `check` and `run` always exit 0 | `engine/cli.js` |
| A run whose findings are all ok **or unsure** counts as passed; held chats are unsure, so they pass too | `engine/src/report.js` `runPassed`, `engine/src/judge.js` `heldFinding` |
| `pass_rate` is rounded (79.6 shows as 80) | `engine/src/report.js` |
| `tune` lift and regressions use the same lenient pass, so a fix that makes answers vaguer can show lift | `engine/cli.js` `liftOf`, `report.js` `regressions` |
| The hosted card is already strict: unsure 🟨 and held ⬜ are never shown as passed | viaknox `src/lib/tuneup-card.js` |
| The hosted connector vendors `engine/src` at b2ffa57; changes reach it only by a re-copy PR | viaknox `src/lib/tuneup-engine/SOURCE.txt` |
| 475 engine tests, all passing; CI runs them on Node 22 / Linux | `engine/test`, `.github/workflows/test.yml` |
| **`main` has no branch protection**; auto-merge off | GitHub API |
| Plugin releases use `v0.3.x` tags | git tags |
| Every PR is authored by Paul's account (sessions use his login) | PRs #22–#27 |
| The MIT `LICENSE` is only at the repo root; `engine/package.json` has no `repository` field | repo |
| Quality tooling: `SathiaAI/quality-gate` already comment-reviews every Viaknox PR; `SathiaAI/sast-check` is not on this repo yet | both repos |

## 3. Releases

| Release | Contents | Channel |
|---|---|---|
| **R1** `cli-v0.1.0-rc.N` → `cli-v0.1.0` | Installable CLI, strict gate, exit codes, guards, release workflow, docs | `next` only |
| **R2** `cli-v0.2.0-rc.N` → `cli-v0.2.0` | pass / fail / undetermined in report.json, report.md and `tune`; one shared evidence classifier; same-day re-copy to the hosted connector | `next` only |
| **First `latest`** | Only after Paul approves written criteria: judge calibration (≥80% agreement with human labels), privacy notes, compatibility, failure handling | `latest` |

0.x semver: any change to the report schema, config or gate behaviour is a **minor** bump, never a patch.

## 4. Gate design (R1)

### Evidence states

Every evaluated item is one of: **ok**, **failed**, **undetermined** (judge unsure or text held), **missing** (expected but
not produced), **not requested** (judge not asked: rules-only). Only *ok* counts toward a pass. In R1 this lives in a new
pure module `engine/src/gate.js`; in R2 the report and `tune` use the same module (one implementation, checklist PG8).

### Unit of scoring

The unit is a **case-run**: one test case × one repeat (`run`), or one conversation (`check`). The expected number of
case-runs comes from the suite (cases × repeats) or, for `check`, from every candidate conversation in the input **before** parsing
filters anything out (format-aware, using the **same splitting function as the parser** so the two can never disagree: each non-blank `---` or `===`
separated text block (blocks that are empty or whitespace-only, e.g. from a leading, trailing or doubled separator, are not
candidates), each element of a `conversations` list or an array of conversations; a top-level `{messages}` object
or a flat array of `{role, content}` messages is **one** candidate conversation), never from what happened to come back. An entry the parser rejects (one-sided, truncated, malformed)
is a **missing** case-run and is listed by position in the report, so incomplete input can never improve the gate. An
adapter or judge error during evaluation also makes that case-run missing instead of crashing the command.
Each case-run takes one state, by precedence: **errored** (a requested judge or agent call failed, even if other
findings already failed; the failed findings are still reported) > **failed** (any finding failed) > **missing**
(expected, not produced) >
**undetermined** (any finding unsure or held) > **ok** (every finding ok). A case-run with several passing checks and one
failed check is failed: passing checks never dilute a failure.

- Case ids must be unique within a suite (a duplicate id is a config error, exit 2). Produced results are matched one-to-one to expected (case, repeat) identities; duplicates and unexpected extras never
  count toward the numerator and are listed in the report.
- A case-run is only **ok** if it contains every finding its evidence scope requires (all rule checks; plus the judge
  questions when `--consent` is on). A run missing any required finding is **missing**, never ok.
- Strict pass rate = ok case-runs ÷ expected case-runs.
- Undetermined rate = case-runs with **any** unsure or held finding ÷ case-runs where the judge was requested. This is
  counted on its own, so a case-run that also failed still counts as undetermined here (a failure never hides uncertainty).
- A "Follows your rules" failure in any case-run fails the gate on its own (the rules veto). `--allow-rules-fail` turns
  off only that veto: the case-run is still failed and still counts against `--min`.

### Defaults (strict; loosening is explicit and printed)

| Flag | Default | Meaning |
|---|---|---|
| `--min <0-100>` | **100** when gating | Strict pass rate from raw counts, never rounded |
| `--max-undetermined <0-100>` | **0** | % of judged items that may be undetermined |
| `--allow-rules-fail` | off | A "Follows your rules" failure always fails otherwise |
| `--consent` / `TUNEUP_CONSENT=1` | off | Required for **every** remote model call (judge, `model` adapter, fix writer). Without it, `check` runs rules-only; `run` and `tune` stop with exit 2 as today. A key in the environment never counts as consent |
| `--gate` | off | Turns gating on; without it exit code is 0 whatever the result (today's behaviour) |
| `--json` | off | Writes `gate.json` |

Every loosened setting is printed in the verdict line and written to `gate.json`, so a weakened gate is visible in the
CI log.

### Verdicts and exit codes

| Exit | Verdict line | When |
|---|---|---|
| 0 | `PASS (judged)` | Gate on, all thresholds met with the judge |
| 0 | `PASS: local rules only` | Gate on, no `--consent`, rules met. Never badge-eligible |
| 1 | `FAIL` | Below threshold, a rules failure, or too many undetermined |
| 2 | `ERROR: usage/config` | Bad flag, bad suite, `--consent` with no key |
| 3 | `UNDETERMINED` | Nothing evaluated, expected cases missing, every requested judge call held, or the judge was requested but failed |

**A judge that was asked for and failed never falls back to rules-only** (exit 3, not `PASS: local rules only`).

`gate.json` records: engine version, policy (every threshold), evidence scope, suite id, judge model, raw counts per state.

## 5. Stories (each run through story-gate; quality-gate reviews every PR automatically)

| # | Story | Done when | Panel checklist (§10) |
|---|---|---|---|
| S0a | **Claude's GitHub identity (Paul's clicks, guided)** | A GitHub App (e.g. `viaknox-claude`) created by Paul, installed only on the repos Claude works in, with Contents and Pull requests write and nothing else; its private key stored where Claude sessions can mint one-hour tokens without the key entering chat; a test PR opened by the App and approved by Paul; Paul's own credential no longer used to author Claude PRs. Separate from the release App in S6 | — |
| S0 | **Repo protection (Paul's clicks, guided)** | Branch protection on `main`: PRs required, the `engine` check (the job in `test.yml`, as GitHub reports it; when S5 adds the OS/Node matrix, a single aggregate job named `engine` keeps this name stable; it runs with `if: always()` after every matrix cell and fails unless every cell succeeded, because a job skipped after a failed dependency would otherwise count as passing; and branch protection is re-verified after S5) and `sast-check / scan` required, no force or direct pushes; Code Owner review required (D6 = A); **stale approvals dismissed on every new push** and checked after setup, so a commit pushed after Paul approves needs a fresh approval. CODEOWNERS covers `.github/**`, `engine/test/**`, `engine/scripts/**` (the mutation harness), `engine/cli.js`, `engine/src/**` (every module that produces gate evidence), `engine/package.json`, `engine/LICENSE`, `engine/RELEASE_CHANNEL`, `docs/CLI-PLAN.md` (the policy contract), `.sast-check.toml`, `.github/CODEOWNERS`, release config | PG1, PG2, PT1, PT2, PT13 |
| S1 | Add sast-check | `.github/workflows/sast.yml` pinned by full SHA; zizmor clean on all workflows | PG2, PT5, PT11 |
| S2 | Tests first (R1) | §6 R1 tests (G, P, F) committed (X1–X3 are written in S9–S10); a CI run linked in the PR shows them failing on today's code | PG10 |
| S3 | `gate.js` + CLI wiring | Gate tests (G1–G15) and golden fixtures (F1–F3) green; the package tests (P) go green in S4–S5, and every R1 test in §6 (G, P, F) is green at the end of S5; the R2 tests (X1–X3) belong to S9–S10; no existing test changed except where this plan says | PG3–PG7, PG9, PT12 |
| S4 | Packaging | `name: "agenttuneup"` (today `agent-tune-up-engine`), `bin`, `files` allowlist, `private` removed; `engine/LICENSE` (copy of the root MIT LICENSE, kept identical by a test); `repository.url` = `git+https://github.com/Viaknox/tune-up.git` with `directory: engine`; `npm pack` shows only allowlisted files, LICENSE included; tarball runs via `npx` | PT6, PT23 |
| S5 | Guards | No-skip check, test-count ratchet, golden known-bad fixture, mutation run on `gate.js` with zero survivors | PG10 |
| S6 | Release workflow | Triggers when a merged release PR changes `engine/package.json` version on `main`; waits in the protected `release` environment for Paul's Approve click; publishes to npm, verifies registry integrity, provenance and channel, and **only then** creates the `cli-v*` tag and the GitHub release (so a public release never points at a failed publish). On a re-run, an existing `cli-v*` tag is accepted only if it points at the approved commit SHA (otherwise the run stops), and an existing GitHub release for that tag is verified and kept rather than recreated, so every step is safe to repeat. The channel comes from `engine/RELEASE_CHANNEL` in the release PR (`next` by default; `latest` only when Paul has approved the §3 criteria), never from the version shape, and any value other than `next` or `latest` stops the workflow before publish, and so does a `-rc`/`-beta` version with channel `latest`. Releases are serialised and no pending release is ever silently dropped (GitHub's default concurrency keeps only one pending run, so the build uses its queueing option, verified against GitHub's docs at build time; if that option is unavailable, the release-PR check blocks merging a second release PR while one is pending). If the version is already on npm, the workflow compares the registry tarball's integrity hash with the one it built: a match skips publish and resumes verification and release creation (safe re-run after a partial failure); a mismatch stops with an error. The publish job has only `id-token: write` and `contents: read`; a separate tag-and-release job runs after verification with a token minted for a dedicated release GitHub App that has `contents: write` on this repo only, and that same App is the bypass actor only on a ruleset that restricts **creating** `cli-v*` tags; a second ruleset restricts updating and deleting `cli-v*` tags with **no** bypass for anyone, so the App's token can never move or delete a published tag. The tag is created with an explicit target equal to the approved workflow commit SHA, checked again just before creation. A `-rc`/`-beta` version, or channel `next`, creates the GitHub release marked **pre-release** and not Latest.  asserts tag = `cli-v` + `engine/package.json` version, commit on `main`, tests pass, pack allowlist; `id-token: write` only on publish job; actions pinned by SHA; always an explicit `--tag` equal to the channel file; approval summary shows version, channel, commit, compatibility impact (CLI flags, report schema, config, gate behaviour; "none" stated explicitly), and the file list with digests. Each release starts as a prepared release PR (version bump, CLI changelog, channel) | PT3, PT4, PT7–PT11, PT15, PT16, PT20, PT23 (PT22 superseded, see §10) |
| S7 | Docs | README uses `npx agenttuneup@<exact version>` (existing `engine/examples/` files stay as they are); outside-team CI guide (protect suites, never expose the key to fork PRs, `pull_request` not `pull_request_target`, Level 1 vs Level 2); 0.x compatibility policy; incident runbook; CHANGELOG; a **data and retention** section naming each remote provider (the judge, the fix writer, and the `model` adapter in `run`, all via OpenRouter), what is sent after scrubbing, the no-training/zero-retention settings used, and what is not guaranteed; a packaging test checks this section is in the packed README | PG14, PT17, PT18, PT21 |
| S8 | npm bootstrap (Paul, guided) | npm needs the package to exist before trusted publishing can be set up, so: CI builds and tests the `0.1.0-rc.0` tarball; Paul publishes **that exact tarball** once from his machine with 2FA (`npm publish <file>.tgz --tag next`); then trusted publishing is configured for `release.yml` and the `release` environment; then token publishing is disallowed and the `NPMJS` token revoked. `@viaknox` org reserved; recovery codes confirmed; then `agenttuneup` is moved under (or given maintainers from) the `viaknox` npm org so publishing and recovery do not depend on one personal account, verified with `npm owner ls agenttuneup`. S6 ignores exactly `0.1.0-rc.0` (the bootstrap version; later series such as `0.2.0-rc.0` go through S6 normally) so no automated run waits behind the manual publish. Every later release goes through S6 | PT19 |
| S9 | R2: shared classifier | report.json, report.md and `tune` use pass / fail / undetermined, and the report schema id moves to `tune-up/report@0.2` (tested); `tune --gate` gates the **best eligible attempt's** after-report (positive lift, no regressions), and exits 1 only when every attempt was fully evaluated and none is eligible; if no attempt is eligible because an agent or judge call errored, it exits 3. R2 refuses baselines and attempts with a schema older than `tune-up/report@0.2` (they lack the findings the new classifier needs) and asks for a fresh `run` (new tests X4, X5); `tune` re-tests matched cases and repeats, reports evidence changes separately from behaviour gains, never says "verified" with incomplete evidence; old and new counts shown side by side for one release | PG8, PG11, PG13, PG15 |
| S10 | R2: hosted re-copy | Same-day viaknox PR re-copies `engine/src`, updates SOURCE.txt; a viaknox CI check fails if SOURCE.txt and vendored files disagree; hosted card output snapshot unchanged or explained | PG9, PG11 |
| — | Badges | Stay disabled until calibration and badge evidence rules are agreed | PG12 |

## 6. Tests (written first)

### Gate (`engine/test/gate.test.js`, pure)

| ID | Case | Expected |
|---|---|---|
| G1 | All ok, judged | exit 0, `PASS (judged)` |
| G2 | Strict rate equals `--min` exactly | exit 0 |
| G3 | One item below `--min` | exit 1 |
| G3b | 79.6% with `--min 80` | exit 1 (no rounding) |
| G4 | Judge calls completed, every answer unsure | exit 1 (`FAIL`: a quality result, not missing evidence) |
| G5 | `--consent`, every judge call held | exit 3 |
| G5b | `--consent`, judge request errors | exit 3, never `PASS: local rules only` |
| G5d | Every requested judge call held, and a local rule also failed | exit 3 (held evidence outranks the rule failure for the exit code); the rule failure is still listed |
| G5c | A rule check already failed in a case-run, then the judge request for that run errors | exit 3 (errored outranks failed); the rule failure is still listed |
| G6 | One rules failure, everything else ok | exit 1 |
| G7 | G6 with `--allow-rules-fail` and `--min 90` | exit 0 (the rules veto is off, the failed case-run still counts against `--min`); the loosening is printed and in `gate.json` |
| G7b | G6 with `--allow-rules-fail` and default `--min 100` | exit 1 (the failed case-run is still below the threshold) |
| G8 | 1 undetermined with default `--max-undetermined 0` | exit 1 |
| G8b | 10 judged runs: 9 ok, 1 with both a failed and an unsure finding; `--min 90 --max-undetermined 0` | exit 1 (the run counts as undetermined even though it is also failed) |
| G9 | No `--consent`, rules all ok | exit 0, `PASS: local rules only`, `gate.json.evidence = "rules-only"` |
| G10 | No `--gate` | exit 0 whatever the result |
| G11 | `--min` or `--max-undetermined` set to `-1`, `101`, `abc`, or no value | exit 2, nothing evaluated (both flags) |
| G11c | `tune --gate` | exit 2 in R1 (gating `tune` is not defined until R2) |
| G11b | Unknown or misspelled flag (`--gte`, `--consnet`) on any command | exit 2, nothing evaluated (the parser no longer ignores unknown flags) |
| G12 | `check` input with zero conversations | exit 3 |
| G12c | `run` with a suite that has no cases | exit 2 (invalid config, as `validateSuite` already rules), nothing evaluated |
| G12d | Flat JSON array of 2 messages (`user`, `assistant`) | 1 expected case-run, judged normally (not exit 3) |
| G12f | Two valid chats with a leading, a trailing and a doubled `---` | 2 expected case-runs, exit 0 when both pass (blank blocks are not missing) |
| G12e | Two valid chats separated by `===`; a `{messages: [...]}` object | 2 and 1 expected case-runs respectively, matching what the parser produces |
| G12b | Export with 1 valid conversation and 2 one-sided or malformed entries | exit 3; the 2 rejected entries are counted as missing and listed by position |
| G13b | A produced case-run with no judge findings although `--consent` was on | that run is missing; exit 3 |
| G12g | Suite with two cases sharing one id | exit 2 before anything runs |
| G13c | 1 expected run failed plus a duplicate ok result for the same (case, repeat) | the duplicate is ignored and listed; exit 1 |
| G13 | Suite case expected but produced no run | exit 3 (missing never improves the denominator) |
| G14 | `gate.json` against a frozen schema | matches; includes version, policy, scope, raw counts |
| G15 | `--min 80 --max-undetermined 10`, result passes | verdict line names both loosened values; `gate.json.policy` records min 80 and max_undetermined 10 |

### Package and CLI (`engine/test/cli-package.test.js`)

| ID | Case | Expected |
|---|---|---|
| P1 | `npm pack --dry-run` file list | only the allowlist, and `LICENSE` is present; no `test/`, `.sqlite`, brand files |
| P1b | Packed manifest: `name`, `repository.url`, `LICENSE` | `name` is exactly `agenttuneup`; URL exactly `git+https://github.com/Viaknox/tune-up.git`; `engine/LICENSE` identical to root `LICENSE` |
| P2 | Install tarball in a temp dir, `npx agenttuneup --version` | version printed, exit 0 |
| P3 | `npx agenttuneup check <fixture> --gate`, no consent, fetch stubbed to throw | runs, no network call |
| P3b | `run` and `tune` with a key in env but no consent, fetch stubbed to throw | exit 2, no network call |
| P3c | `check --gate` and `run` with `TUNEUP_CONSENT=1` and no `--consent`, network stubbed | consent honoured (judge and model calls attempted); the same with a key but `TUNEUP_CONSENT` unset makes no call |
| P4 | Exit codes 0/1/2/3 propagate through `npx` | each matches the gate test |
| P5c | Packaged CLI: `check` on a file that looks like JSON but is truncated or invalid | exit 2 with a plain message naming the file, no stack trace, nothing sent |
| P5b | Packaged CLI: `check --gte`, `run --consnet`, `tune --consnet` | exit 2 for each, nothing evaluated, no network call |
| P4b | `run --gate --json` where the agent adapter throws on case 2, and `check --gate --consent --json` where the judge request throws | exit 3 `UNDETERMINED`, the failed case-runs recorded as **errored** in `gate.json`, no unhandled error |
| P5 | Fake key in env, network stubbed | key never in stdout, stderr, report.md, gate.json |
| P6 | Paths via `fileURLToPath`; P2–P4 | run in CI on native `ubuntu-latest`, `windows-latest` and `macos-latest` runners, each on Node 20.12 (the minimum in `engines`) and Node 22 (a matrix job added in S5) |

### Golden fixtures (offline, in CI)

| ID | Fixture | Expected |
|---|---|---|
| F1 | known-bad chats: fake "done", card number echoed | `FAIL`, names both |
| F2 | known-good chats | `PASS: local rules only` |
| F3 | all-undetermined (judge stubbed to 50%) | exit 1 |

### R2 additions

| ID | Case | Expected |
|---|---|---|
| X1 | A tune attempt that turns failures into undetermined | lift is 0 or negative; not "verified" |
| X2 | report.md for a held chat | shows "couldn't tell", not PASSED |
| X3 | CLI and hosted card on the same chats | same counts per state |
| X4 | `tune --gate --json` with one attempt that lifts and one that regresses; with no eligible attempt; and with an attempt whose judge call errored | gates the eligible attempt's after-report; exit 1 when fully evaluated and none is eligible; exit 3 when the only attempts errored |
| X5 | R2 `tune` pointed at an R1 (`report@0.1`) baseline | stops with exit 2 and asks for a fresh `run`; no lift is reported |

## 7. Guards against "green just to merge"

| Guard | Catches |
|---|---|
| Branch protection + CODEOWNERS (S0) | A PR that loosens tests and code together, or edits its own CI |
| Red-first CI run linked in the PR (S2) | Tests that could never fail |
| Golden fixtures F1, F3 must fail (S5) | A gate weakened to always pass |
| No `skip` / `only` / `todo` in `engine/test` (S5) | Quietly disabled tests |
| Test-count ratchet `engine/test/BASELINE`: set in S5 to the full count after S2's new tests, and raised by every PR that adds tests | Deleted tests, including the new safeguards |
| Mutation run on `gate.js`, zero survivors (S5) | Tests that pass whatever the code does |
| quality-gate review on every PR (automatic) | Weakened asserts, swallowed errors; findings get a written disposition |
| sast-check required (S1) | Security issues and risky workflow changes |
| Second-model diff review (Qwen or DeepSeek) for weakened tests | What a skim misses |
| frontier-gate `verify` against both checklists before each release | Skipped checklist items |

AI reviews are advisory. They do not replace a human security review where one is needed (panel item PT14).

## 8. Risks

| Risk | Mitigation |
|---|---|
| Strict defaults fail too many PRs while the judge is uncalibrated | Defaults are strict on purpose; teams loosen visibly; R1/R2 stay on `next`; calibration gates `latest` |
| CLI and hosted scores drift | One classifier (R2), same-day re-copy, SOURCE.txt check in viaknox, X3 |
| A bad publish breaks pinned CI users | Exact pins in docs, `next` first, incident runbook (deprecate, restore `latest`, never reuse versions or move tags) |
| Typosquats | Reserve `@viaknox`; publish the real name early via `next` |
| Teams leak their judge key to fork PRs | CI guide: `pull_request` only, secrets only in protected environments |

## 9. Not in this plan

Hosted sign-in from the CLI (free capped judge for CLI users), `fixes --apply`, badges. Separate plans after R2.

## 10. Panel checklists (the contract `verify` checks against)

### Gate policy (PG)

1. Enable branch protection on `main` to enforce CODEOWNERS, required checks, stale approval invalidation, and mandatory approval from Paul for gate, test, workflow, or policy changes.
2. Integrate `SathiaAI/sast-check` using a pinned SHA as a required CI check for the `tune-up` repository and protect all workflow files from unauthorized modification.
3. Implement a tri-state redesign (pass, fail, undetermined) that fails closed by default for missing credentials, missing results, or mandatory-rule failures unless explicit, visible overrides are configured.
4. Enforce a strict default gate requiring --min 100, --max-undetermined 0, no mandatory-rule failures, and no missing evaluations, where unsure or held evidence never counts as passed.
5. Require explicit evidence scope selection where rules-only modes must display a prominent 'PASS: local rules only' verdict and cannot be triggered by judge failures.
6. Maintain judge use as opt-in with explicit consent, ensuring API keys or CI environments do not authorize data transmission without documented provider and scrubber disclosures.
7. Validate expected cases, repeats, and findings before scoring, ensuring empty suites or missing cases never improve the denominator or coverage metrics.
8. Share a single evidence-classification implementation across reports, gate, and tune that distinguishes between ok, failed, inconclusive, missing, and not-requested status.
9. Record engine version, policy, scope, suite/judge identity, and raw counts in reports, and pin the engine version in viaknox with a CI check for SOURCE.txt consistency.
10. Test the packaged npm CLI end-to-end for exit-code propagation and run golden-fixture, no-skip, count-ratchet, and mutation safeguards to prevent hidden coverage gaps.
11. Sequence the versioned breaking change after the strict gate ships, including a changelog, fixture snapshots, and a same-day MCP recopy PR to verify hosted card output.
12. Disable public badges and scores until judge-vs-human calibration is complete and badge-specific evidence requirements are satisfied.
13. Re-test tune using matched cases and repeats. Report confidence/coverage changes separately from behavioral gains, and do not label fixes verified when required evidence is incomplete.
14. Publish outside-team CI guidance that protects suites and policies, does not expose judge credentials to untrusted PR code, and distinguishes Level 1 transcript checks from Level 2 evaluation of the changed agent. Keep badges disabled until calibration and badge-specific evidence requirements are satisfied.
15. Publish old vs new pass counts in tune output during a transition window

### Release tags (PT)

1. Enable branch protection on `main` requiring pull requests, passing `test.yml` and `sast-check` (pinned by SHA), and blocking force-pushes and direct pushes.
2. Assign Paul as the mandatory CODEOWNER for `.github/**`, `engine/package.json`, security configurations, and release configurations.
3. Restrict `cli-v*` tag creation to the owner and ensure tags are immutable, targeting approved commits reachable from the protected `main` branch.
4. Configure a 'release' GitHub environment requiring Paul's manual approval, restricted to protected refs, with `id-token: write` and `contents: read` permissions only.
5. Integrate `SathiaAI/sast-check` to block merges on critical vulnerabilities and use `zizmor` to lint release workflows.
6. Use a strictly whitelisted `files` array in `engine/package.json` to include only the executable (`cli.js`), its runtime modules (`src/**`), LICENSE, README and `package.json` (there is no compile step), while explicitly excluding brand assets, secrets, and fixtures.
7. Verify that the git tag exactly equals `cli-v` + the `engine/package.json` version and that the package is not marked as private before proceeding with the release.
8. Build and test the packed artifact in an isolated job using Node 22.14+ and npm 11.5.1+, validating the full supported platform matrix and exit codes.
9. Provide a plain-language approval summary showing the version, `dist-tag`, commit, compatibility changes, and a full `npm pack` file list with digests.
10. Route releases to `--tag next` for prerelease suffixes (-rc, -beta) and `latest` otherwise, ensuring an explicit `dist-tag` is always passed to npm.
11. Pin all third-party GitHub Actions to full SHAs, set `persist-credentials: false`, and prevent the execution of untrusted PR code in the publishing job.
12. Require opt-in for external judge data transmission, document data retention/redaction, and ensure judge unavailability results in a gate failure (exit 3). Lack of calibration blocks the `latest` channel and badges, not the R1 gate on `next` (plan adjustment after Codex review).
13. Protect main before releasing: require PRs, passing tests and the pinned-SHA sast-check; prevent force pushes and ordinary direct pushes, and tightly restrict bypass rights. Add CODEOWNERS for workflows, packaging, security configuration and release configuration, with a review policy workable for Paul as the sole merger.
14. Keep quality-gate advisory and require disposition of actionable findings. Require written reasons for security suppressions. Do not treat an AI review or approval by a non-coder as a substitute for technical security review when needed.
15. Provide a prepared release PR containing the version, CLI-specific changelog, compatibility changes and release channel. After Paul merges it, automation should create the protected tag; the existing plugin release process should remain separate.
16. Use a pinned publishing toolchain meeting Node 22.14+ and npm 11.5.1+ requirements. Match the trusted-publisher repository, workflow filename and environment configuration exactly. Give id-token: write only to the publishing job, pin third-party actions by SHA and avoid executing untrusted PR code in that job.
17. Start the uncalibrated CLI on next, preferably with prerelease versions. Define calibration, privacy, compatibility and failure-handling criteria before Paul authorizes the first latest release. Always pass an explicit dist-tag; do not automatically equate every 0.x non-prerelease with suitability for external CI.
18. Document exact CI pins such as agenttuneup@0.1.0, not @0.1, latest or next. Keep CLI, plugin, report-schema and rubric versions distinct. Document the 0.x compatibility policy, treating incompatible schema, configuration and gate-behavior changes as minor rather than patch changes.
19. Complete the controlled account-based bootstrap, then enable OIDC and disable token publishing. Verify account 2FA, recovery and organizational package ownership; reserving @viaknox alone does not transfer ownership of the unscoped agenttuneup package.
20. Serialize releases, reject duplicate versions and provide safe recovery after a partially completed publish. Verify registry integrity, provenance and channel after publishing, then create the CLI-specific GitHub release.
21. Document incident response: freeze releases, deprecate affected versions, restore latest to a known-good version and publish a new corrective version without reusing old versions or moving git tags. Configure separate OIDC dist-tag permission if channel management needs it. Explain that changing latest does not repair consumers pinned to a bad version.
22. Make the non-coder path explicit: Paul creates a GitHub Release from the UI choosing a new tag cli-vX.Y.Z (or cli-vX.Y.Z-rc.N with 'pre-release' ticked); workflow triggers on release: published, not on arbitrary tag push
23. Workflow must assert: tag matches engine/package.json version; tagged commit is reachable from main; package.json has private removed; run full test suite; npm pack --dry-run and fail if any file outside the allowlist (engine source, LICENSE, README, package.json) appears; fail if any brand asset path appears

Plan adjustments after Codex review of PR #27: PT15 (automation creates the tag after the release PR merges) is used instead of PT22's "Paul creates the release in the UI", because a release published first would be public before npm publish and verification (PT20). PT10's "`latest` for non-prerelease" is replaced by an explicit channel file, because 0.x stable releases stay on `next` until Paul approves the §3 criteria (PT17). Records: `F:\ENV\Claude outputs\frontier-gate\2026-10-16-cli-*`.
