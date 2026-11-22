# Hooks playbook (Claude Code, Codex, OpenCode)

`fyi` provides optional, project-scoped lifecycle hooks for **Claude Code**, **Codex CLI**, and **OpenCode** backed by one shared, read-only hook engine (`scripts/lib/hooks.mjs`).

## Design boundaries

- **Read-only and non-blocking.** Hooks never mutate `.fyi/`, never block user prompts, and never trap the agent in a `Stop` loop (`stop_hook_active` is respected).
- **Zero noise.** `prompt-submit` only injects `<fyi-matches>` when high-confidence `.fyi/` artifacts match the user's prompt. `stop` stays silent unless `.fyi/` index or config needs attention.
- **Capture stays with the skill.** Hooks surface context and reminders; the skill and user decide what to capture and redact.
- **Non-destructive config merges.** Installing or uninstalling preserves unrelated settings and hooks in `.claude/settings.json` and `.codex/hooks.json`, and refuses to overwrite unmanaged `.opencode/plugins/fyi.js` without `--force`.

## What each host installs

| Host | Skill path | Hook integration | Lifecycle events |
|---|---|---|---|
| **Claude Code** | `.claude/skills/fyi/` | `.claude/settings.json` | `SessionStart`, `UserPromptSubmit`, `Stop` |
| **Codex CLI** | `.agents/skills/fyi/` | `.codex/hooks.json` | `SessionStart`, `UserPromptSubmit`, `Stop` |
| **OpenCode** | `.opencode/skills/fyi/` | `.opencode/plugins/fyi.js` | `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`, `event(session.idle)` |

## Commands

```bash
# Install skills + hooks + store for all three agents into another repo
fyi install /path/to/repo --agents all --hooks --init

# Install or refresh hooks in the current repo
fyi hook install --agents claude,codex,opencode

# Check installed skills and hooks
fyi hook status

# Remove only fyi-managed hooks
fyi hook uninstall --agents all

# Test a hook event locally
fyi hook run session-start --host claude
echo '{"prompt":"how do we trace a request id in api logs?"}' | fyi hook run prompt-submit --host codex
```
