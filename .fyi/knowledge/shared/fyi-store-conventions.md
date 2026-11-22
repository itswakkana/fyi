---
type: knowledge
title: fyi store conventions
description: "How the .fyi store is laid out, generated, and maintained."
apps: []
tags: [meta]
owner: ""
status: active
updated: 2026-11-10
related: []
---

# fyi store conventions

## Summary

`.fyi/` is the repo's shared memory: version-controlled Markdown artifacts read by people and by the `fyi` skill. Files are the source of truth; `INDEX.md` and `index.json` are generated.

## Facts

- An artifact is one Markdown file with YAML frontmatter, or one script with the same frontmatter in a leading line-comment block (`// ---` for JS, `# ---` for shell/Python/Ruby).
- Ids are derived from the path under `.fyi/` without the extension: `patterns/trace-request`, `knowledge/api/overview`, `scripts/dump-slow-queries`.
- Types: `pattern`, `knowledge`, `runbook`, `doc`, `script`.
- Status values: `active`, `draft`, `stale`, `deprecated`.
- Cross-app knowledge uses `apps: []` or `apps: [shared]`; `shared` is a reserved scope, not an app in `config.json`.
- `fyi new` writes the frontmatter, the body skeleton, and rebuilds the index. Let it create the frontmatter; on updates, edit only the fields you are changing and run `fyi index`.
- `fyi index` regenerates `INDEX.md` and `index.json`; never edit either by hand. `index.json` stores a content hash per artifact, so `doctor` and `context` detect in-place edits.
- `fyi organize --fix` performs only surgical safe fixes: it inserts or replaces the `updated:` line inside an existing frontmatter block and rebuilds the index. Every other line and the file's line endings are preserved, so nested maps and folded scalars survive. A Markdown document that merely starts with a horizontal rule is never treated as frontmatter and is never rewritten.
- `fyi doctor` exits 1 on structural errors and high-confidence secrets anywhere in a file, including frontmatter. Placeholder values (`<...>`, `{{...}}`) are ignored; the word "example" on the same line does not suppress a real key. Exit 0 with warnings prints `No errors; N warnings to review`, not `Healthy.`.
- The CLI does not redact. Remove secrets before calling `fyi new`; `doctor` is a safety net, not a redactor.
- Secrets, tokens, customer data, and raw log dumps are never stored. Store the query and the reasoning instead.
- A script's metadata block must be the first content after the shebang and hold at least two known keys, so a `---` section divider is never mistaken for metadata.
- The artifact's directory is authoritative for its type; a disagreeing `type:` field is reported by `doctor`.
- Archive by moving to `.fyi/archive/` and setting `status: deprecated`. Archiving changes the id to `archive/<name>`, so update inbound `related` links. Do not delete unless asked.
- `fyi init --refresh` re-detects scopes and prunes those whose manifests disappeared; their `knowledge/<app>/` files are kept. If no apps or packages are detected, it removes every app scope and prints a warning.
- `apps/` and `services/` entries are treated as apps; `packages/` and `libs/` entries as packages. By default, `init` selects apps when any are detected, otherwise it falls back to detected packages. `--include-packages --refresh` includes packages alongside apps.
- Symlinked artifact files are skipped. `init` rejects symlinked type directories and app overview directories; `new` permits a symlinked directory only when its target resolves inside `.fyi/`.

## Implications

- A rename or archive changes the artifact id, so every `related` link pointing at it must be updated in the same change.
- Reviewing a capture means reviewing the recipe, not just the prose: commands must be copy-pasteable and expected signals must be concrete.
- The store is only useful if search ranks the artifact for the symptom a future person types; title, description, and tags are part of the artifact, not decoration.
- Hand-written YAML beyond the supported subset is preserved on disk but not indexed. Keep `type`, `title`, `description`, `apps`, `tags`, `owner`, `status`, `updated`, and `related` at the top level.

## Sources

- `README.md` in this repo.
- `skills/fyi/SKILL.md` and `reference/schema.md`.

## Open questions

- [ ] Confirm the owner of the store once the repo has app owners.
