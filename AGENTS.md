# AGENTS.md

Guidance for coding agents working in this repository.

## Repository layout

- `skills/fyi/` — canonical skill source (`SKILL.md`, `reference/` playbooks, and zero-dependency Node 18+ ESM CLI under `scripts/`).
- `.claude-plugin/` — Claude Code plugin & marketplace manifests (`plugin.json`, `marketplace.json`, `hooks/hooks.json`).
- `.fyi/` — this repository's own dogfooding knowledge store.
- `.github/` — CI workflows.

## Rules

1. **Zero dependencies.** Only Node 18+ built-in modules (`node:*`). Never add npm runtime dependencies.
2. **Keep versions in sync.** When bumping the release version, update `package.json`, `VERSION` in `skills/fyi/scripts/lib/util.mjs`, `skills/fyi/SKILL.md`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.
3. **Safety invariants.** Every write command must reject path traversal, refuse symlinked targets and parent directories, preserve unrelated user config/hooks, and leave `.fyi/` untouched during tests.
4. **Read-only hooks.** Lifecycle hooks for Claude Code, Codex CLI, and OpenCode must stay read-only, non-blocking, and zero-noise.
5. **Verify before finishing:**

```bash
node skills/fyi/scripts/selftest.mjs
node --test skills/fyi/scripts/*.test.mjs skills/fyi/scripts/*-test.mjs
node skills/fyi/scripts/fyi.mjs doctor
```
