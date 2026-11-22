import {
  isInitialized,
  matchFilters,
  publicArtifact,
  TYPE_LABELS,
  walkArtifacts,
} from '../lib/store.mjs';
import { color, fail, flagList, oneLine, print } from '../lib/util.mjs';

export function run(ctx) {
  const { root, flags, json } = ctx;
  if (!isInitialized(root)) return fail('store is not initialized; run `fyi init` first.');

  for (const key of ['type', 'app', 'apps', 'tag', 'tags', 'status', 'owner', 'limit']) {
    if (flags[key] === true) return fail(`--${key} requires a value`);
  }

  const limit = parseLimit(flags.limit);
  if (limit === null) return fail('--limit must be a positive integer');

  const filters = {
    type: flagList(flags, 'type'),
    app: flagList(flags, 'app', 'apps'),
    tag: flagList(flags, 'tag', 'tags'),
    status: flagList(flags, 'status'),
    owner: flagList(flags, 'owner'),
    includeArchived: Boolean(flags['include-archived'] || flags.archived),
  };

  const all = walkArtifacts(root).filter((artifact) => matchFilters(artifact, filters));
  const artifacts = all.slice(0, limit);

  if (json) {
    print(
      JSON.stringify(
        {
          total: all.length,
          shown: artifacts.length,
          artifacts: artifacts.map(publicArtifact),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!all.length) {
    print('No artifacts match. Capture one with `fyi new <type> "<title>"`.');
    return 0;
  }

  print(
    color(
      '1',
      `${all.length} artifact${all.length === 1 ? '' : 's'}${
        all.length > artifacts.length ? ` · showing ${artifacts.length}` : ''
      }`,
    ),
  );
  print('');

  for (const type of Object.keys(TYPE_LABELS)) {
    const items = artifacts
      .filter((artifact) => artifact.type === type)
      .sort((a, b) => a.title.localeCompare(b.title));
    if (!items.length) continue;
    print(color('1', TYPE_LABELS[type]));
    for (const artifact of items) {
      const meta = [...artifact.apps, ...artifact.tags];
      print(
        `  ${artifact.title}${artifact.status !== 'active' ? color('33', ` (${artifact.status})`) : ''}`,
      );
      print(
        `    ${artifact.path}${meta.length ? ` · ${meta.join(' · ')}` : ''}${
          artifact.description ? ` · ${oneLine(artifact.description, 80)}` : ''
        }`,
      );
    }
    print('');
  }
  return 0;
}

function parseLimit(value) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (value === true || Array.isArray(value)) return null;
  if (!/^\d+$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
