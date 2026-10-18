# Changelog

## Unreleased

- **`agenttuneup` CLI (npm, v0.1.0): a strict CI gate, per `docs/CLI-PLAN.md`.** `check` and `run` take `--gate`: exit `0` for `PASS (judged)` or `PASS: local rules only` (no `--consent`), `1` for `FAIL` (pass rate below `--min`, too many unsure results, or a "Follows your rules" failure), `3` for `UNDETERMINED` (nothing to check, expected chats or cases missing, a requested judge or agent call failed, or everything held back), `2` for usage or config errors. Without `--gate` the exit code stays `0`. Strict defaults (`--min 100`, `--max-undetermined 0`, rules veto on) can be loosened only with `--min`, `--max-undetermined` and `--allow-rules-fail`, which are printed in the verdict and recorded in `gate.json` (`--json`). Every chat entry in the input counts: one that can't be read as a chat is a missing result, listed by position. Unknown options and unknown `TUNEUP_*` settings stop the run instead of being ignored; malformed input files exit `2` without quoting the file. The judge or the agent being unreachable or replying with something unusable is an unsure finding (`judge:error`, `agent_error`) that makes the result `UNDETERMINED`, never a crash or a pass. Anti-suppression tests (`test/gate.test.js`, `test/cli-package.test.js`) cover every finding code, every gate rule, the packed package on Linux, Windows and macOS, and a test-count ratchet (`test/BASELINE`); the gate code is mutation-tested in CI with zero survivors. A suite whose tool checks the agent can't show is refused before anything is sent.
- New `engine/` (v0.1, Phase 0): evaluates an agent against a test suite and writes a six-part report card (rule checks first, Jev as judge, repeat runs, evidence levels), and drafts verified tune-ups that are re-tested with the fix lift reported. Adapters: any HTTP chatbot, and instruction replay on an OpenRouter model. First run on the BookBot demo found a calendar leak in 3 of 3 runs; the verified tune-up stopped it (+11 points). See `engine/README.md` and `engine/examples/bookbot-first-run.md`.
- Engine: `check` command for chats people paste or export (text with speaker labels, or JSON exports). Personal data and secrets are scrubbed on the user's machine before anything is sent; nothing is sent without `--consent` (rules-only mode otherwise). New local checks: repeated asks and corrections (Keeps you happy), and the agent repeating card, key or ID numbers back.
- Engine review fixes: case ids are scrubbed before reaching the fix writer; consent text and README state the scrubber's real coverage (US SSNs and IPv4 only for IDs and IPs); `--repeats` must be 1–20; `tune` only uses a report and attempts made from the same suite and baseline; an apology no longer counts as a refusal; a success in an earlier turn backs a later "confirmed"; short replies are no longer treated as cut off (cut off now means the model hit its length limit); `|` in reasons no longer breaks report tables; empty JSON chat exports are rejected.
- Skill `license` field now reads "MIT for code and text. Brand assets are not MIT; see LICENSE-BRAND.md" (Agent Skills spec allows a license name or a pointer to a bundled file). Takes effect in the next release; 0.3.4 is unchanged.

## 0.3.4 — 2026-10-10

- README heading is now "Agent Tune Up™" (the product's trademark name), with a download link to the latest release. Tune-Up stays the short name and the repo name.
- Agensi-ready zip attached to the release as `agent-tune-up-0.3.4.zip`.

## 0.3.3 — 2026-10-10

- Brand assets are now explicitly outside the MIT License: `LICENSE-BRAND.md` (all rights reserved, with allowed uses), `LICENSE.md` in `brand/` and `tune-up/brand/`, and notes in README, TRADEMARK.md, BRAND.md and the skill footers. `LICENSE` itself is unchanged MIT and still covers the code and text.

## 0.3.2 — 2026-10-10

- New line everywhere: "Tunes up your Grok bots. Loads the right skill only when it's needed." README banner, GitHub social preview and social posts updated.
- Added the Tune-Up icon: `icon.png` (repo root, 512 px) and `brand/icon/` (SVG, 16–1024 px PNGs, favicon.ico).
- Explainer v2 (45 s): Tune-Up reviews a drifting bot, turns a miss into a test, applies a small fix you approve; the skill index loads one skill and adds from marketplaces on yes; Tune-Up moves repeated jobs into the index.
- New Tune-Up brand art from the Viaknox brand kit (v1.7.0): Tune-Up wordmark, lockups, marks, PNGs and tokens renamed `tune-up-*`; README banner, GitHub social preview, explainer (MP4, GIF, still), before/after and social posts all read Tune-Up and github.com/viaknox/tune-up.
- `brand/BRAND.md` rewritten for Tune-Up; the old grokbot-skill-index repo address is gone. Added `brand/avatar/` (sticker version with a Paper outline for Grok's dark UI).
- `tune-up/brand/tune-up-explainer-960.gif` replaced with the Tune-Up version.

## 0.3.1 — 2026-10-10

- Tune-Up's title is now "Bot that tunes up other bots".
- Tune-Up's bot picture is the new sticker raven, and the new Tune-Up artwork is in `brand/`.
- README: TL;DR, plain description, and the problems Tune-Up solves.
- Agensi-ready zip attached to this release.

## 0.3.0 — 2026-10-10

- Renamed the product from Skill Index (`grokbot-skill-index`) to Tune-Up (`tune-up`). First mention is "Tune-Up for Grok Bot". The skill library is now "the skill index", a feature of Tune-Up.
- Repo moved to https://github.com/viaknox/tune-up. Old links redirect. Install folder is now `~/.cursor/plugins/local/tune-up`.
- Plugin name is `tune-up` (display name Tune-Up). Skill ids `skill-index`, `find-skill`, `import-agent-skill`, and `set-up-tune-up` are unchanged.
- Tune-Up bot instructions now point at the new install folder.
- README rewritten to lead with Tune-Up. Footers, repository links, and `TRADEMARK.md` updated.
- The logo wordmark, lockup files, and README banner art still read Skill Index, pending new art. The raven mark is unchanged and is Tune-Up's mascot.
- Retired the old 0.1.0 Agensi packaging script. It rebuilt from a stale snapshot and would overwrite current files. The Agensi package is now built from the current tree.

## 0.2.0 — 2026-10-10

- New Skill Index brand (tinkerer raven, Deep Petrol and Brass). Brand files and rules in `brand/`.
- Removed the old brain logo.
- Tune-Up now ships with its raven mascot in `tune-up/brand/`, and setup sets it as the bot's picture.
- Added the new headline, a before-and-after explainer, the Tune-Up animated explainer (GIF and MP4), and social images (link card, square post, story) in `brand/`.
- Credit lines and skill author now read Viaknox.
- LICENSE copyright holder is now Viaknox Holding LLC.
- Added Tune-Up, a bot that evaluates and improves your other Grok bots: `skills/set-up-tune-up/SKILL.md` (set it up by asking any bot) and `tune-up/` (paste-ready instructions and a guide).

## 0.1.0 — 2026-10-10

First release as Grokbot-skill-index, published by Viaknox Holding LLC.

- Renamed the plugin to `grokbot-skill-index`.
- Added Viaknox™ branding lines, `TRADEMARK.md`, and a not-affiliated-with-SpaceXAI/xAI notice.
- Added `metadata` (author, publisher, version, repository) and `license` to the skill frontmatter.
- README: added "MIT licensed, also on GitHub" line and trademark section.
- Added an Agensi-ready single-skill package build (not part of the plugin layout).
