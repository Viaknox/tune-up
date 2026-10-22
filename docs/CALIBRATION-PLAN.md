# Judge calibration plan (v3)

Status: **draft for Paul's approval.** Nothing below runs until Paul approves these criteria in writing, before any test result is seen.
v3 (Paul, 2026-10-22): **external data only, no human labelling.** Track B is dropped; Level 1 is calibrated on a chat-only view of the same Track A runs (§3), and Track A gains more kinds of agent work. Earlier decision record: frontier-gate run `2026-10-20-judge-calibration`, where all 4 reviewers chose `two_track_preregistered` (Jev consensus 0.97). The panel's 22 refinements are folded in below.

## 1. Why

`latest` on npm and public badges are blocked until the judge is calibrated (CLI-PLAN §3, PG12). The existing evidence is calibration v1 (2026-10-11): 50 of Paul's own chats, Level 1 only, labelled with the judge's verdict visible, and later used to add the `initiative` question. That makes v1 a **development set**, not a test. Level 2 (`run`, which most CI gates use) has never been calibrated.

## 2. What we will claim, and what we won't

| Claim on the evidence page | Covered by |
|---|---|
| Level 2: the judge's **`completed`** verdict matches the real outcome | Track A (objective ground truth) |
| Level 1 (the hosted chat check): the judge's **`completed`** verdict on the **chat only** matches the real outcome | Track A, chat-only view (§3) |
| Level 1 overall verdict and its other checks (`truthful`, `followed_rules`, `needless_question`, `initiative`, frustration) | **Not calibrated by this plan.** Listed as "not yet calibrated". |
| Level 2 `truthful`, `followed_rules`, `needless_question` | **Not calibrated by this plan.** Each one is listed as "not yet calibrated" on the evidence page and in the report footer, and is never averaged into a single "Level 2 %" headline. |
| Badges | Out of scope. Badges need their own validity plan after this one passes, and may only name a check this plan calibrated (today: "Gets it done"). |

## 3. Data

**Track A (Level 2, objective).** Trajectories from `sierra-research/tau-bench` `historical_trajectories` (MIT): 1,980 tool-using customer-service runs (gpt-4o and Claude 3.5 Sonnet, airline and retail), each with a deterministic reward (final database state and required outputs).
- Sample 300 with a fixed seed, stratified by model, domain and reward (balanced pass and fail).
- Split by task group, so repeats of one task never span dev and test. 64 go to dev (8 per stratum) and 240 to test (30 per stratum). The drawn sample is committed in `engine/calibration/track-a.sample.json` (seed, tau-bench commit, file hashes, ids, sample hash).
- Mapping: agent instructions = the domain policy; test intent = the user's task instruction; tool calls and results are shown to the judge. The reward and any reference outputs are **never** shown to it, and a test checks this.
- **More kinds of agent work** (Paul, 2026-10-22: variety, external only). Each source is added only after its licence is checked and recorded in the manifest; a source whose licence does not allow this use is dropped, not worked around:
  - `sierra-research/tau2-bench` **telecom** (technical support where the user also acts): same adapter shape, deterministic reward. Licence: to verify.
  - `McGill-NLP/agent-reward-bench` (web agents on AssistantBench, WebArena, VisualWebArena, WorkArena): expert-labelled success. Licence: to verify. Full view only (its trajectories are browser actions, not a chat).
  - Results are reported per source and per domain (indicative where small), never pooled into one headline that hides a weak domain.
- **Two views of the same runs** (no new labels needed):
  - **Full view** (Level 2, `run`): user and agent messages plus every tool call and result, as above.
  - **Chat-only view** (Level 1, the hosted check): the same runs with tool calls and tool results removed, so the judge sees only what a user would paste. The ground truth is the same reward. A test checks that no tool call, tool result, reward or reference output reaches the judge in this view.
  - Each view is scored separately against §4. The chat-only view is expected to score lower, because the judge cannot see what happened behind the scenes, and that is reported as found.
