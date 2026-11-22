# fyi

**Project memory for multi-app repos — shared by humans, Claude Code, Codex CLI, and OpenCode.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#design-decisions)
[![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20OpenCode-6f42c1.svg)](#multi-agent-support-and-hooks)

In a monorepo where each developer owns a few modules, debugging crosses boundaries. The person who traces a failed request learns which log query works, which ID ties the flow together, and which service actually owns the error. That knowledge usually dies in a chat thread. `fyi` turns it into a version-controlled file the next person — and the next agent — finds first.

Inspired by [Impeccable](https://github.com/pbakaus/impeccable) and structured as a standalone skill repository: a clean `skills/fyi/` source directory, plugin/tooling metadata under `.claude-plugin/`, `.github/`, and `.fyi/`, and optional read-only lifecycle hooks for **Claude Code**, **Codex CLI**, and **OpenCode**.

```text
  Claude Code (.claude/skills/fyi + .claude/settings.json)  ──┐
  Codex CLI   (.agents/skills/fyi + .codex/hooks.json)      ──┼──▶ fyi CLI & hook engine ──▶ .fyi/ store (git)
  OpenCode    (.opencode/skills/fyi + .opencode/plugins/)   ──┘
```

## Why files

- **Shareable through git.** Review a captured debugging recipe in a PR like code.
- **Readable without infrastructure.** No database, no server, no sync service.
- **Agent-native.** Markdown with YAML frontmatter is what LLMs read and edit best.
- **Diffable.** A changed business rule shows up as a changed line with an author and a date.
- **Zero dependencies.** Plain ESM on Node 18+ — no `npm install`, no lockfile, no build step.

## Install

Requires **Node 18+**.

### 1. Install skills + hooks + `.fyi/` store into any repo (recommended)

Run directly with `npx` or `bunx` (no `git clone` required):

```bash
# Install for Claude Code, Codex CLI, and OpenCode together
npx @itswakkana/fyi install . --agents all --hooks --init
# or with Bun
bunx @itswakkana/fyi install . --agents all --hooks --init
# or directly from GitHub
npx github:itswakkana/fyi install . --agents all --hooks --init
```

Target specific agents if you only use a subset (`--agents` defaults to `claude` when omitted):

```bash
# Claude Code + Codex with hooks
npx @itswakkana/fyi install . --agents claude,codex --hooks --init

# Skills only (no hooks)
npx @itswakkana/fyi install . --agents all --init
```

### 2. Install via `skills` CLI or Claude Code plugin

```bash
# Install the skill via the Agent Skills CLI
npx skills add itswakkana/fyi
```

Or add this repository as a Claude Code plugin (uses `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`).

### 3. Add or inspect hooks in an existing repo

Run from your repo root using whichever skill path is installed (`.claude/skills/fyi`, `.agents/skills/fyi`, or `.opencode/skills/fyi`):

```bash
node .claude/skills/fyi/scripts/fyi.mjs hook install --agents all
node .claude/skills/fyi/scripts/fyi.mjs hook status
```

> **Note:** OpenCode loads skills and `.opencode/plugins/` at startup — restart OpenCode after installing or updating hooks.

> **Tip:** Commands below are written as `fyi ...`. Because `fyi` installs no global binary, run `node skills/fyi/scripts/fyi.mjs ...` (in this repo) or `node .claude/skills/fyi/scripts/fyi.mjs ...` (in a target repo), or alias `fyi` in your shell.

The CLI walks upward from the current working directory and stops at the nearest project boundary: `.fyi/`, `.git` (directory or worktree file), `.claude/skills/fyi`, `.agents/skills/fyi`, or `.opencode/skills/fyi`. Pass `--root /path/to/repo` to target a repository explicitly.

## Multi-agent support and hooks

| Agent | Installed skill path | Lifecycle hook config | Wired events |
|---|---|---|---|
| **Claude Code** | `.claude/skills/fyi/` (+ `.claude-plugin/`) | `.claude/settings.json` (non-destructive merge) | `SessionStart`, `UserPromptSubmit`, `Stop` |
| **Codex CLI** | `.agents/skills/fyi/` | `.codex/hooks.json` (non-destructive merge) | `SessionStart`, `UserPromptSubmit`, `Stop` |
| **OpenCode** | `.opencode/skills/fyi/` | `.opencode/plugins/fyi.js` (zero-dependency ESM plugin) | `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`, `event(session.idle)` |

All three hosts share one read-only hook engine ([skills/fyi/scripts/lib/hooks.mjs](skills/fyi/scripts/lib/hooks.mjs)):

1. **Session context:** Injects a compact `<fyi-context>` block with store status, detected apps, artifact counts, CLI path, and core search/capture rules.
2. **Zero-noise prompt matching:** On each prompt, runs a fast local search against `.fyi/` and injects `<fyi-matches>` only when high-confidence artifacts match. Unrelated coding prompts stay completely silent.
3. **Non-blocking turn hygiene:** On `Stop` / `session.idle`, respects `stop_hook_active` (never loops, never blocks) and stays silent unless `.fyi/` index is stale or config has issues.
4. **Safe config management:** `fyi hook install` and `fyi hook uninstall` preserve all unrelated user settings and hooks, refuse invalid JSON and symlinks, and never overwrite unmanaged OpenCode plugins without `--force`.

Knowledge capture and redaction always stay with the skill and developer — hooks never auto-save raw transcripts.

## Quick start

```bash
# 1. Detect apps and initialize .fyi/
node .claude/skills/fyi/scripts/fyi.mjs init

# 2. Capture a debugging recipe someone just figured out
node .claude/skills/fyi/scripts/fyi.mjs new pattern \
  "Trace a request across services" \
  --app api --app worker \
  --tag logs --tag tracing \
  --description "Follow one request id through gateway, api, and worker logs."

# 3. Fill in the generated Markdown sections:
#    .fyi/patterns/trace-a-request-across-services.md

# 4. Search before the next debugging session
node .claude/skills/fyi/scripts/fyi.mjs find "request id logs" --app api
```

Inside Claude Code, Codex, or OpenCode, just ask: *"how do we trace a request across services?"* — the hook surfaces matching artifacts immediately, the skill searches `.fyi/` first, and *"save this as a pattern"* captures new recipes.

## Repository layout

```text
fyi/
├── skills/
│   └── fyi/                 the skill: SKILL.md, reference playbooks, Node CLI & tests
├── .claude-plugin/          Claude Code plugin, marketplace, and bundled hooks manifest
├── .fyi/                    this repository's own knowledge store
├── .github/                 CI workflows
├── AGENTS.md                guidance for coding agents working in this repo
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

## Commands

| Command | Purpose |
|---|---|
| `fyi context` | Store state, counts, active agent integrations, and session directives. |
| `fyi init [--refresh]` | Detect apps, create or repair `.fyi/`, seed draft app overviews. |
| `fyi new <type> "<title>"` | Capture an artifact (aliases: `save`, `add`, `capture`). |
| `fyi find "<query>"` | Ranked search over title, description, tags, apps, and body (alias: `search`). |
| `fyi list` | Catalog grouped by type (alias: `ls`). |
| `fyi show <id\|path\|title>` | Print one artifact (alias: `cat`). |
| `fyi index` | Rebuild `index.json` and `INDEX.md`. |
| `fyi organize [--fix]` | Report duplicates, stale files, missing metadata; apply surgical safe fixes. |
| `fyi doctor` | Health check (artifacts, secrets, index, hooks); exits `1` on errors. |
| `fyi hook <action>` | `install`, `uninstall`, `status`, or `run` hooks for Claude, Codex, and OpenCode. |
| `fyi install <repo>` | Install skills (and optional `--hooks` / `--init`) into another repository. |

Flags: `--app`, `--tag`, `--type`, `--status`, `--owner`, `--description`, `--title`, `--file`, `--ext`, `--related`, `--agents`, `--hooks`, `--host`, `--dry-run`, `--refresh`, `--include-packages`, `--fix`, `--force`, `--init`, `--json`, `--limit`, `--root`, `--include-archived`.

## Store layout

```text
.fyi/
  config.json              schema, detected apps, settings
  INDEX.md                 generated catalog (do not edit)
  index.json               generated machine index (do not edit)
  README.md                directory guide
  knowledge/
    <app>/overview.md      what the app is, owns, depends on
    shared/                cross-app facts: glossary, environments, contracts
  patterns/                reusable investigation recipes
  runbooks/                deploy, rollback, incident, migration
  docs/                    durable documents and pointers
  scripts/                 runnable helpers with metadata
  archive/                 retired artifacts
```

### Artifact types

| Type | Use it when… | Example |
|---|---|---|
| `pattern` | You solved an investigation once and want it repeatable | "Find the failed job by request id" |
| `knowledge` | A fact is durable and confirmed by a person | "Refunds settle at midnight in the billing timezone" |
| `runbook` | Someone must execute steps under pressure | "Roll back the API deploy" |
| `doc` | A document or pointer must survive | "ADR-014: event bus migration" |
| `script` | The reusable thing is a runnable command | "Dump slow queries for an hour" |

One concept per file. If an artifact mixes a fact and a procedure, split them and link with `related`.

### Artifact format

Markdown artifacts use YAML frontmatter:

```markdown
---
type: pattern
title: Trace a request across services
description: Follow one request id through gateway, api, and worker logs.
apps: [api, worker]
tags: [logs, tracing]
owner: Ryan
status: active
updated: 2026-11-10
related: [knowledge/shared/request-ids]
---

# Trace a request across services

## When to use
...
```

Scripts carry the same metadata in leading comments so they remain directly executable:

```js
#!/usr/bin/env node
// ---
// type: script
// title: Dump slow queries
// description: Print the slowest queries for one app and hour.
// apps: [api]
// tags: [database, performance]
// owner: Ryan
// status: active
// updated: 2026-11-10
// related: []
// ---
```

## Design decisions

- **Markdown + frontmatter, not a database.** Reviewable in PRs, readable by any tool, no sync service.
- **Generated index, never hand-edited.** `INDEX.md` and `index.json` are rebuilt atomically from files with content hashes to detect drift.
- **Surgical updates, not round-trips.** `organize --fix` edits only the `updated` line, preserving every other line and line ending.
- **Zero dependencies.** Plain ESM on Node 18+. No install step, no lockfile.
- **App detection is evidence, not truth.** The CLI scans workspaces and manifests and seeds draft overviews; owners and business rules are never invented.
- **Secrets are errors, not warnings.** `doctor` fails on high-confidence secret shapes anywhere in a file, including frontmatter. Placeholders (`<...>`, `{{...}}`) are ignored; the word "example" elsewhere on the line does not hide a real key.
- **Symlink- and traversal-safe.** Every write command refuses symlinked stores, directories, indexes, and hook config targets.
- **Archive, don't delete.** Retired knowledge keeps its history under `.fyi/archive/`.
- **The CLI is the interface; the skill is the judgment.** Hooks and CLI handle structure, search, and validation; the agent handles meaning and redaction.

## Development

```bash
# Run the end-to-end self-test (108 checks in an isolated temp fixture)
node skills/fyi/scripts/selftest.mjs

# Run unit & integration test suites (frontmatter, index, repo, root, safety, multi-agent hooks)
node --test skills/fyi/scripts/*.test.mjs skills/fyi/scripts/*-test.mjs

# Check the repository's own .fyi/ store
node skills/fyi/scripts/fyi.mjs doctor
```

All tests run in isolated temporary directories and assert that the repository's own `.fyi/` store remains untouched.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for guidelines, invariants, and test requirements.

## License

[MIT](LICENSE)
