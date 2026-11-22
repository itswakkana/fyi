# Init flow

Use for an explicit setup or onboarding request. For an ordinary debugging or knowledge task, follow the minimal initialization in the skill's Setup sequence, then continue the original task.

## Step 1: Inspect current state

Reuse the context result from Setup. Check config, index files, store directories, and configured app overviews.

- **Missing store or config:** create the missing pieces with `fyi init`.
- **Partial store:** `fyi init` repairs missing directories and overviews and rebuilds a stale index while preserving artifacts.
- **Unreadable existing config:** report the error and leave the file intact for repair.
- **Complete store:** retain existing artifacts. Use `fyi init --refresh` only when re-detection is requested or apps have changed.

Honor read-only requests and explicit instructions against initialization. Report what is unavailable and continue any independent work.

## Step 2: Preview detection and create the store

Run `fyi init --dry-run --json` to inspect detected scopes. Then run `fyi init`, or `fyi init --refresh` for an intended scope refresh. Pass `--include-packages` when libraries should be scopes alongside apps.

The detector reads workspace manifests and conventional `apps/`, `packages/`, `services/`, `modules/`, and `libs/` directories. It unions conventional directories with workspace globs. Apps are selected by default; if none are found, it falls back to packages. Duplicate names gain parent path components or numeric suffixes. Names are deterministic for a given set of paths but may change when collisions appear or disappear; review scopes and links after refreshing.

Refresh prunes scopes no longer detected, keeping their knowledge files. If nothing is detected, all configured scopes are removed and the CLI prints a warning. Detection is evidence of structure, not authority about ownership or business behavior.

Initialization writes config, type directories, a directory guide, draft app overviews, and the generated catalogs. It succeeds even when no apps are detected. Report created or repaired files briefly; a store with draft overviews is ready for use, but contains no confirmed recipes yet.

## Step 3: Enrich from evidence

Read the root README, project guidance, manifests, and existing architecture or operational docs. Fill only supported facts in the overviews:

- what the app is and owns;
- dependencies and entry points;
- known owners and sources;
- open questions for everything unconfirmed.

Keep inferred content `status: draft`. Set `active` only after a person confirms it. Unknown owners can remain blank; they do not block setup.

Ask only when an answer changes the requested setup. Useful questions concern ownership, whether detected packages should be separate scopes, or a solved debugging recipe worth capturing. Keep any round to at most three questions. A common symptom alone is not evidence for a procedure.

## Step 4: Verify and report

Run `fyi index` after editing overviews, then `fyi doctor`. Resolve errors and review warnings; no detected apps is expected for a repository without matching manifests. Report detected scopes, draft versus confirmed content, created files, and unresolved questions.

If the user supplied a solved recipe and requested capture, use the [save flow](save.md). Otherwise offer capture after the first reusable discovery. Setup is complete without a pattern; the store grows one solved problem at a time.
