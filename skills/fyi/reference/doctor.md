# Doctor flow

`fyi doctor` checks whether the store is structurally sound. Run it after init, after a batch of captures, and when search results look wrong.

## Step 1: Run the check

```bash
fyi doctor
fyi doctor --json
```

Exit code 1 means at least one structural error. Warnings do not fail the command. In JSON mode, inspect `checks` for every check, including soft warnings such as missing apps or no artifacts; the `warnings` array contains artifact and config validation warnings.

## Step 2: Read the findings

| Finding | Meaning | Repair |
|---|---|---|
| `store is not initialized` | `.fyi/` does not exist; doctor stops before the checks | `fyi init` |
| `config` fail | `config.json` missing or unreadable | Restore from git, or remove it and run `fyi init` |
| `index.json` / `INDEX.md` fail | Catalog missing or unreadable | `fyi index` |
| `index is stale` | Artifact content or metadata changed after the last index | `fyi index` |
| `apps` warn | No apps detected | Add manifests, then `fyi init --refresh` |
| `artifacts` warn | Store is empty | Capture the first pattern |
| `missing description` | Search will rank it poorly | Add a one-line description |
| `missing frontmatter` | Metadata is missing or inferred; the file is indexed with fallback title/type/date | Add the schema fields, then `fyi index` |
| `invalid updated date` | Not `YYYY-MM-DD` | Fix the date |
| `unknown status` | Not `active`, `draft`, `stale`, `deprecated` | Fix the status |
| `unknown app` | App not in `config.json` | Correct the name, or add the app via `init --refresh` |
| `duplicate title` | Two artifacts claim the same concept | Merge via [organize](organize.md) |
| `related id not found` | Broken cross-link | Correct the id or remove the link |
| `stale` | Active artifact older than the threshold | Confirm, refresh, mark stale, or archive |
| `script has no metadata frontmatter` | Script is indexed with inferred title/date and cannot be filtered by app or tag | Add the metadata block, then `fyi index` |
| `type "x" disagrees with the y directory` | The `type:` field and the artifact's directory differ | The directory is authoritative; fix the `type:` field or move the file |
| `possible secret (...)` | High-confidence secret shape anywhere in the file, including frontmatter | Redact before doing anything else |

## Step 3: Repair in order

1. **Secrets first.** Redact the value, rotate it if it was real, then rerun. Do not proceed with a store that contains credentials.
2. **Structure next.** `fyi init` or `fyi index` for missing config and catalog.
3. **Metadata next.** `fyi organize --fix` for safe stamps and index rebuild; fix the rest by hand.
4. **Semantics last.** Merge duplicates, fix links, archive stale artifacts via [organize](organize.md).

## Step 4: Confirm

```bash
fyi doctor
fyi find "<a known artifact>"
```

`doctor` exits 0 and the known artifact ranks. Exit 0 with warnings is not "healthy": the command prints `No errors; N warnings to review` and reserves `Healthy.` for zero errors and zero warnings. If search is still wrong, the artifact's title, description, or tags are the problem, not the index.

`fyi organize --fix` returns the exit code of the state after its repairs, so a missing index repaired by `--fix` does not leave the command failing.

## When to ask

Ask the user before:

- deleting anything;
- rotating a secret;
- merging artifacts with different owners;
- marking an artifact `deprecated` when you are not sure it is wrong.

Everything else is a safe repair you can make and report.
