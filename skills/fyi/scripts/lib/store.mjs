import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { parseMarkdown, parseScript } from './frontmatter.mjs';
import {
  asArray,
  assertSafeStoreRoot,
  ensureDir,
  firstHeading,
  isSafeAppName,
  isSymlink,
  mtimeDate,
  oneLine,
  readJson,
  toPosix,
  today,
  unique,
  writeJson,
} from './util.mjs';

export const SCHEMA_VERSION = 1;

export const TYPE_DIRS = {
  pattern: 'patterns',
  knowledge: 'knowledge',
  runbook: 'runbooks',
  doc: 'docs',
  script: 'scripts',
};

export const DIR_TYPES = Object.fromEntries(
  Object.entries(TYPE_DIRS).map(([type, dir]) => [dir, type]),
);

export const TYPE_LABELS = {
  pattern: 'Patterns',
  knowledge: 'Knowledge',
  runbook: 'Runbooks',
  doc: 'Docs',
  script: 'Scripts',
};

export const TYPE_HINTS = {
  pattern: 'A reusable way to investigate: log searches, traces, repro steps.',
  knowledge: 'Durable business or architecture facts: ownership, flows, rules.',
  runbook: 'A procedure someone runs: deploy, rollback, incident, migration.',
  doc: 'A durable document or a pointer to one: specs, ADRs, contracts.',
  script: 'A runnable helper with metadata and usage notes.',
};

export const SCRIPT_EXTS = ['.mjs', '.js', '.cjs', '.sh', '.bash', '.zsh', '.py', '.rb'];
export const ARTIFACT_TYPES = Object.keys(TYPE_DIRS);

export function storePath(root) {
  return join(root, '.fyi');
}

export function configPath(root) {
  return join(storePath(root), 'config.json');
}

export function indexPath(root) {
  return join(storePath(root), 'index.json');
}

export function indexMarkdownPath(root) {
  return join(storePath(root), 'INDEX.md');
}

