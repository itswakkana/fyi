import { existsSync } from 'node:fs';
import { inspectIntegrations } from '../lib/hooks.mjs';
import {
  configPath,
  indexMarkdownPath,
  indexPath,
  isInitialized,
  readConfig,
  storePath,
  walkArtifacts,
} from '../lib/store.mjs';
import { validateStore } from '../lib/validate.mjs';
import { color, fail, print, readJson, toPosix } from '../lib/util.mjs';

export function run(ctx) {
  const { root, json } = ctx;
  if (!isInitialized(root)) return fail('store is not initialized; run `fyi init` first.');

  const config = readConfig(root);
  const artifacts = walkArtifacts(root);
  const report = validateStore(root, artifacts, config);
  const integrations = inspectIntegrations(root);
  const hookAgents = Object.entries(integrations)
    .filter(([, info]) => info.hooks.installed)
    .map(([name]) => name);
  const hookIssues = Object.entries(integrations)
    .filter(([, info]) => info.issue)
    .map(([name, info]) => `${name} hooks: ${info.issue}`);
  for (const issue of hookIssues) report.warnings.push(issue);

  const checks = [
    { name: 'store', ok: existsSync(storePath(root)), detail: toPosix(storePath(root)) },
    { name: 'config', ok: Boolean(config), detail: toPosix(configPath(root)) },
    {
      name: 'index.json',
      ok: readJson(indexPath(root), null) !== null,
      detail: toPosix(indexPath(root)),
    },
    {
      name: 'INDEX.md',
      ok: existsSync(indexMarkdownPath(root)),
      detail: toPosix(indexMarkdownPath(root)),
    },
    {
      name: 'apps',
      ok: Boolean((config?.apps || []).length),
      detail: (config?.apps || []).map((app) => app.name).join(', ') || 'none detected',
      soft: true,
    },
    {
      name: 'artifacts',
      ok: artifacts.length > 0,
      detail: `${artifacts.length} total`,
      soft: true,
    },
    {
      name: 'hooks',
      ok: hookIssues.length === 0,
      detail: hookAgents.length ? hookAgents.join(', ') : 'none installed (optional)',
      soft: true,
    },
  ];

  const failed = checks.filter((check) => !check.ok && !check.soft);
  const softWarnings = checks.filter((check) => !check.ok && check.soft).length;
  const ok = report.errors.length === 0 && failed.length === 0;

  if (json) {
    print(
      JSON.stringify(
        {
          root,
          checks,
          errors: report.errors,
          warnings: report.warnings,
          softWarnings: checks.filter((check) => !check.ok && check.soft),
          ok,
        },
        null,
        2,
      ),
    );
    return ok ? 0 : 1;
  }

  print(color('1', `fyi doctor · ${root}`));
  print('');
  for (const check of checks) {
    const mark = check.ok
      ? color('32', 'ok  ')
      : check.soft
        ? color('33', 'warn')
        : color('31', 'fail');
    print(`  ${mark}  ${check.name.padEnd(10)} ${check.detail}`);
  }
  print('');

  if (report.errors.length) {
    print(color('31', `ERRORS (${report.errors.length})`));
    for (const error of report.errors) print(`  ${error}`);
    print('');
  }
  if (report.warnings.length) {
    print(color('33', `WARNINGS (${report.warnings.length})`));
    for (const warning of report.warnings) print(`  ${warning}`);
    print('');
  }

  if (!ok) {
    print('Failed. Fix errors before relying on the store. `fyi organize --fix` handles safe fixes.');
  } else if (report.warnings.length || softWarnings) {
    const count = report.warnings.length + softWarnings;
    print(`No errors; ${count} warning${count === 1 ? '' : 's'} to review.`);
  } else {
    print(color('32', 'Healthy.'));
  }
  return ok ? 0 : 1;
}
