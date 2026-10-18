# agenttuneup CLI changelog

One section per npm version, newest first. A release PR adds the section for its version; the release workflow uses it
for the approval summary and the GitHub release notes. Every section has a `Compatibility:` line: what changes for
someone upgrading (CLI options, report or gate.json schema, config, gate behaviour), or "none". 0.x rule: any such
change is a minor bump, never a patch. The plugin and skills have their own changelog in the repository root.

## 0.1.0-rc.3

Chats are never graded on part of a message. Channel `next`.

- A message that mixes readable text with a content part the parser does not know (a new provider part type, or a
  `null` entry) now makes the whole chat unreadable instead of being graded on the readable text alone. Known tool and
  reasoning parts are still dropped, and media still becomes `[image]`, `[file]`, `[audio]` or `[video]` (#41).

Compatibility: gate behaviour. Chats with an unknown content part next to readable text, which rc.2 judged, are now
unreadable, so a `--gate` run on such exports returns UNDETERMINED (exit 3) and lists them. No CLI option, report or
gate.json schema changed.

## 0.1.0-rc.2

Chat exports are read more completely. Channel `next`.

- A message with tool-call or tool-result parts (Claude `tool_use`/`tool_result`, OpenAI `function_call`), reasoning parts
  or server and MCP tool parts no longer makes the whole chat unreadable: those parts are dropped like tool turns. An
  OpenAI `refusal` part is read as the agent's words. Image, file, audio and video parts become `[image]`, `[file]`,
  `[audio]` or `[video]`, which the checks treat as something the user did. `content: []` is an empty turn. Object
  content, or a list of only unknown parts, is still unreadable (#38).

Compatibility: gate behaviour. Chats with those parts that used to count as unreadable (UNDETERMINED) are now judged,
so a `--gate` run on such exports can now PASS or FAIL. No CLI option, report or gate.json schema changed.

## 0.1.0-rc.1

The first release built, approved and published by the release workflow (trusted publishing, npm provenance, `cli-v`
tag). Channel `next`. Same CLI as 0.1.0-rc.0; only the release process and its documentation changed.

Compatibility: none.

## 0.1.0-rc.0

The first package, published once by hand to set up npm trusted publishing (docs/RELEASING.md). Channel `next`.

- `check`, `run` and `tune`, installable with `npx agenttuneup@0.1.0-rc.0`.
- The strict CI gate (`--gate`, `--min`, `--max-undetermined`, `--allow-rules-fail`, `--json`), per docs/CLI-PLAN.md R1.

Compatibility: first release; nothing to upgrade from.
