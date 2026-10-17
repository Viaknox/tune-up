# Releasing the agenttuneup CLI

How the `agenttuneup` npm package is released (docs/CLI-PLAN.md S6 and S8). The plugin and skills keep their own `v*`
releases; nothing here touches them.

## Every release (after the one-time setup)

1. **Claude opens a release PR** that changes, in one PR:
   - `engine/package.json` `version` (0.x: any change to CLI options, report or gate.json schema, config or gate behaviour is a minor bump, never a patch);
   - `engine/CHANGELOG.md`: a `## <version>` section with a `Compatibility:` line ("none" when nothing changes for users);
   - `engine/README.md`: the exact pin `agenttuneup@<version>`;
   - `engine/RELEASE_CHANNEL`: `next` (stays `next` until you approve the first `latest`, plan §3).
   The tests in `engine/test/release.test.js` fail the PR if any of these is missing or inconsistent.
2. **You merge it.** The `release` workflow builds the tarball, runs every test and the gate mutation check, and
   smoke-tests that exact tarball on Linux, Windows and macOS (Node 20.12 and 22).
3. **You approve.** The run stops at "Publish to npm (after Paul approves)". Open the run, read the summary (version,
   channel, commit, compatibility, every file with its sha256), then click **Review deployments → release → Approve**.
4. The workflow publishes with `--tag <channel>`, checks npm shows the same integrity, a provenance record and the
   channel, and only then creates the `cli-v<version>` tag and a GitHub pre-release (never marked Latest).

If a run fails halfway, use **Re-run failed jobs**. A version already on npm with the identical tarball is not
published again; verification and tagging resume. A different tarball under the same version stops the run.

## One-time setup (Paul)

Do these in order. Each one is a few clicks.

### A. GitHub (repository Viaknox/tune-up → Settings)

1. **Environments → New environment `release`.** Required reviewers: you. Deployment branches and tags: *Selected
   branches* → `main`. No secrets.
2. **A release GitHub App** (separate from `viaknox-claude`). Your profile → Settings → Developer settings → GitHub
   Apps → New. Name `viaknox-release`, no webhook, Repository permissions: **Contents: Read and write**, nothing else.
   Create it, note its App ID, **Generate a private key**, and install it on **Viaknox/tune-up only**.
3. **Environments → New environment `release-tag`.** No reviewers. Deployment branches: `main` only. Add variable
   `RELEASE_APP_ID` (the App ID) and secret `RELEASE_APP_PRIVATE_KEY` (the whole `.pem` file). Delete the downloaded
   `.pem` afterwards.
4. **Rules → Rulesets → New tag ruleset `cli-v create`.** **Enforcement status: Active** (a new ruleset starts as
   *Disabled*, which enforces nothing). Target tags matching `cli-v*`. Rule: *Restrict creations*. Bypass list: the
   `viaknox-release` App only.
5. **New tag ruleset `cli-v immutable`.** **Enforcement status: Active.** Target `cli-v*`. Rules: *Restrict updates*
   and *Restrict deletions*. Bypass list: empty (nobody, not even admins), so a published tag can never move.
   Check both: Rules → Rulesets lists `cli-v create` and `cli-v immutable` as **Active**.
6. **Branch protection on `main`** (docs/CLI-PLAN.md S0): require a pull request; require the status checks `engine`
   and `sast-check / scan` (each appears after it has run once on a PR); block force pushes and deletions; turn on
   *Do not allow bypassing the above settings*; *Require review from Code Owners* (`.github/CODEOWNERS` names you for
   the gate, tests, workflows and release files); *Dismiss stale pull request approvals when new commits are pushed*
   and *Require approval of the most recent reviewable push*. **Turn on the Code Owner rule only once Claude's PRs
   are opened by the `viaknox-claude` App** (S0a): GitHub never lets you approve a PR you authored, so while PRs
   are opened under your account that rule would block every one of them. Check: open a test PR that touches
   `.github/` and confirm it shows "Review required" from you and both checks as required.

### B. npm bootstrap (S8): the first publish is yours

npm can only set up trusted publishing for a package that already exists.

1. On npmjs.com: two-factor authentication on (Account → Two-Factor Authentication), recovery codes saved somewhere safe.
2. After the release PR that sets version `0.1.0-rc.0` is merged, open its `release` workflow run. It builds and tests
   the tarball but does not publish (that version is the bootstrap). Download the `agenttuneup-tarball` artifact and
   unzip it. Check its integrity against the run summary:
   `node -e "const c=require('crypto');console.log('sha512-'+c.createHash('sha512').update(require('fs').readFileSync('agenttuneup-0.1.0-rc.0.tgz')).digest('base64'))"`
3. Publish **that exact file**: `npm publish agenttuneup-0.1.0-rc.0.tgz --tag next --access public` (npm asks for your
   2FA code).
4. npmjs.com → agenttuneup → Settings → **Trusted publishing → GitHub Actions**: organization `Viaknox`, repository
   `tune-up`, workflow `release.yml`, environment `release`. **Allow direct publishing** for this configuration: since
   2026-09-03 a new configuration can only stage by default, and this workflow publishes directly after your GitHub
   approval. **Timing:** since 2026-10-02 a configuration that has not been used for a publish within 48 hours expires.
   So add it only when the first workflow release is ready: tell Claude, who opens the `0.1.0-rc.1` release PR at once;
   merge it and approve the run the same day. If it expired, delete the configuration and add it again, then re-run the
   failed publish job.
5. Same page → **Publishing access → "Require two-factor authentication and disallow tokens"**. Then revoke every npm
   access token that can publish (npmjs.com → Access Tokens), including the one in your local `.env`. After this,
   only the workflow (after your approval) or you with 2FA can publish.
6. Ownership, through an organization team (an org cannot be added with `npm owner add`, which takes a user):
   create or confirm the `viaknox` npm organization (this also reserves the `@viaknox` scope) and a team in it, for
   example `viaknox:release`, with you in it (add a second person with 2FA when there is one). Then grant the package:
   `npm access grant read-write viaknox:release agenttuneup` (or the package's Settings → access page on npmjs.com).
   Check with `npm access list collaborators agenttuneup` (the team shows `read-write`) and
   `npm access list packages viaknox:release` (lists `agenttuneup`). If npm refuses the grant for the unscoped name,
   stop and tell Claude: do not fall back to a personal second owner without deciding it on purpose.

Steps 1–3, 5 and 6 can be done any time; step 4 goes right before the first workflow release (see its timing note).

## If a bad version ships

1. Freeze: do not merge another release PR until the fix is ready.
2. `npm deprecate agenttuneup@<bad version> "<what is wrong, and which version to use>"` (needs your 2FA).
3. If `latest` ever points at the bad version, move it back: `npm dist-tag add agenttuneup@<good version> latest`.
4. Ship the fix as a **new** version through a release PR. Never unpublish and reuse a version, and never move or
   delete a `cli-v*` tag (the ruleset blocks it). Moving `latest` does not help anyone pinned to the bad version:
   the deprecation message is what tells them.
