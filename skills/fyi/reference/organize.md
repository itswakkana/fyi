# Organize flow

Use when the store has grown messy: duplicates, stale facts, misplaced files, weak metadata, or an index that no longer matches.

## Step 1: Get the deterministic report

```bash
fyi organize --json
```

The report contains:

- **errors:** missing config, missing index, high-confidence secrets;
- **warnings:** missing description, missing frontmatter, invalid dates, unknown apps, duplicate titles, broken `related` links, stale artifacts, stale index;
- **nearDuplicates:** same-type pairs with high token overlap and their similarity;
- **missingUpdated / unfrontmattered / stale:** file lists for the fixes below.

Read the report before changing anything. Use it to guide the safe fixes and semantic review; semantic issues can also involve files the report does not mention.

## Step 2: Apply safe fixes

```bash
fyi organize --fix
```

This only does mechanically safe work: surgically stamps `updated` on Markdown artifacts that already have frontmatter, and rebuilds the index. It does not move, merge, rename, or delete, and it does not rewrite the rest of a hand-written file. The exit code reflects the state after the fixes run.

Then re-run `fyi organize` and confirm the safe findings are gone. Artifacts without frontmatter are listed separately and are not auto-fixable.

## Step 3: Do the semantic pass

The CLI cannot judge meaning; you can. Work one category at a time.

### Merge near-duplicates

For each pair at 55% overlap or higher:

1. Read both with `fyi show`.
2. Choose the canonical file: the better title, the more complete procedure, the one linked elsewhere.
3. Merge unique facts, commands, and gotchas into the canonical body.
4. Set `related` on the canonical file if the other covered a distinct adjacent concept.
5. Archive the loser: `git mv .fyi/<path> .fyi/archive/<name>.md`, set `status: deprecated`, and add a line saying where it merged.
6. Update any `related` links that pointed at the old id. Archiving changes the id to `archive/<name>`, so links do not follow the move automatically.

App overviews (`knowledge/<app>/overview.md`) are intentionally similar across apps and are excluded from near-duplicate detection. Do not merge them across apps.

Never delete a file the user did not ask to delete.

### Split oversized artifacts

An artifact mixing a fact, a procedure, and a glossary is three artifacts. Split by type, then link them with `related`. Keep the original title on the artifact a future search would type.

### Fix scope and tags

- Move app-specific knowledge from `knowledge/shared/` to `knowledge/<app>/` when it only applies to one app.
- Add `apps` to patterns and runbooks that lack it.
- Replace vague tags (`misc`, `general`, `stuff`) with the words someone would search.
- Remove tags that duplicate the app name.

### Retire stale artifacts

For an `active` artifact older than the configured threshold:

- **Still true:** confirm it, bump `updated`, keep `active`.
- **Partially true:** fix it, bump `updated`.
- **No longer true:** set `status: deprecated`, move to `.fyi/archive/`, and say what replaced it.
- **Unknown:** set `status: stale` and open a question for the owner. Do not guess.

### Fix broken links

For every `related id not found`, either correct the id or remove the link. If the target was archived, link the canonical replacement.

## Step 4: Rebuild and verify

```bash
fyi index
fyi doctor
fyi organize
```

`doctor` must exit 0. `organize` must show no errors and no remaining safe fixes. The index counts must match the files.

## Step 5: Report

Summarize:

- merged, split, moved, retagged, archived, and refreshed counts;
- anything you could not resolve without a person;
- the canonical artifacts a reader should start from.

Do not list every file. Name the structural changes and the open questions.

## Rules

- Use `git mv` for moves so history follows the file.
- Archive, do not delete. Archiving changes the id; update inbound links.
- Ask before merging artifacts with different owners or conflicting facts.
- Never edit `INDEX.md` or `index.json`; regenerate them.
- Never rename a file without updating every `related` link.
