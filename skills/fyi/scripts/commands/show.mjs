import { readFileSync } from 'node:fs';
import { findArtifact, findCandidates, isInitialized, walkArtifacts } from '../lib/store.mjs';
import { color, fail, print } from '../lib/util.mjs';

export function run(ctx) {
  const { root, flags, positionals, json } = ctx;
  if (!isInitialized(root)) return fail('store is not initialized; run `fyi init` first.');

  const needle = positionals.join(' ').trim();
  if (!needle) return fail('expected an id, path, or title: fyi show <id>');

  const artifacts = walkArtifacts(root);
  let artifact = findArtifact(artifacts, needle);
  if (!artifact) {
    const candidates = findCandidates(artifacts, needle);
    if (candidates.length === 1) artifact = candidates[0];
    else if (candidates.length > 1) {
      return fail(
        `"${needle}" matches ${candidates.length} artifacts; use an id or path:\n${candidates
          .map((candidate) => `  ${candidate.id}  (${candidate.title})`)
          .join('\n')}`,
      );
    }
  }
  if (!artifact) return fail(`no artifact matches "${needle}". Try \`fyi find ${needle}\`.`);

  const text = readFileSync(artifact.abs, 'utf8');

  if (json) {
    print(
      JSON.stringify(
        {
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          description: artifact.description,
          apps: artifact.apps,
          tags: artifact.tags,
          owner: artifact.owner,
          status: artifact.status,
          updated: artifact.updated,
          related: artifact.related,
          path: artifact.path,
          body: artifact.body,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(
    color(
      '2',
      `# ${artifact.path} · ${artifact.type} · ${artifact.status} · updated ${artifact.updated}`,
    ),
  );
  print('');
  print(text.trimEnd());
  return 0;
}
