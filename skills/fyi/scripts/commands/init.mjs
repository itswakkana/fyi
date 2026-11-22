import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringifyMarkdown } from '../lib/frontmatter.mjs';
import { detectApps } from '../lib/repo.mjs';
import {
  configPath,
  counts,
  emptyConfig,
  ensureStoreDirs,
  indexStatus,
  isInitialized,
  readConfig,
  rebuildIndex,
  storePath,
  storeReadme,
  walkArtifacts,
  writeConfig,
} from '../lib/store.mjs';
import { appOverview } from '../lib/templates.mjs';
import {
  assertSafeStoreRoot,
  color,
  ensureDir,
  fail,
  isDir,
  isSymlink,
  print,
  safeWriteFile,
  toPosix,
  today,
} from '../lib/util.mjs';

export function run(ctx) {
  const { root, flags, json } = ctx;
  const dryRun = Boolean(flags['dry-run']);
  const refresh = Boolean(flags.refresh);
  const includePackages = Boolean(flags['include-packages']);
  const store = storePath(root);

  try {
    assertSafeStoreRoot(root);
  } catch (error) {
    return fail(error.message);
  }

  if (existsSync(store) && !isDir(store)) {
    return fail('.fyi exists but is not a directory; move it aside first.');
  }

  for (const dir of ['patterns', 'runbooks', 'docs', 'scripts', 'knowledge', 'archive']) {
    const path = join(store, dir);
    if (isSymlink(path)) {
      return fail(`.fyi/${dir} is a symlink; refusing to write outside the store.`);
    }
  }

  const initialized = isInitialized(root);
  const configFileExists = existsSync(configPath(root));
  const existing = initialized ? readConfig(root) : null;

  if (initialized && configFileExists && !existing) {
    return fail(
      'config.json exists but is unreadable; fix it or remove it explicitly before re-initializing.',
    );
  }

  const detectedAll = detectApps(root);
  let detected = includePackages ? detectedAll : detectedAll.filter((app) => app.kind === 'app');
  if (!detected.length) detected = detectedAll;

  if (initialized && configFileExists && !refresh && !dryRun) {
    ensureStoreDirs(root, existing.apps || []);
    const seeded = seedOverviews(root, existing.apps || []);
    const artifacts = walkArtifacts(root);
    if (indexStatus(root, artifacts) !== 'fresh') rebuildIndex(root, artifacts);
    if (json) {
      print(
        JSON.stringify(
          {
            root,
            initialized: true,
            apps: existing?.apps || [],
            counts: counts(artifacts),
            seeded: seeded.length,
            index: 'fresh',
          },
          null,
          2,
        ),
      );
      return 0;
    }
    print(`fyi is already initialized at ${toPosix(store)}`);
    print(`apps: ${(existing?.apps || []).map((app) => app.name).join(', ') || 'none detected'}`);
    print(`artifacts: ${artifacts.length}`);
    if (seeded.length) print(`repaired: seeded ${seeded.length} missing app overview(s)`);
    print('');
    print('Use `fyi init --refresh` to re-detect apps, or `fyi index` to rebuild the catalog.');
    return 0;
  }

  const config = existing
    ? {
        ...existing,
        apps: mergeApps(existing.apps || [], detected, refresh),
        updatedAt: today(),
      }
    : emptyConfig(root, detected);

  const removed = existing
    ? existing.apps.filter((app) => !config.apps.some((current) => current.name === app.name))
    : [];
  const removedAll = Boolean(refresh && detected.length === 0 && (existing?.apps?.length || 0) > 0);
  const warning = removedAll
    ? 'No apps detected; all app scopes were removed. Their knowledge files were kept.'
    : '';

  if (dryRun) {
    if (json) {
      print(
        JSON.stringify(
          {
            root,
            dryRun: true,
            apps: config.apps,
            removed,
            warning: warning || undefined,
            store: toPosix(store),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    print(color('1', 'fyi init (dry run)'));
    print(`store: ${toPosix(store)}`);
    print(
      `apps:  ${
        config.apps.map((app) => `${app.name} (${app.path})`).join(', ') || 'none detected'
      }`,
    );
    if (removed.length) print(`would remove: ${removed.map((app) => app.name).join(', ')}`);
    if (warning) print(color('33', warning));
    print('No files written.');
    return 0;
  }

  ensureDir(store);
  ensureStoreDirs(root, config.apps);
  for (const app of config.apps) {
    const appDir = join(store, 'knowledge', app.name);
    if (isSymlink(appDir)) {
      return fail(`.fyi/knowledge/${app.name} is a symlink; refusing to write outside the store.`);
    }
  }
  writeConfig(root, config);

  const readmePath = join(store, 'README.md');
  if (!existsSync(readmePath)) safeWriteFile(readmePath, storeReadme(root));

  const seeded = seedOverviews(root, config.apps);
  const { summary } = rebuildIndex(root);

  if (json) {
    print(
      JSON.stringify(
        {
          root,
          store: toPosix(store),
          config: toPosix(configPath(root)),
          apps: config.apps,
          removed,
          warning: warning || undefined,
          seeded: seeded.length,
          counts: summary,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(color('1', `fyi initialized · ${config.name}`));
  print(`store     ${toPosix(store)}`);
  print(`config    ${toPosix(configPath(root))}`);
  print(
    `apps      ${
      config.apps.length
        ? config.apps.map((app) => `${app.name} (${app.path})`).join(', ')
        : color('33', 'none detected')
    }`,
  );
  if (removed.length) print(`removed   ${removed.map((app) => app.name).join(', ')} (knowledge kept)`);
  if (warning) print(color('33', warning));
  print(`seeded    ${seeded.length} app overview${seeded.length === 1 ? '' : 's'}`);
  print(`artifacts ${summary.unarchived}`);
  print('');
  print('Store ready. Continue your task; no prior recipes are required.');
  if (config.apps.length) {
    print('App overviews are drafts; fill confirmed facts as you learn them.');
  } else {
    print('No apps detected; shared knowledge and recipes can still be captured.');
    print('Run `fyi init --refresh` if app manifests are added later.');
  }
  print('Search before investigating: fyi find "<symptom>"');
  print('After solving a reusable problem, capture it: fyi new pattern "<title>"');
  return 0;
}

function seedOverviews(root, apps) {
  const seeded = [];
  for (const app of apps) {
    const appDir = join(storePath(root), 'knowledge', app.name);
    if (isSymlink(appDir)) {
      throw new Error(`knowledge/${app.name} is a symlink; refusing to write outside the store`);
    }
    const target = join(appDir, 'overview.md');
    if (existsSync(target)) continue;
    ensureDir(appDir);
    const template = appOverview(app, today());
    safeWriteFile(target, stringifyMarkdown(template.frontmatter, template.body));
    seeded.push(target);
  }
  return seeded;
}

function mergeApps(existing, detected, prune) {
  const detectedNames = new Set(detected.map((app) => app.name));
  const base = prune ? existing.filter((app) => detectedNames.has(app.name)) : existing;
  const byName = new Map(base.map((app) => [app.name, app]));
  for (const app of detected) {
    const current = byName.get(app.name);
    byName.set(app.name, {
      ...current,
      ...app,
      description: current?.description || app.description,
      owner: current?.owner || '',
    });
  }
  return [...byName.values()].sort((a, b) => a.path.localeCompare(b.path));
}