export function readConfig(root) {
  const raw = readJson(configPath(root), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const issues = [];
  let apps = raw.apps;
  if (!Array.isArray(apps)) {
    if (raw.apps !== undefined) issues.push('config.apps is not an array; using []');
    apps = [];
  }
  apps = apps
    .filter((app) => app && typeof app === 'object' && typeof app.name === 'string' && app.name.trim())
    .map((app) => ({
      name: app.name,
      path: typeof app.path === 'string' ? app.path : '',
      kind: app.kind === 'package' ? 'package' : 'app',
      description: typeof app.description === 'string' ? app.description : '',
      owner: typeof app.owner === 'string' ? app.owner : '',
    }));
  const beforeNameFilter = apps.length;
  apps = apps.filter((app) => isSafeAppName(app.name));
  if (apps.length !== beforeNameFilter) {
    issues.push('config.apps contains an unsafe app name; it was ignored');
  }

  const settings =
    raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
      ? { ...raw.settings }
      : {};
  const days = Number(settings.staleAfterDays);
  if (!Number.isFinite(days) || days <= 0) {
    if (settings.staleAfterDays !== undefined) {
      issues.push('config.settings.staleAfterDays is not a positive number; using 180');
    }
    settings.staleAfterDays = 180;
  }

  const config = { ...raw, apps, settings };
  Object.defineProperty(config, '__issues', { value: issues, enumerable: false });
  return config;
}

export function configIssues(config) {
  return config && Array.isArray(config.__issues) ? config.__issues : [];
}

export function writeConfig(root, config) {
  assertSafeStoreRoot(root);
  writeJson(configPath(root), config);
}

export function isInitialized(root) {
  return existsSync(storePath(root));
}

export function emptyConfig(root, apps = []) {
  const now = today();
  return {
    schemaVersion: SCHEMA_VERSION,
    name: basename(root) || 'project',
    createdAt: now,
    updatedAt: now,
    apps,
    settings: { staleAfterDays: 180 },
  };
}

export function ensureStoreDirs(root, apps = []) {
  const store = assertSafeStoreRoot(root);
  for (const dir of ['patterns', 'runbooks', 'docs', 'scripts', 'archive', 'knowledge/shared']) {
    ensureDir(join(store, dir));
  }
  for (const app of apps) {
    ensureDir(join(store, 'knowledge', app.name));
  }
}

export function walkArtifacts(root) {
  const store = storePath(root);
  if (!existsSync(store)) return [];

  const artifacts = [];
  for (const [type, dir] of Object.entries(TYPE_DIRS)) {
    const base = join(store, dir);
    if (!existsSync(base)) continue;
    walkFiles(base, (abs) => {
      const ext = extname(abs).toLowerCase();
      const rel = toPosix(relative(store, abs));
      if (type === 'script') {
        if (!SCRIPT_EXTS.includes(ext)) return;
      } else if (ext !== '.md') {
        return;
      }
      const artifact = loadArtifact(abs, rel, type);
      if (artifact) artifacts.push(artifact);
    });
  }

  const archive = join(store, 'archive');
  if (existsSync(archive)) {
    walkFiles(archive, (abs) => {
      const ext = extname(abs).toLowerCase();
      if (ext !== '.md' && !SCRIPT_EXTS.includes(ext)) return;
      const rel = toPosix(relative(store, abs));
      const artifact = loadArtifact(abs, rel, null);
      if (artifact) {
        artifact.archived = true;
        artifacts.push(artifact);
      }
    });
  }

  return artifacts.sort((a, b) => a.id.localeCompare(b.id));
}

function walkFiles(dir, visit) {
  if (isSymlink(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    // Symlinks are never artifacts: they can point outside the store and a
    // single broken or directory link must not break every command.
    if (entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, visit);
    } else if (entry.isFile()) {
      visit(abs);
    }
  }
}

function loadArtifact(abs, rel, forcedType) {
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const ext = extname(abs).toLowerCase();
  const parsed = SCRIPT_EXTS.includes(ext) ? parseScript(text, ext) : parseMarkdown(text);
  const data = { ...parsed.data };
  const top = rel.split('/')[0];
  const type = forcedType || String(data.type || DIR_TYPES[top] || 'doc');
  const id = rel.replace(/\.[^./]+$/, '');
  const title = String(data.title || firstHeading(parsed.body) || basename(rel, ext));

  return {
    id,
    type,
    title,
    description: String(data.description || ''),
    apps: unique(asArray(data.apps)),
    tags: unique(asArray(data.tags)),
    owner: String(data.owner || ''),
    status: String(data.status || 'active'),
    updated: String(data.updated || mtimeDate(abs)),
    related: unique(asArray(data.related)),
    path: rel,
    abs,
    ext,
    body: parsed.body,
    raw: text,
    data,
    hasFrontmatter: Boolean(parsed.hasFrontmatter),
    archived: false,
  };
}

export function artifactHash(artifact) {
  return createHash('sha1').update(artifact.raw ?? artifact.body).digest('hex').slice(0, 12);
}

export function counts(artifacts) {
  const current = artifacts.filter((artifact) => !artifact.archived);
  const byType = {};
  const byApp = {};
  const byStatus = {};
  for (const artifact of current) {
    byType[artifact.type] = (byType[artifact.type] || 0) + 1;
    byStatus[artifact.status] = (byStatus[artifact.status] || 0) + 1;
    for (const app of artifact.apps) byApp[app] = (byApp[app] || 0) + 1;
  }
  return {
    total: artifacts.length,
    unarchived: current.length,
    archived: artifacts.length - current.length,
    byType,
    byApp,
    byStatus,
  };
}

export function indexStatus(root, artifacts = walkArtifacts(root)) {
  const index = readJson(indexPath(root), null);
  if (!index) return 'missing';
  if (!existsSync(indexMarkdownPath(root))) return 'stale';
  const indexed = new Map((index.artifacts || []).map((entry) => [entry.path, entry]));
  if (indexed.size !== artifacts.length) return 'stale';
  for (const artifact of artifacts) {
    const entry = indexed.get(artifact.path);
    if (!entry) return 'stale';
    if (entry.hash !== artifactHash(artifact)) return 'stale';
  }
  return 'fresh';
}

/**
 * One read of the store's state, shared by `context`, hooks, and diagnostics
 * so they cannot drift apart.
 */
export function snapshot(root) {
  const initialized = isInitialized(root);
  if (!initialized) {
    return {
      initialized: false,
      config: null,
      issues: [],
      artifacts: [],
      counts: counts([]),
      index: 'missing',
      apps: [],
    };
  }
  const config = readConfig(root);
  const artifacts = walkArtifacts(root);
  return {
    initialized: true,
    config,
    issues: configIssues(config),
    artifacts,
    counts: counts(artifacts),
    index: indexStatus(root, artifacts),
    apps: (config?.apps || []).map((app) => app.name),
  };
}

/**
 * Cheap change detector for caching: file count plus newest mtime under .fyi/,
 * using stat only (no reads or hashing).
 */
export function storeFingerprint(root) {
  const store = storePath(root);
  if (!existsSync(store)) return 'missing';
  let files = 0;
  let newest = 0;
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSafe(abs);
      if (!stat) continue;
      files++;
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  };
  visit(store);
  return `${files}:${newest}`;
}

