# Changelog

All notable changes to `fyi` are documented in this file.

## [1.0.1] - 2026-11-23

### Changed
- **Precision-first prompt relevance (`scripts/lib/relevance.mjs`):** Replaced raw substring body search in `prompt-submit` hooks with `Intl.Segmenter` word-boundary tokenization (ASCII + CJK), light English stemming, IDF weighting over metadata only (`title`, `tags`, `apps`, `description`), and multi-term gating. Excludes `deprecated`/`archived` artifacts, labels `draft`/`stale` matches, and skips slash commands or explicit `fyi` prompts.
- **Edit-time index hygiene (`PostToolUse`):** Moved stale-index and generated-file reminders from per-turn `Stop` hooks to `PostToolUse` (Claude Code `Edit|Write|MultiEdit|NotebookEdit`, Codex `apply_patch|Edit|Write`, OpenCode `tool.execute.after`) so the agent is nudged directly only when `.fyi/` files are modified. Legacy `Stop` hook configs remain compatible and are flagged by `doctor`/`hook status` for refresh.
- **Zero-noise session lifecycle:** `session-start` now stays silent in repos that have neither `.fyi/` nor a local `fyi` skill, skips `resume` sessions (`matcher: "startup|clear|compact"` on Claude), emits absolute CLI + `--root` paths at runtime, and yields automatically (`--source plugin`) when both the Claude Code plugin and project-local hooks are installed.
- **In-session prompt deduplication:** `prompt-submit` reads the host transcript tail (`transcript_path`) to avoid re-injecting the same artifact id twice in one session.
- **Modular hook architecture & shared store snapshot:** Split `hooks.mjs` into focused modules (`hosts.mjs`, `hook-config.mjs`, `relevance.mjs`, `opencode-plugin.mjs`, with `hooks.mjs` as the engine facade) and added `store.snapshot()` shared by `context`, `doctor`, and hooks.
- **Safer host integration & diagnostics:** Claude writes machine-local absolute hook paths to `.claude/settings.local.json` instead of `.claude/settings.json`; `inspectIntegrations` / `doctor` validate the actual configured CLI path in hook commands and detect local skill version drift across agents; OpenCode plugin caches store reads by `.fyi/` mtime fingerprint and deduplicates idle toasts per session; `hook run` fails open (`exit 0`, with opt-in `FYI_HOOK_DEBUG=1`), prefers `CLAUDE_PROJECT_DIR` over nested `cwd`, and uses a 5s hook timeout.

## [1.0.0] - 2026-11-22

### Added
- Zero-dependency Node 18+ ESM CLI and Agent Skill under `skills/fyi/` backed by a version-controlled `.fyi/` knowledge store.
- Unified multi-agent lifecycle hook engine (`skills/fyi/scripts/lib/hooks.mjs`) and `fyi hook` command (`install`, `uninstall`, `status`, `run`) supporting **Claude Code**, **Codex CLI**, and **OpenCode** together.
- Multi-agent installer (`fyi install <repo> --agents claude,codex,opencode|all --hooks --init`).
- Claude Code plugin & marketplace manifests (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.claude-plugin/hooks/hooks.json`).
- Zero-dependency OpenCode ESM plugin generator (`.opencode/plugins/fyi.js`) wiring `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`, and `event(session.idle)`.
- Full artifact lifecycle (`init`, `context`, `new`, `find`, `list`, `show`, `index`, `organize`, `doctor`), YAML frontmatter & script metadata parser, high-confidence secret scanner, symlink/path-traversal guards, GitHub Actions CI, and 131 automated checks (`selftest.mjs` + `node --test`).
