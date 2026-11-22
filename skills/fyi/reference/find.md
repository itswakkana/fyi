# Find flow

Use before solving anything the team may have already solved: debugging, tracing, "how does X work", "who owns X", onboarding, and incident response.

## Step 1: Boot

Complete the skill's Setup sequence and reuse its context result. If the initialized store is empty, say so in one line and proceed with the task. If initialization or repair was prohibited or failed, report the limitation and continue without search; preserve the failure details for repair. Offer capture after solving according to the skill's capture rule.

## Step 2: Search more than once

Search the way the next person would, not the way the current code is named.

```bash
fyi find "<symptom>"
fyi find "<service> logs" --app <app>
fyi find "<technology> timeout" --tag tracing
fyi find "who owns <module>"
```

Try two or three formulations: the user's words, the service name, and the mechanism (`request id`, `queue`, `webhook`). Use `--type pattern` when you want a recipe rather than a fact.

`fyi find --json "<query>"` returns ids, paths, scores, and snippets when you need to select programmatically. Put the query after the flag or after `--`; a bare `fyi find --json` with no query prints usage. No matches exits 1 in both text and JSON modes; read `total` from `--json` when scripting.

## Step 3: Read before applying

Read the top result in full with `fyi show <id>`. Follow its `related` links when the recipe depends on a fact or another procedure.

Check freshness before trusting it:

- `status` must be `active`; `draft` means unconfirmed.
- `updated` should be recent enough for the system it describes; it records the last write or confirmation, not a guarantee.
- `apps` must include the app you are debugging, or be empty / `[shared]` for a cross-app artifact.

If a step contradicts the current repo, the artifact is stale. Do not silently follow it; note the mismatch and update it after you confirm the new behavior.

## Step 4: Apply and observe

Follow the artifact's commands with the real placeholders substituted. Compare the result against its **Expected signals** section. If the signals do not appear, the pattern may be stale or you may be in a different environment; say which.

## Step 5: Close the gap

If nothing matched:

1. Solve the problem normally.
2. Extract the reusable part: the query, the id that ties the flow together, the service order, the gotcha.
3. Capture it with the [save flow](save.md) before finishing, or offer to in one line.

If a result was close but incomplete, update that artifact instead of creating a new one.

## Step 6: Report what you used

In your answer, name the artifacts you followed, e.g. `Used patterns/trace-request-across-services`. This teaches the next person the store is real and tells reviewers which recipe needs maintenance.

## Anti-patterns

- Re-deriving a log query without searching first.
- Dumping the whole store into the answer; cite the one or two artifacts that mattered.
- Trusting a `draft` or `deprecated` artifact as confirmed truth.
- Treating a stale artifact as the user's mistake; fix it and say so.