export function rebuildIndex(root, artifacts = walkArtifacts(root)) {
  assertSafeStoreRoot(root, { allowMissing: false });
  const config = readConfig(root) || emptyConfig(root);
  const summary = counts(artifacts);
  const index = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    store: '.fyi',
    counts: summary,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      description: artifact.description,
      apps: artifact.apps,
      tags: artifact.tags,
      owner: artifact.owner,
      status: artifact.status,
      updated: artifact.updated,
      path: artifact.path,
      hash: artifactHash(artifact),
      archived: artifact.archived,
    })),
  };

  const json = `${JSON.stringify(index, null, 2)}\n`;
  const markdown = renderIndexMarkdown(config, artifacts);
  const store = storePath(root);
  ensureDir(store);
  const destinations = [indexMarkdownPath(root), indexPath(root)];
  const modes = destinations.map((path) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${path}`);
    if (!stat.isFile()) throw new Error(`refusing to replace non-file: ${path}`);
    return stat.mode & 0o777;
  });
  const staging = mkdtempSync(join(store, '.index-'));
  try {
    const staged = [join(staging, 'INDEX.md'), join(staging, 'index.json')];
    writeFileSync(staged[0], markdown, { mode: modes[0] });
    writeFileSync(staged[1], json, { mode: modes[1] });
    // Separate renames cannot make the pair atomic, including across crashes.
    // Publish JSON last so a failed Markdown update cannot mark it fresh.
    for (let i = 0; i < destinations.length; i++) {
      if (isSymlink(destinations[i])) {
        throw new Error(`refusing to write through symlink: ${destinations[i]}`);
      }
      renameSync(staged[i], destinations[i]);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { index, summary };
}

export function renderIndexMarkdown(config, artifacts) {
  const active = artifacts.filter((artifact) => !artifact.archived);
  const apps = (config?.apps || []).map((app) => app.name).filter(Boolean);
  const lines = [
    '# fyi index',
    '',
    '<!-- Generated by `fyi index`. Do not edit by hand. -->',
    '',
    `Generated ${today()} · ${active.length} artifact${active.length === 1 ? '' : 's'}${
      apps.length ? ` · apps: ${apps.join(', ')}` : ''
    }`,
    '',
  ];

  for (const type of ARTIFACT_TYPES) {
    const items = active
      .filter((artifact) => artifact.type === type)
      .sort((a, b) => a.title.localeCompare(b.title));
    if (!items.length) continue;
    lines.push(`## ${TYPE_LABELS[type]}`, '');
    for (const artifact of items) {
      const meta = [];
      if (artifact.apps.length) meta.push(artifact.apps.join(', '));
      if (artifact.tags.length) meta.push(artifact.tags.join(', '));
      if (artifact.status !== 'active') meta.push(artifact.status);
      lines.push(
        `- [${artifact.title}](${artifact.path})${
          artifact.description ? ` — ${oneLine(artifact.description, 120)}` : ''
        }${meta.length ? ` · ${meta.join(' · ')}` : ''}`,
      );
    }
    lines.push('');
  }

  const archived = artifacts.filter((artifact) => artifact.archived);
  if (archived.length) {
    lines.push('## Archived', '');
    for (const artifact of archived) lines.push(`- ${artifact.title} (${artifact.path})`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function eqCI(value, needle) {
  return String(value).toLowerCase() === String(needle).toLowerCase();
}

export function matchFilters(artifact, filters = {}) {
  if (!filters.includeArchived && artifact.archived) return false;
  if (filters.type?.length && !filters.type.includes(artifact.type)) return false;
  if (filters.app?.length && !filters.app.some((app) => artifact.apps.some((value) => eqCI(value, app)))) {
    return false;
  }
  if (filters.tag?.length && !filters.tag.some((tag) => artifact.tags.some((value) => eqCI(value, tag)))) {
    return false;
  }
  if (filters.status?.length && !filters.status.some((status) => eqCI(status, artifact.status))) {
    return false;
  }
  if (filters.owner?.length && !filters.owner.some((owner) => eqCI(owner, artifact.owner))) {
    return false;
  }
  return true;
}

export function searchArtifacts(artifacts, query, filters = {}) {
  const text = String(query || '').trim().toLowerCase();
  const rawTerms = text.split(/\s+/).filter(Boolean);
  const terms = unique(
    rawTerms
      .map((term) => term.replace(/^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu, ''))
      .filter(Boolean),
  );
  const effectiveTerms = terms.length ? terms : rawTerms;
  const filtered = artifacts.filter((artifact) => matchFilters(artifact, filters));

  if (!effectiveTerms.length) {
    return filtered.map((artifact) => ({ artifact, score: 0, snippet: '' }));
  }

  const results = [];
  for (const artifact of filtered) {
    const title = artifact.title.toLowerCase();
    const description = artifact.description.toLowerCase();
    const body = artifact.body.toLowerCase();
    const id = artifact.id.toLowerCase();
    let score = 0;

    if (title === text) score += 100;
    if (title.includes(text)) score += 40;
    if (id.includes(text)) score += 20;

    for (const term of effectiveTerms) {
      if (title.includes(term)) score += 20;
      if (artifact.tags.some((tag) => tag.toLowerCase().includes(term))) score += 15;
      if (artifact.apps.some((app) => app.toLowerCase().includes(term))) score += 12;
      if (description.includes(term)) score += 8;
      if (id.includes(term)) score += 6;
      const occurrences = countOccurrences(body, term);
      if (occurrences) score += Math.min(occurrences, 5) * 2;
    }

    if (score > 0) results.push({ artifact, score, snippet: makeSnippet(artifact, effectiveTerms) });
  }

  return results.sort(
    (a, b) => b.score - a.score || a.artifact.title.localeCompare(b.artifact.title),
  );
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while (true) {
    index = haystack.indexOf(needle, index);
    if (index === -1) return count;
    count++;
    index += needle.length;
  }
}

function makeSnippet(artifact, terms) {
  const body = artifact.body.replace(/\s+/g, ' ');
  const lower = body.toLowerCase();
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1) {
      const start = Math.max(0, index - 70);
      const end = Math.min(body.length, index + term.length + 90);
      return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${
        end < body.length ? '…' : ''
      }`;
    }
  }
  return oneLine(artifact.description || artifact.body, 160);
}

export function findArtifact(artifacts, needle) {
  const query = String(needle || '').trim();
  if (!query) return null;
  const normalized = query.replace(/^\.fyi\//, '').replace(/\.md$/, '').toLowerCase();
  return (
    artifacts.find((artifact) => artifact.id.toLowerCase() === normalized) ||
    artifacts.find((artifact) => artifact.path.toLowerCase() === normalized) ||
    artifacts.find((artifact) => artifact.id.toLowerCase().endsWith(`/${normalized}`)) ||
    artifacts.find((artifact) => artifact.title.toLowerCase() === query.toLowerCase()) ||
    null
  );
}

export function findCandidates(artifacts, needle) {
  const query = String(needle || '').trim().toLowerCase();
  if (!query) return [];
  return artifacts.filter((artifact) => artifact.title.toLowerCase().includes(query));
}

export function publicArtifact(artifact) {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    description: artifact.description,
    apps: artifact.apps,
    tags: artifact.tags,
    owner: artifact.owner,
    status: artifact.status,
    updated: artifact.updated,
    path: artifact.path,
    archived: artifact.archived,
  };
}

export function storeReadme(root) {
  return `# fyi

This directory is the project's shared memory. It is version-controlled, reviewed like code, and read by both people and agents.

| Path | Holds |
|---|---|
| \`knowledge/\` | Business, domain, and architecture facts, grouped by app |
| \`patterns/\` | Reusable investigation recipes: log searches, traces, repros |
| \`runbooks/\` | Operational procedures: deploy, rollback, incident, migration |
| \`docs/\` | Durable documents and pointers to specs, ADRs, contracts |
| \`scripts/\` | Runnable helpers with metadata and usage notes |
| \`INDEX.md\` | Generated catalog. Do not edit by hand. |
| \`index.json\` | Generated machine index. Do not edit by hand. |
| \`config.json\` | Store configuration and detected apps |

Start with \`fyi find "<symptom>"\` before re-deriving a debugging flow. Capture a reusable recipe with \`fyi new pattern "<title>"\`.

If \`fyi\` is not on PATH, run \`node .claude/skills/fyi/scripts/fyi.mjs <command>\` from the repo root, or add that command as an alias.

Run \`fyi help\` for commands, or read the skill at \`.claude/skills/fyi/SKILL.md\`.
`;
}

export function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
