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
- **Fresh-context reference panel** (there is no second human labeller):
  - **Setup:** 3 models from 3 different vendors, none of them Jev, all through OpenRouter. Each chat goes to each model as a brand-new request with no history. The request holds only the scrubbed chat, the bot's instructions and the same written label guide Paul uses, and asks the same PASS/FAIL question.
  - **Settings:** temperature 0, a fixed seed where the model supports one, and model ID and provider pinned when the plan is pre-registered. Every call is run twice to measure flips, because hosted models are not fully deterministic even at temperature 0.
  - **Coverage:** the panel labels all 100 Track B chats and also the Track A test set.
  - **Role:** a cross-check, never the truth. It shows how clear the labels are and how Jev compares with stronger models.
- **Disagreement review.** Some chats will have all 3 panel models agreeing with each other but disagreeing with Paul. Paul re-labels only those, blind to Jev and to the panel. Both the original and the revised labels are published, and results are scored on both.
- v1's 50 chats are the only dev set. All 100 new chats are test.

## 4. Pass bar (per track, both tracks must pass)

| Metric | Definition | Bar |
|---|---|---|
| Agreement | Judge ok/failed vs label, on runs the judge decided | Wilson 95% **lower** bound ≥ 80% |
| False pass | Judge **ok** among label **fails** (all label fails in the denominator) | Track A: one-sided 95% upper bound ≤ 10%. Track B: see open decision 2 |
| Coverage | Judge-unsure share. Scrubber-held items are counted and reported separately. | ≤ 20% |
| Kappa | Cohen's κ on decided runs | ≥ 0.6, with confidence interval |
| Stability | Verdict flips across 3 pre-declared repeat runs of the full 3-vote judge | ≤ 2%, all repeats published |

Panel numbers are reported next to these and never replace them: Paul vs panel majority (κ), panel vs Track A ground truth, and Jev vs panel. They are labelled "model reference, not a human ceiling". We also publish the full confusion matrix, all five run states (missing and errored never count as handled), coverage split by label pass vs fail, model/domain slices (marked indicative) and the precision of judge-ok verdicts.

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
- Estimates: about 3–4 days of build, about 1.5 h of Paul's labelling, and about $5–15 of model cost (Jev plus the 3-model panel, 2 runs each).

## 7. Open decisions for Paul

1. ~~Second labeller~~ Decided (Paul, 2026-10-20): no team member is available, so a fresh-context panel of 3 models replaces the second labeller (§3). The panel is a cross-check, not the truth.
2. **Track B false-pass bar.** With about 40 label-fails, a strict "upper bound ≤ 10%" allows **0** false passes (1 gives 10.5%). The alternative is "observed ≤ 10%, bound published". For comparison, Track A's 120 fails allow up to 6.
3. **Chat source.** Can about 100 new chats be exported from the bots, the same way as in v1?
