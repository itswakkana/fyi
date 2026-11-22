---
name: fyi
description: "Use when a task needs project knowledge that lives outside the code: how to trace a request across services, which logs or queries to search, who owns a module, how a business flow or rule works, how to deploy or roll back, how to respond to an incident, how to onboard onto a module, or when a debugging session produced a reusable recipe worth saving. Also use when the user asks to find, save, organize, audit, or initialize the project's .fyi knowledge store. Built for multi-app monorepos where one developer's discovery should become everyone's starting point. Not for ordinary code edits, design work, or general web research."
version: 1.0.0
user-invocable: true
argument-hint: "[context · find <query> · new <type> <title> · init · organize · doctor · hook · list · show · index · install]"
license: MIT
---

`fyi` is the project's shared memory: a version-controlled `.fyi/` store of reusable investigation patterns, business knowledge, runbooks, documents, and scripts. The store is read by people and agents; this skill is the read/write interface.

The problem it solves: in a multi-app repo, the person who debugs an issue learns how to search the logs, which IDs tie the flow together, and which service owns the failure. That knowledge usually stays in their head or a chat thread. `fyi` makes it a file the next person and the next agent find first.

## Setup

1. Identify the target project root from the workspace and user request. Run `node <skill-base-dir>/scripts/fyi.mjs context --root <project-root>` once per session. `<skill-base-dir>` is the directory containing this SKILL.md; it may be outside the target project. Reuse this result in the playbooks.
2. **Wherever the playbooks write `fyi <verb>`, run `node <skill-base-dir>/scripts/fyi.mjs <verb> --root <project-root>`** unless a `fyi` executable is on PATH. The skill does not install a global command.
3. Prepare the store before searching or capturing: run `init` for a missing store, missing config, or missing directories/overviews; run `index` for a stale catalog. These repairs preserve existing artifacts. If config exists but is unreadable, report the error and leave it intact. On an ordinary task, use CLI initialization directly, report “Created .fyi; no prior knowledge yet,” and continue the task. Reserve the [init playbook](reference/init.md) for explicit setup or onboarding requests.
4. If the user requested read-only work or prohibited initialization, inspect any existing store without repairs and continue the task if it is unavailable. State the limitation. An empty initialized store or a search with no matches is a knowledge gap, not a blocked task. After solving, apply the capture rule below.
5. Load the playbook for the request: [init](reference/init.md), [find](reference/find.md), [save](reference/save.md), [organize](reference/organize.md), [doctor](reference/doctor.md), [hooks](reference/hooks.md), or [schema](reference/schema.md).

## Core rules

1. **Search before solving.** For any debugging, tracing, "how does X work", "who owns X", or onboarding request, run `find` before re-deriving the answer. If a pattern exists, follow it. Say which artifact you used.
2. **Capture after solving.** When a session produces a recipe someone else could reuse — a log query, a trace path, a repro, a business rule confirmed by a person — save it. Save without asking when the user says "remember", "save", or "document this"; otherwise offer it in one line.
3. **The repo is evidence; people are authority.** Never invent owners, business rules, thresholds, or runbook steps. Mark unknowns as open questions.
4. **One artifact per concept.** Search first, then update the canonical file. Do not create a near-duplicate.
5. **Generated files are read-only.** `INDEX.md` and `index.json` come from `fyi index`. Never hand-edit them.
6. **No secrets, no raw logs.** Store the query and the reasoning, not credentials, tokens, customer data, or log dumps. Redact before writing.
7. **Write for a stranger.** Exact copy-pasteable commands, explicit `<placeholders>`, expected signals, and the failure modes you hit.

## Store layout

| Path | Holds |
|---|---|
| `.fyi/knowledge/<app>/` | App-scoped facts: ownership, flows, invariants, contracts |
| `.fyi/knowledge/shared/` | Cross-app facts: glossary, environment, architecture |
| `.fyi/patterns/` | Reusable investigation recipes: log searches, traces, repros |
| `.fyi/runbooks/` | Operational procedures: deploy, rollback, incident, migration |
| `.fyi/docs/` | Durable documents and pointers to specs, ADRs, contracts |
| `.fyi/scripts/` | Runnable helpers with metadata and usage notes |
| `.fyi/archive/` | Retired artifacts, kept for history |
| `.fyi/INDEX.md`, `.fyi/index.json` | Generated catalog. Do not edit. |
| `.fyi/config.json` | Schema version, detected apps, settings |

An artifact is one Markdown file with YAML frontmatter, or one script with the same frontmatter in a leading comment. Full field list and examples: [reference/schema.md](reference/schema.md).

## Commands

Run from the project root:

| Command | Purpose |
|---|---|
| `fyi context` | Store state, counts, session directives. Run first. |
| `fyi init [--refresh]` | Detect apps, create or repair `.fyi/`, seed app overview stubs. |
| `fyi new <type> "<title>"` | Create an artifact. Aliases: `save`, `add`, `capture`. |
| `fyi find "<query>"` | Ranked search across title, tags, apps, body. |
| `fyi list` | Catalog grouped by type. |
| `fyi show <id\|path\|title>` | Print one artifact. |
| `fyi index` | Rebuild `index.json` and `INDEX.md`. |
| `fyi organize [--fix]` | Report duplicates, stale files, missing metadata; apply safe fixes. |
| `fyi doctor` | Health check; exits 1 on errors. |
| `fyi hook <action>` | Install, uninstall, inspect, or run hooks for Claude Code, Codex, and OpenCode. |

Useful flags: `--app`, `--tag`, `--type`, `--status`, `--owner`, `--description`, `--title`, `--file`, `--ext`, `--related`, `--agents`, `--hooks`, `--host`, `--dry-run`, `--refresh`, `--include-packages`, `--fix`, `--force`, `--json`, `--limit`, `--root`, `--include-archived`.

Types: `pattern` (investigation recipe), `knowledge` (durable fact), `runbook` (procedure), `doc` (document or pointer), `script` (runnable helper).

## Routing

- **No argument or "what is fyi":** run `context`, then present the store state and the four most useful next actions. Do not auto-run a capture.
- **Debugging, tracing, "how do we find…", "who owns…", onboarding:** [find](reference/find.md). Search first; solve only after the store comes up empty.
- **"Remember this", "save this", "document this", or a solved reusable problem:** [save](reference/save.md).
- **"Clean up / organize / dedupe / this is stale":** [organize](reference/organize.md).
- **"Is the store healthy / out of date / broken":** [doctor](reference/doctor.md).
- **"Set up fyi / onboard this repo":** [init](reference/init.md).
- **Schema or format question:** [schema](reference/schema.md).

If a request spans two flows, search first, then save what the search produced.

## Capture quality bar

Before writing, the artifact must answer:

- **When do I use this?** A concrete symptom or task, not a topic.
- **What do I need first?** Access, tools, IDs, environment.
- **What exactly do I run?** Copy-pasteable commands with explicit placeholders.
- **What proves it worked?** Log lines, fields, status codes, expected output.
- **What goes wrong?** The gotchas the discoverer hit.
- **Who confirmed it?** Owner, source, ticket, or dashboard.

If the answer is a single command with no reasoning, save it as a `script` instead. If it is a fact with no procedure, save it as `knowledge`. If it is a procedure someone executes under pressure, save it as a `runbook`.

## Verification

After a capture, `fyi show <id>` must print the artifact, `fyi doctor` must exit 0 with no errors, and `fyi find "<the symptom>"` must rank it. Warnings from `doctor` are not success: review and resolve them. If the artifact does not rank, the title and tags are wrong for the next person.
