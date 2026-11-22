import { inspectIntegrations } from '../lib/hooks.mjs';
import {
  configIssues,
  counts,
  indexStatus,
  isInitialized,
  readConfig,
  storePath,
  walkArtifacts,
} from '../lib/store.mjs';
import { color, print, toPosix } from '../lib/util.mjs';

export function run(ctx) {
  const { root, json } = ctx;
  const store = storePath(root);
  const initialized = isInitialized(root);
  const config = readConfig(root);
  const artifacts = walkArtifacts(root);
  const summary = counts(artifacts);
  const status = initialized ? indexStatus(root, artifacts) : 'missing';
  const apps = (config?.apps || []).map((app) => app.name);
  const integrations = inspectIntegrations(root);

  const directives = [];
  if (!initialized) {
    directives.push('STORE_MISSING — run `fyi init` to create .fyi/.');
  } else if (!config) {
    directives.push('CONFIG_MISSING — run `fyi init` to create .fyi/config.json.');
  } else if (!summary.unarchived) {
    directives.push('STORE_EMPTY — capture the first artifact with `fyi new <type> "<title>"`.');
  }
  for (const issue of configIssues(config)) directives.push(`CONFIG_INVALID — ${issue}`);
  if (initialized && status !== 'fresh') directives.push('INDEX_STALE — run `fyi index`.');
  if (config && !apps.length) {
    directives.push('NO_APPS — run `fyi init --refresh` after the repo has app manifests.');
  }
  const drafts = artifacts.filter(
    (artifact) => !artifact.archived && artifact.status === 'draft',
  ).length;
  if (drafts) directives.push(`${drafts} draft artifact${drafts === 1 ? '' : 's'} need review.`);

  if (json) {
    print(
      JSON.stringify(
        {
          root,
          store,
          initialized,
          config,
          index: status,
          counts: summary,
          integrations,
          directives,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(color('1', `fyi · ${config?.name || 'project'}`));
  print(`root      ${root}`);
  print(`store     ${toPosix(store)}${initialized ? '' : color('33', '  (missing)')}`);
  print(
    `apps      ${apps.length ? apps.join(', ') : color('33', 'none detected')}${apps.length ? `  (${apps.length})` : ''}`,
  );
  print(
    `artifacts ${summary.unarchived} unarchived · ${summary.archived} archived  ${typeLine(summary.byType)}`,
  );
  print(`index     ${status}`);
  const activeAgents = Object.entries(integrations)
    .filter(([, info]) => info.skill.installed || info.hooks.installed)
    .map(([name, info]) => {
      const parts = [];
      if (info.skill.installed) parts.push('skill');
      if (info.hooks.installed) parts.push('hooks');
      return `${name} (${parts.join('+')})`;
    });
  if (activeAgents.length) print(`agents    ${activeAgents.join(', ')}`);
  if (directives.length) {
    print('');
    print(color('1', 'directives'));
    for (const directive of directives) print(`  ${directive}`);
  } else {
    print('');
    print('No session directives.');
  }
  return 0;
}

function typeLine(byType) {
  const parts = Object.entries(byType).map(([type, count]) => `${type} ${count}`);
  return parts.length ? `· ${parts.join(' · ')}` : '';
}
