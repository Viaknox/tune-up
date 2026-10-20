# Judge calibration plan (v2)

Status: **draft for Paul's approval.** Nothing below runs until Paul approves these criteria in writing, before any test result is seen.
Decision record: frontier-gate run `2026-10-20-judge-calibration`, where all 4 reviewers chose `two_track_preregistered` (Jev consensus 0.97). The panel's 22 refinements are folded in below.

## 1. Why

`latest` on npm and public badges are blocked until the judge is calibrated (CLI-PLAN §3, PG12). The existing evidence is calibration v1 (2026-10-11): 50 of Paul's own chats, Level 1 only, labelled with the judge's verdict visible, and later used to add the `initiative` question. That makes v1 a **development set**, not a test. Level 2 (`run`, which most CI gates use) has never been calibrated.

## 2. What we will claim, and what we won't

| Claim on the evidence page | Covered by |
|---|---|
| Level 2: the judge's **`completed`** verdict matches the real outcome | Track A (objective ground truth) |
| Level 1: a run's **overall verdict** (ok / not ok) matches the owner's "would I be happy if every chat went like this?" | Track B (blind human labels) |
| Level 2 `truthful`, `followed_rules`, `needless_question` | **Not calibrated by this plan.** Each one is listed as "not yet calibrated" on the evidence page and in the report footer, and is never averaged into a single "Level 2 %" headline. |
| Badges | Out of scope. Badges need their own validity plan after this one passes. |

## 3. Data

**Track A (Level 2, objective).** Trajectories from `sierra-research/tau-bench` `historical_trajectories` (MIT): 1,980 tool-using customer-service runs (gpt-4o and Claude 3.5 Sonnet, airline and retail), each with a deterministic reward (final database state and required outputs).
- Sample 300 with a fixed seed, stratified by model, domain and reward (balanced pass and fail).
- Split by task group, so repeats of one task never span dev and test. 60 go to dev and 240 to test.
- Mapping: agent instructions = the domain policy; test intent = the user's task instruction; tool calls and results are shown to the judge. The reward and any reference outputs are **never** shown to it, and a test checks this.
- Airline tasks whose labels are known to be noisy (tau2-bench) are listed before the run. Results are reported both with and without them, and no case is dropped because the judge disagreed.

**Track B (Level 1, human).** 100 **new** real chats from Paul's bots, dated after 2026-10-11 and never seen by the judge's designers. They run through the scrubber and never-send list first.
- Paul labels every chat PASS or FAIL with a one-line reason, in a sheet that hides the judge's verdict.
- A second labeller blind-labels 30 of them, working from the same written guide and blind to Paul's labels and to the judge. This measures the human ceiling.
- v1's 50 chats are the only dev set. All 100 new chats are test.

## 4. Pass bar (per track, both tracks must pass)

| Metric | Definition | Bar |
|---|---|---|
| Agreement | Judge ok/failed vs label, on runs the judge decided | Wilson 95% **lower** bound ≥ 80% |
| False pass | Judge **ok** among label **fails** (all label fails in the denominator) | Track A: one-sided 95% upper bound ≤ 10%. Track B: see open decision 2 |
| Coverage | Judge-unsure share. Scrubber-held items are counted and reported separately. | ≤ 20% |
| Kappa | Cohen's κ on decided runs | ≥ 0.6, with confidence interval |
| Stability | Verdict flips across 3 pre-declared repeat runs of the full 3-vote judge | ≤ 2%, all repeats published |

We also publish the full confusion matrix, all five run states (missing and errored never count as handled), coverage split by label pass vs fail, model/domain slices (marked indicative) and the precision of judge-ok verdicts.

## 5. Guards against "tuned until green"

1. **Pre-register on `main` before any test run.** The commit records the hashes of the sample IDs, seed, split, label guide, adapter, scrubber limits, judge model and provider, question text, thresholds and voting procedure.
2. **Tuning happens on dev only.** Once a test set has been run it is spent. If anything frozen changes, the next attempt uses a **fresh** sample, never a re-run on the old one.
3. **Every test execution is logged.** All runs are published, not just the best one.
4. **If a track fails, `latest` stays blocked.** The fix is made on dev and re-validated on a new sample.
5. **The calibration is tied to the pipeline.** Reports gain a footer naming the judge model, rubric hash and calibration ID. A change to the model, questions or thresholds marks the calibration stale.

## 6. Build

- Tooling lives in `calibration/` at the repo root. It is outside `engine/` and outside the npm `files` allowlist, so it adds no package dependency.
- It contains: the tau-bench adapter, a sampler with seed, the blind label sheet (CSV), a scorer (pure, unit-tested, mutation-tested like the gate), the manifest and a report.
- Engine change: one report footer field (calibration manifest ID plus rubric hash). It ships as a minor bump on `next`.
- Published: scripts, tau-bench IDs, raw judge probabilities per call (model ID, provider, timestamp), and label files. Level 1 chats are published only after a second never-send pass; otherwise only their hashes are published.
- Estimates: about 3–4 days of build, about 1.5 h of Paul's labelling, and under $2 of judge cost.

## 7. Open decisions for Paul

1. **Second labeller** for 30 chats: who, or should the human ceiling be reported as single-labeller only?
2. **Track B false-pass bar.** With about 40 label-fails, a strict "upper bound ≤ 10%" allows **0** false passes (1 gives 10.5%). The alternative is "observed ≤ 10%, bound published". For comparison, Track A's 120 fails allow up to 6.
3. **Chat source.** Can about 100 new chats be exported from the bots, the same way as in v1?
