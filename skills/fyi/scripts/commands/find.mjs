import { isInitialized, searchArtifacts, walkArtifacts } from '../lib/store.mjs';
import { color, fail, flagList, oneLine, print } from '../lib/util.mjs';

export function run(ctx) {
  const { root, flags, positionals, json } = ctx;
  const query = positionals.join(' ').trim();
  const filters = buildFilters(flags);

  if (!isInitialized(root)) return fail('store is not initialized; run `fyi init` first.');

  for (const key of ['type', 'app', 'apps', 'tag', 'tags', 'status', 'owner', 'limit']) {
    if (flags[key] === true) return fail(`--${key} requires a value`);
  }

  if (!query && !hasFilter(filters)) {
    print('Usage: fyi find <query> [--app <name>] [--type <type>] [--tag <tag>]');
    print('Try a symptom, a service, a technology, or a phrase:');
    print('  fyi find "request id logs" --app api');
    print('  fyi find --json "request id logs"');
    return 1;
  }

  const limit = parseLimit(flags.limit);
  if (limit === null) return fail('--limit must be a positive integer');

  const artifacts = walkArtifacts(root);
  const results = searchArtifacts(artifacts, query, filters);
  const shown = results.slice(0, limit);

  if (!results.length) {
    if (json) {
      print(JSON.stringify({ query, filters, total: 0, results: [] }, null, 2));
    } else {
      print(query ? `No matches for "${query}"${filterText(filters)}.` : 'No artifacts match.');
      if (query) {
        print('');
        print('If you solve this, capture the recipe so the next person does not re-derive it:');
        print(`  fyi new pattern "${query}"${filters.app?.length ? ` --app ${filters.app[0]}` : ''}`);
      }
    }
    return 1;
  }

  if (json) {
    print(
      JSON.stringify(
        {
          query,
          filters,
          total: results.length,
          results: shown.map(({ artifact, score, snippet }) => ({
            id: artifact.id,
            type: artifact.type,
            title: artifact.title,
            description: artifact.description,
            apps: artifact.apps,
            tags: artifact.tags,
            status: artifact.status,
            updated: artifact.updated,
            path: artifact.path,
            score,
            snippet,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const label = query
    ? `match${results.length === 1 ? '' : 'es'} for "${query}"`
    : `artifact${results.length === 1 ? '' : 's'}`;
  print(
    `${results.length} ${label}${filterText(filters)}${
      results.length > shown.length ? ` · showing ${shown.length}` : ''
    }`,
  );
  print('');

  shown.forEach(({ artifact, score, snippet }, index) => {
    const meta = [artifact.type, ...artifact.apps, ...artifact.tags];
    print(`${color('1', `${index + 1}. ${artifact.title}`)}  ${color('2', `score ${score}`)}`);
    print(
      `   ${artifact.path} · ${meta.join(' · ')}${
        artifact.status !== 'active' ? ` · ${artifact.status}` : ''
      }`,
    );
    if (snippet) print(`   ${color('2', oneLine(snippet, 180))}`);
    print('');
  });

  print('Read one with: fyi show <id>');
  return 0;
}

function parseLimit(value) {
  if (value === undefined) return 10;
  if (value === true || Array.isArray(value)) return null;
  if (!/^\d+$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function buildFilters(flags) {
  return {
    type: flagList(flags, 'type'),
    app: flagList(flags, 'app', 'apps'),
    tag: flagList(flags, 'tag', 'tags'),
    status: flagList(flags, 'status'),
    owner: flagList(flags, 'owner'),
    includeArchived: Boolean(flags['include-archived'] || flags.archived),
  };
}

function hasFilter(filters) {
  return Boolean(
    filters.type.length ||
      filters.app.length ||
      filters.tag.length ||
      filters.status.length ||
      filters.owner.length ||
      filters.includeArchived,
  );
}

function filterText(filters) {
  const parts = [];
  if (filters.type.length) parts.push(`type ${filters.type.join(',')}`);
  if (filters.app.length) parts.push(`app ${filters.app.join(',')}`);
  if (filters.tag.length) parts.push(`tag ${filters.tag.join(',')}`);
  if (filters.status.length) parts.push(`status ${filters.status.join(',')}`);
  if (filters.owner.length) parts.push(`owner ${filters.owner.join(',')}`);
  if (filters.includeArchived) parts.push('including archived');
  return parts.length ? ` [${parts.join(' · ')}]` : '';
}
