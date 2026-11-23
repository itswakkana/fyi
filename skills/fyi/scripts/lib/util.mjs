import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.1';
export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SCRIPTS_DIR = join(SKILL_DIR, 'scripts');

const VALUE_FLAGS = new Set([
  'root',
  'app',
  'apps',
  'tag',
  'tags',
  'type',
  'status',
  'owner',
  'description',
  'title',
  'file',
  'ext',
  'related',
  'target',
  'limit',
  'agent',
  'agents',
  'host',
  'source',
]);

const BOOLEAN_FLAGS = new Set([
  'json',
  'fix',
  'dry-run',
  'refresh',
  'init',
  'hooks',
  'force',
  'include-archived',
  'archived',
  'include-packages',
  'help',
  'version',
]);

export const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

/** Minimal argv parser: positionals plus --flag, --key value, --key=value. */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const set = (key, value) => {
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
    } else {
      flags[key] = value;
    }
  };
  const isKnownFlag = (token) => {
    if (!token.startsWith('-')) return false;
    const name = token.replace(/^--?/, '');
    return KNOWN_FLAGS.has(name);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Everything after "--" is positional, but a --root in the tail must
      // still be honoured, or writes would land in the wrong tree.
      const tail = argv.slice(i + 1);
      const rest = [];
      for (let j = 0; j < tail.length; j++) {
        if (tail[j] === '--root') {
          if (tail[j + 1] !== undefined) {
            set('root', tail[j + 1]);
            j++;
          } else {
            flags.root = true;
          }
          continue;
        }
        if (tail[j].startsWith('--root=')) {
          set('root', tail[j].slice('--root='.length));
          continue;
        }
        rest.push(tail[j]);
      }
      positionals.push(...rest);
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const raw = arg.slice(eq + 1);
        set(key, BOOLEAN_FLAGS.has(key) ? raw !== 'false' : raw);
        continue;
      }
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        set(key, true);
        continue;
      }
      const next = argv[i + 1];
      // A value flag consumes the next token, even when it looks like a flag.
      // A token that is a flag this CLI knows about means the value is missing.
      if (next !== undefined && !isKnownFlag(next)) {
        set(key, next);
        i++;
      } else {
        set(key, true);
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      if (key === 'h' || key === 'v') {
        set(key === 'h' ? 'help' : 'version', true);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !isKnownFlag(next)) {
        set(key, next);
        i++;
      } else {
        set(key, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

/** Flatten one or more flag values into a clean string array. */
export function flagList(flags, ...names) {
  const out = [];
  for (const name of names) {
    const value = flags[name];
    if (value === undefined || value === true || value === false) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      for (const part of String(item).split(',')) {
        const trimmed = part.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return [...new Set(out)];
}

/** Resolve the nearest store or project boundary without crossing a nested project. */
export function findProjectRoot(start = process.cwd()) {
  const begin = resolve(start);
  let dir = begin;
  while (true) {
    if (
      existsSync(join(dir, '.fyi')) ||
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, '.claude', 'skills', 'fyi')) ||
      existsSync(join(dir, '.agents', 'skills', 'fyi')) ||
      existsSync(join(dir, '.opencode', 'skills', 'fyi'))
    ) return dir;
    const parent = dirname(dir);
    if (parent === dir) return begin;
    dir = parent;
  }
}

/** Accept either a project root or the .fyi directory itself. */
export function normalizeRoot(input) {
  const abs = resolve(String(input));
  return basenameSafe(abs) === '.fyi' ? dirname(abs) : abs;
}

export function storeDir(root) {
  return join(root, '.fyi');
}

export function toPosix(path) {
  return String(path).replace(/\\/g, '/');
}

export function relPosix(from, to) {
  return toPosix(relative(from, to));
}

export function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 6);
}

export function slugify(value) {
  const raw = String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let slug = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return `untitled-${shortHash(raw)}`;
  if (slug.length > 80) {
    slug = `${slug.slice(0, 72).replace(/-+$/g, '')}-${shortHash(raw)}`;
  }
  return slug;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function unique(values) {
  return [...new Set(values)];
}

export function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** App names become directory components; reject anything that can escape. */
export function isSafeAppName(app) {
  return (
    typeof app === 'string' &&
    Boolean(app) &&
    app !== '.' &&
    app !== '..' &&
    !app.startsWith('.') &&
    !app.includes('/') &&
    !app.includes('\\') &&
    !app.includes('\0')
  );
}

/** Refuse to write through a symlink, which could redirect outside the store. */
export function assertSafeStoreRoot(root, { allowMissing = true } = {}) {
  const store = join(resolve(root), '.fyi');
  if (isSymlink(store)) throw new Error(`.fyi is a symlink; refusing to write through it: ${store}`);
  if (existsSync(store) && !isDir(store)) throw new Error(`.fyi exists but is not a directory: ${store}`);
  if (!allowMissing && !existsSync(store)) throw new Error(`store is not initialized: ${store}`);
  return store;
}

export function safeWriteFile(path, data, options) {
  if (isSymlink(path)) {
    throw new Error(`refusing to write through symlink: ${path}`);
  }
  writeFileSync(path, data, options);
}

export function realpathSafe(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when target's nearest existing parent resolves inside parent. */
export function isInsideReal(parent, target) {
  const parentReal = realpathSafe(parent);
  let probe = dirname(target);
  while (!existsSync(probe)) probe = dirname(probe);
  const targetReal = realpathSafe(probe);
  const rel = relative(parentReal, targetReal);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function mtimeDate(path) {
  try {
    return statSync(path).mtime.toISOString().slice(0, 10);
  } catch {
    return today();
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(path, data) {
  ensureDir(dirname(path));
  safeWriteFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function firstHeading(markdown) {
  const match = /^#\s+(.+)$/m.exec(String(markdown || ''));
  return match ? match[1].trim() : '';
}

export function oneLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function basenameSafe(path) {
  const trimmed = String(path).replace(/[\\/]+$/g, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function extOf(path) {
  return extname(path).toLowerCase();
}

export function color(code, text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function print(line = '') {
  process.stdout.write(`${line}\n`);
}

export function warn(line) {
  process.stderr.write(`${line}\n`);
}

export function fail(message) {
  warn(color('31', `fyi: ${message}`));
  return 1;
}

export { sep };
