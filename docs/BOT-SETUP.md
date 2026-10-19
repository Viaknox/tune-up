# Letting an AI agent open PRs without letting it merge

Goal: the agent (Claude Code or similar) can push branches and open pull requests,
but nothing reaches `main` until a human approves. GitHub never lets a PR's author
approve their own PR, so the agent and the approving human must be different identities.
Pick the path that matches what you have.

| | Path A: two accounts | Path B: one account + GitHub App |
|---|---|---|
| You need | a second GitHub account for the agent, and an organization | a GitHub App installed on the repo |
| PR author | the agent's account | `<your-app>[bot]` |
| Who approves | your human account | you (your only account) |
| Agent can merge on its own | no | no |

Both paths use the same approval rule (step 1). Do that first.

## 1. The approval rule (both paths)

Organization → Settings → Rules → Rulesets → **New branch ruleset**
(or repository → Settings → Rules for a single repo):

- **Enforcement:** Active. **Bypass list:** empty.
- **Target:** default branch; for an org ruleset, **All repositories**.
- **Restrict deletions** and **Block force pushes**.
- **Require a pull request before merging:**
  - Required approvals: **1**
  - **Require approval of the most recent reviewable push** (a push after your approval needs a new one)
  - **Require conversation resolution before merging**
  - **Required reviewers:** a team containing only you (for example `approvers`), file patterns `*` and `**/*`, minimum 1.
    Only that team's approval counts, so another bot account approving does nothing.
- Add **Require status checks to pass** for your test job, so failing tests block the merge too.

## Path A: two accounts

1. Your human account is an organization **Owner** and the only member of the `approvers` team.
2. The agent's account is an organization **Member** (never Owner) and is **not** in `approvers`.
3. Give the agent Write on repositories without giving it to everyone:
   create a `bots` team, add the agent's account, then Organization → Settings →
   Organization roles → Role assignments → assign **All-repository write** to `bots`.
   Leave the organization's base permission at **Read**.
4. Sign the agent's tools in as the agent's account. It pushes branches and opens PRs; you approve as yourself.

Check: on any repository the agent's account shows Write (not Admin), and the ruleset says it cannot bypass.

## Path B: one account + GitHub App

Use this when you have a single GitHub account. The App, not you, is the PR author, so you can approve.

1. **Create the App:** Settings → Developer settings → GitHub Apps → New GitHub App.
   Permissions: **Pull requests: Read and write**, **Contents: Read-only**, nothing else. Webhook off.
   Install it on the repository only.
2. **Private key:** on the App's page, generate a private key. It downloads a `.pem` file; never paste it into a chat or commit it.
3. **Environment:** repository → Settings → Environments → new environment `pr-bot`.
   - Deployment branches: **Selected branches → `main` only.** This is what keeps the key safe:
     only the workflow as merged on `main` can read it, so a PR that edits the workflow cannot.
   - Add secret `CLAUDE_APP_PRIVATE_KEY` (the `.pem` contents) and variable `CLAUDE_APP_ID` (the App ID).
   - **No required reviewers.** The App can only open PRs; your approval on the PR is the gate.
     A reviewer here only makes you approve twice.
4. **Workflow:** copy [`.github/workflows/open-pr-as-bot.yml`](../.github/workflows/open-pr-as-bot.yml) to `main` (through a PR you approve).
5. **Use:** the agent pushes a branch, then dispatches the workflow on `main`:

   ```sh
   gh api -X POST repos/OWNER/REPO/actions/workflows/open-pr-as-bot.yml/dispatches \
     -f ref=main -f "inputs[branch]=my-branch" -f "inputs[title]=My change" -f "inputs[body]=Why and what"
   ```

   The PR appears with the App as author; you review and approve as yourself.

Check: the PR's author is `<your-app>[bot]`, and its merge box says your approval is required.

## Things that quietly break this

- **The agent's account is an Admin or Owner.** It cannot bypass an empty bypass list, but it can edit or delete the rule.
- **The agent's account is in the approvers team, or is a listed code owner.** Its approval then counts as yours.
- **Code-owner review is required and the only code owner is the agent.** No one can approve its PRs; turn code-owner review off and rely on the required-reviewers team.
- **A second required reviewer on `pr-bot`.** Not unsafe, just two approvals per PR.
