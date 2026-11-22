# fyi

This directory is the project's shared memory. It is version-controlled, reviewed like code, and read by both people and agents.

| Path | Holds |
|---|---|
| `knowledge/` | Business, domain, and architecture facts, grouped by app |
| `patterns/` | Reusable investigation recipes: log searches, traces, repros |
| `runbooks/` | Operational procedures: deploy, rollback, incident, migration |
| `docs/` | Durable documents and pointers to specs, ADRs, contracts |
| `scripts/` | Runnable helpers with metadata and usage notes |
| `INDEX.md` | Generated catalog. Do not edit by hand. |
| `index.json` | Generated machine index. Do not edit by hand. |
| `config.json` | Store configuration and detected apps |

Start with `fyi find "<symptom>"` before re-deriving a debugging flow. Capture a reusable recipe with `fyi new pattern "<title>"`.

If `fyi` is not on PATH, run `node skills/fyi/scripts/fyi.mjs <command>` from the repo root, or add that command as an alias.

Run `fyi help` for commands, or read the skill at `skills/fyi/SKILL.md`.
