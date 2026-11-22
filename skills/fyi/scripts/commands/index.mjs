import { isInitialized, rebuildIndex, storePath, walkArtifacts } from '../lib/store.mjs';
import { color, fail, print, toPosix } from '../lib/util.mjs';

export function run(ctx) {
  const { root, json } = ctx;
  if (!isInitialized(root)) return fail('store is not initialized; run `fyi init` first.');

  const { summary } = rebuildIndex(root);
  const artifacts = walkArtifacts(root);

  if (json) {
    print(
      JSON.stringify({ store: toPosix(storePath(root)), counts: summary, artifacts: artifacts.length }, null, 2),
    );
    return 0;
  }

  print(color('32', 'index rebuilt'));
  print(`  ${toPosix(storePath(root))}/index.json`);
  print(`  ${toPosix(storePath(root))}/INDEX.md`);
  print(`  ${summary.unarchived} unarchived · ${summary.archived} archived`);
  const types = Object.entries(summary.byType)
    .map(([type, count]) => `${type} ${count}`)
    .join(' · ');
  if (types) print(`  ${types}`);
  return 0;
}