- Airline tasks whose labels are known to be noisy (tau2-bench) are listed before the run. Results are reported both with and without them, and no case is dropped because the judge disagreed.

**Track B (human labels): dropped** (Paul, 2026-10-22). No own-bot chats and no human labelling are used. The fresh-context reference panel (3 models from 3 vendors, as in the dev pilot `evidence/tune-up-calibration-pilot.md`) still labels the Track A test set as a cross-check, never the truth.
- v1's 50 chats stay a development set only; they are never test data.

## 4. Pass bar (per view)

Each Track A view (full, chat-only) is scored on its own, and each must pass for its claim.

| Metric | Definition | Bar |
|---|---|---|
| Agreement | Judge ok/failed vs label, on runs the judge decided | Wilson 95% **lower** bound ≥ 80% |
| False pass | Judge **ok** among label **fails** (all label fails in the denominator) | One-sided 95% upper bound ≤ 10% |
| Coverage | Judge-unsure share. Scrubber-held items are counted and reported separately. | ≤ 20% |
| Kappa | Cohen's κ on decided runs | ≥ 0.6, with confidence interval |
| Stability | Verdict flips across 3 pre-declared repeat runs of the full 3-vote judge | ≤ 2%, all repeats published |

Panel numbers are reported next to these and never replace them: panel vs Track A ground truth, and Jev vs panel. They are labelled "model reference, not a human ceiling". We also publish the full confusion matrix, all five run states (missing and errored never count as handled), coverage split by label pass vs fail, model/domain slices (marked indicative) and the precision of judge-ok verdicts.

## 5. Guards against "tuned until green"

1. **Pre-register on `main` before any test run.** The commit records the hashes of the sample IDs, seed, split, label guide, adapter, scrubber limits, judge model and provider, question text, thresholds and voting procedure.
2. **Tuning happens on dev only.** Once a test set has been run it is spent. If anything frozen changes, the next attempt uses a **fresh** sample, never a re-run on the old one.
3. **Every test execution is logged.** All runs are published, not just the best one.
4. **If a view fails, its claim is not made and `latest` stays blocked.** The fix is made on dev and re-validated on a new sample.
5. **The calibration is tied to the pipeline.** Reports gain a footer naming the judge model, rubric hash and calibration ID. A change to the model, questions or thresholds marks the calibration stale.

## 6. Build

- Tooling lives in `engine/calibration/`. It is outside the npm `files` allowlist, so it never ships. Keeping it under `engine/` lets it reuse the test runner, the count ratchet and the mutation check (zero survivors, run in CI).
- It contains: the tau-bench adapter (full and chat-only views), adapters for each added source, a sampler with seed, a scorer (pure, unit-tested, mutation-tested like the gate), the manifest and a report.
- Engine change: one report footer field (calibration manifest ID plus rubric hash). It ships as a minor bump on `next`.
- Published: scripts, tau-bench IDs, raw judge probabilities per call (model ID, provider, timestamp), and the ground-truth labels as the sources publish them. All data is external; none of our users' chats is used.
- Estimates: about 3–4 days of build, no labelling time for Paul, and about $10–25 of model cost (two views and up to three sources) (Jev plus the 3-model panel, 2 runs each).

## 7. Decisions for Paul

1. ~~Second labeller~~ Decided (2026-10-20): a fresh-context 3-model panel, a cross-check only.
2. ~~Chat source / Track B~~ Decided (2026-10-22): external data only, no human labelling; Track B dropped; Level 1 via the chat-only view of Track A.
3. **Still open: the pass bar.** The dev pilot (64 runs, full view) found 56–70% agreement for every judge tried, against the 80% bar here, and AgentRewardBench reports no judge above 70% precision. Before pre-registration Paul chooses, with this evidence in hand: keep 80% (and expect a fail, fixed on dev), or set a different bar now. The bar is never changed after a test run.
