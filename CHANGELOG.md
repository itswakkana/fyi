# Changelog

All notable changes to `fyi` are documented in this file.

## [1.0.0] - 2026-11-22

### Added
- Zero-dependency Node 18+ ESM CLI and Agent Skill under `skills/fyi/` backed by a version-controlled `.fyi/` knowledge store.
- Unified multi-agent lifecycle hook engine (`skills/fyi/scripts/lib/hooks.mjs`) and `fyi hook` command (`install`, `uninstall`, `status`, `run`) supporting **Claude Code**, **Codex CLI**, and **OpenCode** together.
- Multi-agent installer (`fyi install <repo> --agents claude,codex,opencode|all --hooks --init`).
- Claude Code plugin & marketplace manifests (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.claude-plugin/hooks/hooks.json`).
- Zero-dependency OpenCode ESM plugin generator (`.opencode/plugins/fyi.js`) wiring `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`, and `event(session.idle)`.
- Full artifact lifecycle (`init`, `context`, `new`, `find`, `list`, `show`, `index`, `organize`, `doctor`), YAML frontmatter & script metadata parser, high-confidence secret scanner, symlink/path-traversal guards, GitHub Actions CI, and 131 automated checks (`selftest.mjs` + `node --test`).
