# Store schema

One concept per file. Every artifact has YAML frontmatter and a Markdown body, except scripts, which carry the same frontmatter in a leading comment.

## Frontmatter fields

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `pattern`, `knowledge`, `runbook`, `doc`, or `script` |
| `title` | yes | The symptom or concept, in the words someone would search |
| `description` | recommended | One line; used by search and the index |
| `apps` | recommended | App names from `.fyi/config.json`; empty or `[shared]` for cross-app |
| `tags` | recommended | Lowercase search terms: `logs`, `tracing`, `billing` |
| `owner` | optional | Person or team accountable for accuracy |
| `status` | yes | `active`, `draft`, `stale`, or `deprecated` |
| `updated` | yes | `YYYY-MM-DD`; last write or confirmation |
| `related` | optional | Artifact ids, e.g. `knowledge/api/overview` |

Ids are derived from the path under `.fyi/` without the extension:

```
.fyi/patterns/trace-request.md        -> patterns/trace-request
.fyi/knowledge/api/refunds.md         -> knowledge/api/refunds
.fyi/scripts/dump-slow-queries.mjs    -> scripts/dump-slow-queries
```

Do not write an `id` field. It would drift from the path.

## Layout rules

- `knowledge/<app>/<slug>.md` for one app; `knowledge/shared/<slug>.md` for cross-app.
- Cross-app knowledge uses `apps: []` or `apps: [shared]`. `shared` is a reserved scope, not an app that must appear in `config.json`.
- `patterns/`, `runbooks/`, `docs/`, `scripts/` are flat. Use `apps` and `tags` for scoping.
- The directory is authoritative for an artifact's type. A `type:` field that disagrees with the directory is reported by `doctor` and the directory wins.
- Slugs are lowercase and Unicode-aware, generated from the title. Renaming a file changes its id; update every `related` link.
- Archive by moving the file to `.fyi/archive/` and setting `status: deprecated`. Archiving changes the id to `archive/<name>`, so update inbound `related` links. Do not delete unless the user asks.

## Type selection

| If the artifact is… | Type |
|---|---|
| A way to investigate: log query, trace path, repro, dashboard drill-down | `pattern` |
| A durable fact: ownership, business rule, contract, invariant, glossary | `knowledge` |
| A procedure run under pressure: deploy, rollback, incident, migration | `runbook` |
| A document or a pointer: spec, ADR, API contract, external link | `doc` |
| A runnable helper with arguments and output | `script` |

If it contains both a fact and a procedure, split it: `knowledge` for the fact, `pattern` or `runbook` for the procedure, linked with `related`.

## Markdown artifact

````markdown
---
type: pattern
title: Trace a request across services
description: Follow one request id through gateway, api, and worker logs.
apps: [api, worker]
tags: [logs, tracing, debugging]
owner: Ryan
status: active
updated: 2026-11-10
related: [knowledge/shared/request-ids]
---

# Trace a request across services

## When to use

A request fails or slows and you need the full path, not one service's log.

## Prerequisites

- Access to the log dashboard
- The `x-request-id` header from the client or gateway

## Steps

1. Grab the request id from the gateway access log.
2. Search each service with that id.
3. Order matches by timestamp; the first error is usually the cause.

## Commands

```bash
# Replace <id> and <env>.
curl -s "https://logs.<env>.example/search?q=%22<id>%22"
```

## Expected signals

- `gateway` logs the id at ingress.
- `api` logs it on every outbound call.
- `worker` logs it once per job.

## Gotchas

- Retries reuse the id; count attempts before concluding there are duplicates.
- The worker truncates ids in one older log format.

## Related

- knowledge/shared/request-ids
````

## Script artifact

JavaScript, shell, Python, and Ruby scripts use line-comment frontmatter. The CLI writes it for you; do not hand-roll it.

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

// Usage: node .fyi/scripts/dump-slow-queries.mjs --app api --hour 2026-11-10T14
//
// What it does:
//   Prints the slowest queries for one app and hour.
//
// Output:
//   One line per query: duration, statement, count.
```

Shell, Python, and Ruby use the same block with `# ---` markers:

```sh
#!/usr/bin/env bash
# ---
# type: script
# title: Dump slow queries
# apps: [api]
# tags: [database]
# status: active
# updated: 2026-11-10
# ---
```

A leading block comment (`/** ... */`) with `---` fences is accepted for compatibility, but line comments are preferred: a metadata value containing `*/` cannot break them.

A script's metadata block must be the first content after the shebang and must contain at least two known keys. A `---` section divider further down the file is never mistaken for metadata, and a divider that happens to contain a `title:` line is left alone.

When `fyi new script --file <source>` finds existing frontmatter, it merges the requested title, apps, tags, owner, and `related` into that block and preserves `status` unless `--status` is passed. If the existing block contains nested maps, folded/literal scalars, or other unsupported YAML, `new` refuses instead of rewriting it; remove the block or edit the script manually.

## YAML subset

The CLI reads a small YAML subset: scalars, quoted strings, inline arrays, and block arrays. It does not parse nested maps or folded/literal scalars. This is deliberate and safe because updates are surgical:

- `fyi organize --fix` inserts or replaces only the `updated:` line inside the existing frontmatter block. Every other line and the file's line endings are preserved, so hand-written constructs survive.
- A Markdown file that opens with `---` is only treated as an artifact when the block contains at least one known key. A document that merely starts with a horizontal rule is never rewritten.
- Nested fields are preserved on disk but are not indexed. Keep the supported fields at the top level so search and validation can see them.
- Quote values that contain `:`, `#`, `[`, `]`, `{`, `}`, `,`, `---`, or a newline. `fyi new` does this automatically.
- Numeric-looking values keep their formatting: `007` stays `007` and `1.0` stays `1.0` rather than becoming numbers.

## Generated files

| File | Generated by | Edit by hand? |
|---|---|---|
| `.fyi/INDEX.md` | `fyi index` | No |
| `.fyi/index.json` | `fyi index` | No |
| `.fyi/config.json` | `fyi init` | Yes, but prefer `init --refresh` |

`index.json` stores a content hash per artifact. `fyi doctor` and `fyi context` report the index as stale when an artifact's content or metadata changes after the last rebuild.

## Templates

`fyi new` writes a type-specific skeleton with these sections:

- `pattern`: When to use, Prerequisites, Steps, Commands, Expected signals, Gotchas, Related
- `knowledge`: Summary, Facts, Implications, Sources, Open questions
- `runbook`: Trigger, Preconditions, Steps, Verify, Rollback, Escalation
- `doc`: Summary, Key points, Source, Related
- `script`: metadata plus Usage, What it does, Output

Keep the headings unless the artifact genuinely needs a different shape. Predictable structure is what makes the store skimmable.
