# agenttuneup CLI changelog

One section per npm version, newest first. A release PR adds the section for its version; the release workflow uses it
for the approval summary and the GitHub release notes. Every section has a `Compatibility:` line: what changes for
someone upgrading (CLI options, report or gate.json schema, config, gate behaviour), or "none". 0.x rule: any such
change is a minor bump, never a patch. The plugin and skills have their own changelog in the repository root.

## 0.1.0-rc.0

The first package, published once by hand to set up npm trusted publishing (docs/RELEASING.md). Channel `next`.

- `check`, `run` and `tune`, installable with `npx agenttuneup@0.1.0-rc.0`.
- The strict CI gate (`--gate`, `--min`, `--max-undetermined`, `--allow-rules-fail`, `--json`), per docs/CLI-PLAN.md R1.

Compatibility: first release; nothing to upgrade from.
