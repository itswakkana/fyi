# Contributing to fyi

Thank you for your interest in contributing to `fyi`!

## Guiding principles

1. **Zero dependencies.** Everything runs on plain Node 18+ ESM with standard library modules only (`node:fs`, `node:path`, `node:crypto`, etc.). Do not add npm dependencies or a `package.json` runtime dependency tree.
2. **Safety first.** All write operations must reject path traversal, refuse symlinked targets/parents, preserve unrelated user files/settings, and never mutate files outside the target project root.
3. **Read-only hooks.** Lifecycle hooks for Claude Code, Codex, and OpenCode must stay fast, read-only, non-blocking, and zero-noise. Capture decisions and secret redaction belong in the skill, not in background hooks.
4. **Files are the source of truth.** Never hand-edit `.fyi/INDEX.md` or `.fyi/index.json` — regenerate them with `fyi index`.

## Local development

Run the full test suite before opening a pull request:

```bash
node skills/fyi/scripts/selftest.mjs
node --test skills/fyi/scripts/*.test.mjs skills/fyi/scripts/*-test.mjs
node skills/fyi/scripts/fyi.mjs doctor
```

## Pull requests

- Keep changes focused and include tests for new behaviors or bug fixes.
- Update `README.md` and the relevant playbook under `skills/fyi/reference/` when adding commands, flags, or host integrations.
- Verify `git status` shows no unintended changes to `.fyi/`.

## Releasing to npm

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) automatically tests and publishes `@itswakkana/fyi` when a `v*` tag is pushed (supporting both npm Trusted Publishing via OIDC and `NPM_TOKEN`):

1. Bump the version in `package.json`, `skills/fyi/scripts/lib/util.mjs`, `skills/fyi/SKILL.md`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.
2. Update `CHANGELOG.md` and commit.
3. Tag and push: `git tag v1.0.0 && git push origin v1.0.0`.

