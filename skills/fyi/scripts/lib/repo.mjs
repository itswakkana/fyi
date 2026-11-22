import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDir, toPosix } from './util.mjs';

const MANIFESTS = [
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'deno.json',
];

const IGNORED = new Set([
  'node_modules',
  '.git',
  '.fyi',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  'target',
  'vendor',
  '.cache',
]);

const APP_NAME =
  /(^|[/-])(app|apps|web|api|service|services|worker|admin|mobile|frontend|backend|server|client|dashboard|portal|gateway|bff)([/-]|$)/i;

/** Best-effort monorepo app detection. Evidence only; the user confirms ownership. */
export function detectApps(root) {
  const patterns = collectPatterns(root);
  const found = new Map();
  const add = (rel, description = '') => {
    const path = toPosix(rel);
    if (!path || found.has(path)) return;
    const name = basename(path);
    found.set(path, {
      name,
      path,
      kind: kindFor(path, name),
      description: String(description || '').trim(),
    });
  };

  const negatives = new Set();
  for (const pattern of patterns) {
    if (!pattern.startsWith('!')) continue;
    for (const rel of matchDirs(root, pattern.slice(1))) negatives.add(rel);
  }

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    for (const rel of matchDirs(root, pattern)) {
      if (negatives.has(rel)) continue;
      const full = join(root, rel);
      if (!hasManifest(full)) continue;
      add(rel, readDescription(full));
    }
  }

  // Always union the conventional directories with workspace globs, so a
  // workspace that lists only apps/* does not hide services/ or packages/.
  for (const dir of ['apps', 'packages', 'services', 'modules', 'libs']) {
    const base = join(root, dir);
    if (!isDir(base)) continue;
    for (const name of readdirSync(base)) {
      if (IGNORED.has(name) || name.startsWith('.')) continue;
      const rel = `${dir}/${name}`;
      if (negatives.has(rel)) continue;
      const full = join(root, rel);
      if (!isDir(full) || !hasManifest(full)) continue;
      add(rel, readDescription(full));
    }
  }

  qualifyDuplicateNames(found);
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function kindFor(path, name) {
  if (path.startsWith('packages/') || path.startsWith('libs/')) return 'package';
  if (path.startsWith('apps/') || path.startsWith('services/')) return 'app';
  return APP_NAME.test(`${name}/${path}`) ? 'app' : 'package';
}

function qualifyDuplicateNames(found) {
  const byName = new Map();
  for (const app of found.values()) {
    if (!byName.has(app.name)) byName.set(app.name, []);
    byName.get(app.name).push(app);
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    for (const app of group) {
      const parent = basename(dirname(app.path)) || 'root';
      app.name = `${parent}-${name}`;
      app.qualified = true;
    }
  }

  // Keep existing names unless they collide, then add more path context.
  const apps = [...found.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const depths = new Map(apps.map((app) => [app, 2]));
  while (true) {
    const groups = new Map();
    for (const app of apps) {
      if (!groups.has(app.name)) groups.set(app.name, []);
      groups.get(app.name).push(app);
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1);
    if (!collisions.length) break;

    let expanded = false;
    for (const group of collisions) {
      for (const app of group) {
        if (!app.qualified) continue;
        const parts = app.path.split('/');
        const depth = depths.get(app);
        if (depth >= parts.length) continue;
        depths.set(app, depth + 1);
        app.name = parts.slice(-(depth + 1)).join('-');
        expanded = true;
      }
    }
    if (expanded) continue;

    // Hyphens in path components can make even full paths ambiguous.
    const used = new Set(apps.map((app) => app.name));
    for (const group of collisions) {
      for (const app of group) {
        if (!app.qualified) continue;
        const base = app.name;
        let suffix = 2;
        while (used.has(`${base}-${suffix}`)) suffix++;
        app.name = `${base}-${suffix}`;
        used.add(app.name);
      }
    }
  }
}

function collectPatterns(root) {
  const patterns = [];

  const pkg = readJsonFile(join(root, 'package.json'));
  if (pkg) {
    const workspaces = pkg.workspaces;
    const list = Array.isArray(workspaces)
      ? workspaces
      : workspaces && Array.isArray(workspaces.packages)
        ? workspaces.packages
        : [];
    patterns.push(...list.filter((item) => typeof item === 'string'));
  }

  const pnpm = readText(join(root, 'pnpm-workspace.yaml'));
  if (pnpm) {
    let inPackages = false;
    for (const line of pnpm.split(/\r?\n/)) {
      const inline = /^\s*packages\s*:\s*\[(.*)\]\s*$/.exec(line);
      if (inline) {
        for (const part of splitInline(inline[1])) patterns.push(unquote(part.trim()));
        inPackages = false;
        continue;
      }
      if (/^\s*packages\s*:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (!inPackages) continue;
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) {
        const pattern = stripYamlComment(item[1]).trim().replace(/^['"]|['"]$/g, '');
        if (pattern) patterns.push(pattern);
      } else if (/^\S/.test(line) && !line.trim().startsWith('#')) inPackages = false;
    }
  }

  const lerna = readJsonFile(join(root, 'lerna.json'));
  if (lerna && Array.isArray(lerna.packages)) {
    patterns.push(...lerna.packages.filter((item) => typeof item === 'string'));
  }

  if (!patterns.length) {
    patterns.push('apps/*', 'packages/*', 'services/*', 'modules/*', 'libs/*');
  }
  return [...new Set(patterns)];
}

function matchDirs(root, pattern) {
  let glob = String(pattern || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!glob) return [];

  if (!glob.includes('*')) {
    return isDir(join(root, glob)) ? [glob] : [];
  }

  const regex = globToRegex(glob);
  const out = [];
  walkDirs(root, '', 0, (rel) => {
    if (regex.test(rel)) out.push(rel);
  });
  return out;
}

function globToRegex(glob) {
  const segments = glob.split('/').map((segment) => {
    if (segment === '**') return '.*';
    return segment
      .split('*')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
  });
  return new RegExp(`^${segments.join('/')}$`);
}

function walkDirs(root, rel, depth, visit) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    visit(child);
    walkDirs(root, child, depth + 1, visit);
  }
}

function splitInline(text) {
  const parts = [];
  let current = '';
  let quote = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Strip a trailing YAML comment, respecting quoted values. */
function stripYamlComment(value) {
  const text = String(value);
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

function unquote(text) {
  const value = String(text).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function hasManifest(dir) {
  return MANIFESTS.some((manifest) => existsSync(join(dir, manifest)));
}

function readDescription(dir) {
  const pkg = readJsonFile(join(dir, 'package.json'));
  return pkg?.description || '';
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
