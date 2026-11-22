# Save flow

Capture knowledge so the next person starts where you finished.

## Step 1: Decide the type

| The reusable thing is… | Type |
|---|---|
| A way to investigate: log query, trace, repro, dashboard drill-down | `pattern` |
| A durable fact: ownership, business rule, contract, invariant, glossary | `knowledge` |
| A procedure run under pressure: deploy, rollback, incident, migration | `runbook` |
| A document or pointer: spec, ADR, API contract, external link | `doc` |
| A runnable helper with arguments and output | `script` |

If it is a fact plus a procedure, split it and link the two with `related`. Do not write an essay that is half glossary and half runbook.

## Step 2: Search before writing

```bash
fyi find "<the symptom or concept>"
fyi find "<same thing>" --type <type>
```

If a canonical artifact exists, update it in place: correct the steps, add the gotcha, bump `updated`, and set `status: active` only if a person confirmed it. Edit only the fields you are changing, then run `fyi index`; `fyi organize --fix` can stamp a missing `updated` without rewriting the rest of the file. If two near-duplicates exist, merge them first (see [organize](organize.md)).

## Step 3: Collect evidence

You need, at minimum:

- **Trigger:** the concrete symptom or task.
- **Prerequisites:** access, tools, IDs, environment.
- **Procedure:** ordered steps with exact commands.
- **Signals:** what proves it worked.
- **Gotchas:** what failed while discovering it.
- **Source:** the owner, ticket, dashboard, or person who confirmed it.

Infer from the session and the repo where you can. Ask only for facts you cannot verify — typically the owner and whether a business rule is authoritative. Do not ask the user to restate what they just showed you.

## Step 4: Create the file

```bash
fyi new pattern "Trace a request across services" \
  --app api --app worker \
  --tag logs --tag tracing \
  --owner "<name>" \
  --description "Follow one request id through gateway, api, and worker logs."

fyi new knowledge "Refund settlement rule" --app billing --description "How partial refunds settle."
fyi new runbook "Roll back the API deploy" --app api --owner "<team>"
fyi new script "Dump slow queries" --file ./dump-slow-queries.mjs --app api --description "Slowest queries for one hour."
```

`--app` may repeat or comma-separate. Knowledge with one app is written to `knowledge/<app>/`; knowledge with zero or several apps goes to `knowledge/shared/` with `apps: []` (or `apps: [shared]`). `shared` is reserved and does not need to appear in `config.json`.

`fyi new script --file <source>` accepts only the supported script extensions (`.mjs`, `.js`, `.cjs`, `.sh`, `.bash`, `.zsh`, `.py`, `.rb`). The CLI writes frontmatter, a body skeleton, and rebuilds the index. Let it create the frontmatter; on later updates, edit only the fields you are changing and run `fyi index`.

## Step 5: Write the body

Quality gate — the artifact is not done until it answers all six:

1. **When do I use this?** A symptom or task, not a topic.
2. **What do I need first?** Access, tools, IDs, environment.
3. **What exactly do I run?** Copy-pasteable commands, `<placeholders>` called out.
4. **What proves it worked?** Log lines, fields, status codes, expected output.
5. **What goes wrong?** The gotchas you actually hit.
6. **Who confirmed it?** Owner, source, ticket, dashboard.

Rules:

- Prefer numbered steps over prose.
- One command per line in a fenced block; no secrets, tokens, or customer data.
- Name the environment (`staging`, `prod`) explicitly.
- Link related artifacts by id in `related`, e.g. `knowledge/shared/request-ids`. Use `--related <id>` at creation; on updates, edit the field and run `fyi index`.
- Do not paste raw logs. Extract the query and the field that matters.

## Step 6: Redact

**The CLI does not redact.** `fyi new` writes the title, description, owner, tags, and `--file` content verbatim. Redact before calling it.

Before saving, remove:

- credentials, tokens, cookies, connection strings;
- customer names, emails, account ids, order ids;
- internal hostnames that are not already in the repo.

Replace with `<redacted>` or `<placeholder>`. If the artifact only works with a real secret, store the command shape and point to the secret manager; never the value.

`fyi doctor` scans the whole file, including frontmatter, for common secret shapes and fails on high-confidence matches. Values written as `<placeholder>` or `{{placeholder}}` are ignored. It is a safety net, not a redactor: treat a finding as a hard stop and remove the value before continuing.

## Step 7: Scripts

When the reusable thing is a command, save it as a `script` and include usage:

```bash
fyi new script "Dump slow queries" --file ./dump-slow-queries.mjs --app api \
  --description "Print the slowest queries for one app and hour."
```

The CLI prepends line-comment metadata after the shebang, so the script stays runnable. If the source already has flat frontmatter, the requested title, apps, tags, owner, and `related` are merged into it, and `status` is preserved unless you pass `--status`. Nested, folded, or otherwise unsupported YAML is rejected rather than silently rewritten. The body must state arguments, output shape, and a safe example. A script that needs a secret takes it from the environment or a flag, never a literal.

## Step 8: Verify and report

```bash
fyi show <id>
fyi find "<the symptom>"
fyi doctor
```

The new artifact must rank for the symptom a future person would type. If it does not, fix the title, description, or tags — not the search. `fyi doctor` must exit 0 with no errors; review any warnings before reporting the capture as done.

Report the created path in one line. Do not paste the whole artifact back to the user.
