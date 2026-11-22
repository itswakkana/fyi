import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  parseScript,
  scriptFrontmatterIsSimple,
  stringifyMarkdown,
  upsertScriptFrontmatter,
} from '../lib/frontmatter.mjs';
import {
  ARTIFACT_TYPES,
  SCRIPT_EXTS,
  TYPE_DIRS,
  TYPE_HINTS,
  indexMarkdownPath,
  indexPath,
  isInitialized,
  readConfig,
  rebuildIndex,
  storePath,
} from '../lib/store.mjs';
import { bodyTemplate, scriptTemplate } from '../lib/templates.mjs';
import {
  assertSafeStoreRoot,
  color,
  ensureDir,
  fail,
  flagList,
  isInsideReal,
  isSafeAppName,
  isSymlink,
  oneLine,
  print,
  safeWriteFile,
  slugify,
  toPosix,
  today,
} from '../lib/util.mjs';

const STATUSES = new Set(['active', 'draft', 'stale', 'deprecated']);

export function run(ctx) {
  const { root, flags, positionals, json } = ctx;
  const type = String(positionals.shift() || '').toLowerCase();

  if (flags.description === true) {
    return fail('--description requires a value; use --description="text" if the value starts with a dash.');
  }
  if (flags.owner === true) return fail('--owner requires a value');
  if (flags.file === true) return fail('--file requires a path');
  if (flags.ext === true || Array.isArray(flags.ext)) return fail('--ext requires one extension');
  for (const key of ['app', 'apps', 'tag', 'tags', 'related']) {
    if (flags[key] === true) return fail(`--${key} requires a value`);
  }
  if (flags.title === true) return fail('--title requires a value');
  const title =
    flags.title !== undefined ? String(flags.title) : positionals.join(' ').trim();

  if (!ARTIFACT_TYPES.includes(type)) {
    return fail(
      `expected a type (${ARTIFACT_TYPES.join(', ')}), got "${type || ''}".\n  ${
        TYPE_HINTS[type] || ''
      }`,
    );
  }
  if (!title) return fail('expected a title: fyi new <type> "<title>"');
  try {
    assertSafeStoreRoot(root, { allowMissing: false });
  } catch (error) {
    return fail(error.message);
  }
  if (!isInitialized(root)) return fail('store is not initialized; run `fyi init` first.');

  const slug = slugify(title);
  const config = readConfig(root);
  const canonicalApps = new Map(
    (config?.apps || []).map((app) => [app.name.toLowerCase(), app.name]),
  );
  const apps = flagList(flags, 'app', 'apps').map(
    (app) => canonicalApps.get(app.trim().toLowerCase()) || app.trim(),
  );
  for (const app of apps) {
    if (!isSafeAppName(app)) {
      return fail(
        `invalid app name "${app}"; app names cannot be "." or "..", start with ".", or contain a path separator.`,
      );
    }
  }
  const tags = flagList(flags, 'tag', 'tags').map((tag) => tag.toLowerCase());
  const owner = flags.owner !== undefined ? String(flags.owner) : '';
  const status = flags.status !== undefined ? String(flags.status) : 'active';
  const statusExplicit = flags.status !== undefined;
  if (!STATUSES.has(status)) {
    return fail(`invalid --status "${status}"; use ${[...STATUSES].join(', ')}`);
  }
  const related = flagList(flags, 'related');
  const description = flags.description !== undefined ? String(flags.description) : '';

  const ext = normalizeExt(flags.ext);
  if (flags.ext !== undefined && ext === null) {
    return fail(`unsupported --ext; use ${SCRIPT_EXTS.join(', ')}`);
  }

  const sourceFile = flags.file !== undefined ? resolve(String(flags.file)) : null;
  if (type !== 'script' && sourceFile) return fail('--file is only supported for scripts');
  if (sourceFile) {
    if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) {
      return fail(`source file not found or not a regular file: ${sourceFile}`);
    }
  }

  const scriptExt = type === 'script' ? ext || (sourceFile ? extname(sourceFile).toLowerCase() : '.mjs') : '';
  if (type === 'script') {
    if (!SCRIPT_EXTS.includes(scriptExt)) {
      return fail(`unsupported script extension "${scriptExt}"; use ${SCRIPT_EXTS.join(', ')}`);
    }
    if (sourceFile && ext && extname(sourceFile).toLowerCase() !== ext) {
      return fail(
        `--ext ${ext} does not match the source extension ${extname(sourceFile).toLowerCase()}`,
      );
    }
  }

  if (sourceFile && type === 'script') {
    const sourceText = readFileSync(sourceFile, 'utf8');
    if (
      parseScript(sourceText, scriptExt).hasFrontmatter &&
      !scriptFrontmatterIsSimple(sourceText, scriptExt)
    ) {
      return fail(
        'source script frontmatter contains nested, folded, or otherwise unsupported YAML; remove the metadata block or edit the script manually.',
      );
    }
  }

  const target = targetPath(root, type, slug, { apps, scriptExt });
  const scopeDir =
    type === 'knowledge'
      ? join(storePath(root), 'knowledge')
      : join(storePath(root), TYPE_DIRS[type]);
  if (!isWithin(scopeDir, target)) return fail('target path escapes the store');
  if (!isInsideReal(storePath(root), target)) {
    return fail('target path resolves outside the store through a symlinked directory');
  }

  if (existsSync(target) || isSymlink(target)) {
    return fail(
      `artifact already exists: ${toPosix(relative(root, target))}\n  Read it with \`fyi show ${slug}\` or update it in place.`,
    );
  }

  const data = {
    type,
    title,
    description,
    apps,
    tags,
    owner,
    status,
    updated: today(),
    related,
  };

  if (flags['dry-run']) {
    print(JSON.stringify({ target, data }, null, 2));
    return 0;
  }

  if (isSymlink(indexPath(root)) || isSymlink(indexMarkdownPath(root))) {
    return fail('refusing to write: index.json or INDEX.md is a symlink');
  }

  ensureDir(dirname(target));

  try {
    if (type === 'script') {
      const content = scriptContent({
        sourceFile,
        scriptExt,
        title,
        slug,
        data,
        description,
        apps,
        tags,
        owner,
        status,
        statusExplicit,
        related,
      });
      safeWriteFile(target, content, { flag: 'wx' });
      if (sourceFile) chmodSync(target, statSync(sourceFile).mode & 0o777);
    } else {
      safeWriteFile(target, stringifyMarkdown(data, bodyTemplate(type, title)), { flag: 'wx' });
    }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return fail(`artifact already exists: ${toPosix(relative(root, target))}`);
    }
    throw error;
  }

  const { summary } = rebuildIndex(root);

  if (json) {
    print(
      JSON.stringify(
        {
          path: target,
          relative: toPosix(relative(root, target)),
          data,
          counts: summary,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(color('32', `created ${type}`), toPosix(relative(root, target)));
  print(`  ${oneLine(title, 100)}${apps.length ? ` · ${apps.join(', ')}` : ''}`);
  print('');
  print('Fill the body, then verify with:');
  print(`  fyi show ${slug}`);
  if (!description) {
    print(color('33', '  Add a one-line description so search can find it later.'));
  }
  return 0;
}

function scriptContent({
  sourceFile,
  scriptExt,
  title,
  slug,
  data,
  description,
  apps,
  tags,
  owner,
  status,
  statusExplicit,
  related,
}) {
  if (!sourceFile) {
    const template = scriptTemplate(title, `.fyi/scripts/${slug}${scriptExt}`, scriptExt);
    return upsertScriptFrontmatter(template, scriptExt, data);
  }

  const content = readFileSync(sourceFile, 'utf8');
  const existing = parseScript(content, scriptExt);
  if (!existing.hasFrontmatter) return upsertScriptFrontmatter(content, scriptExt, data);

  const merged = {
    ...existing.data,
    type: 'script',
    title,
    updated: today(),
    ...(statusExplicit ? { status } : {}),
    ...(description ? { description } : {}),
    ...(apps.length ? { apps } : {}),
    ...(tags.length ? { tags } : {}),
    ...(owner ? { owner } : {}),
    ...(related.length ? { related } : {}),
  };
  return upsertScriptFrontmatter(content, scriptExt, merged);
}

function targetPath(root, type, slug, { apps, scriptExt }) {
  const store = storePath(root);
  if (type === 'script') return join(store, TYPE_DIRS.script, `${slug}${scriptExt}`);
  if (type === 'knowledge') {
    const scope = apps.length === 1 ? apps[0] : 'shared';
    return join(store, TYPE_DIRS.knowledge, scope, `${slug}.md`);
  }
  return join(store, TYPE_DIRS[type], `${slug}.md`);
}

function isWithin(parent, target) {
  const rel = relative(parent, target);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function normalizeExt(value) {
  if (value === undefined) return '';
  const ext = String(value).startsWith('.') ? String(value) : `.${value}`;
  return SCRIPT_EXTS.includes(ext.toLowerCase()) ? ext.toLowerCase() : null;
}
