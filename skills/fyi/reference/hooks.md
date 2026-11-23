# Hooks playbook (Claude Code, Codex, OpenCode)

`fyi` provides optional, project-scoped lifecycle hooks for **Claude Code**, **Codex CLI**, and **OpenCode** backed by one shared, read-only hook engine (`scripts/lib/hooks.mjs` + `hosts.mjs`, `hook-config.mjs`, `relevance.mjs`, `opencode-plugin.mjs`).

## Design boundaries

- **Read-only, non-blocking, fail-open.** Hooks never mutate `.fyi/`, never block prompts or tools, and always exit `0` on runtime errors (set `FYI_HOOK_DEBUG=1` to log diagnostics to stderr).
- **Precision-first prompt retrieval.** `prompt-submit` matches word boundaries with `Intl.Segmenter` (ASCII + CJK) and IDF weighting over metadata only (`title`, `tags`, `apps`, `description`), requires multi-term agreement (or an exact tag on short prompts), skips slash commands and explicit `fyi` prompts, excludes `deprecated`/`archived` artifacts, and reads the host transcript tail to avoid re-injecting the same artifact twice in one session.
- **Zero noise.** `session-start` stays silent in repos with neither `.fyi/` nor a local `fyi` skill, and skips `resume`. When both the Claude Code plugin and a project-local hook are installed, the plugin hook (`--source plugin`) yields to the project hook so nothing runs twice.
- **Edit-time hygiene, not per-turn nagging.** `post-tool-use` (and OpenCode `tool.execute.after`) only fires when a file inside `.fyi/` is edited, telling the agent directly to run `index` / `doctor` (or warning against hand-editing generated `INDEX.md` / `index.json`).
- **Capture stays with the skill.** Hooks surface context and reminders; the skill and user decide what to capture and redact.
- **Non-destructive config merges.** Installing or uninstalling preserves unrelated settings and hooks, refuses invalid JSON and symlinks, and never overwrites unmanaged `.opencode/plugins/fyi.js` without `--force`. When no project-local skill exists, Claude writes machine-specific absolute paths to `.claude/settings.local.json` instead of `.claude/settings.json`.

## What each host installs

| Host | Skill path | Hook integration | Lifecycle events |
|---|---|---|---|
| **Claude Code** | `.claude/skills/fyi/` | `.claude/settings.json` (or `.claude/settings.local.json` for absolute paths) | `SessionStart` (`startup\|clear\|compact`), `UserPromptSubmit`, `PostToolUse` (`Edit\|Write\|MultiEdit\|NotebookEdit`) |
| **Codex CLI** | `.agents/skills/fyi/` | `.codex/hooks.json` | `SessionStart`, `UserPromptSubmit`, `PostToolUse` (`apply_patch\|Edit\|Write`) |
| **OpenCode** | `.opencode/skills/fyi/` | `.opencode/plugins/fyi.js` | `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`, `tool.execute.before`/`after`, `event(session.idle)` |

### Host-specific notes

- **Codex CLI:** Local project hooks must be explicitly approved via `/hooks` after installing or updating `.codex/hooks.json` (Codex hashes the definition and skips unapproved changes). Codex commands use a repo-relative path (`node .agents/skills/fyi/scripts/fyi.mjs`), so launch Codex from the repository root. `fyi hook status` cannot inspect Codex's external trust store.
- **OpenCode:** OpenCode loads skills and `.opencode/plugins/` at startup — restart OpenCode after installing or updating hooks. The plugin caches store reads by `.fyi/` mtime fingerprint and shows each idle warning toast at most once per session.

## Commands

```bash
# Install skills + hooks + store for all three agents into another repo
fyi install /path/to/repo --agents all --hooks --init

# Install or refresh hooks in the current repo
fyi hook install --agents claude,codex,opencode

# Check installed skills, hooks, CLI paths, and version drift
fyi hook status

# Remove only fyi-managed hooks
fyi hook uninstall --agents all

# Test hook events locally
fyi hook run session-start --host claude
echo '{"prompt":"how do we trace a request id in api logs?"}' | fyi hook run prompt-submit --host codex
echo '{"tool_input":{"file_path":".fyi/patterns/trace.md"}}' | fyi hook run post-tool-use --host claude
```
