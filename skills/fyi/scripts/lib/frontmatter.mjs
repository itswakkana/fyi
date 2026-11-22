/**
 * A deliberately small YAML subset for fyi frontmatter.
 * Supports scalars, quoted strings, inline arrays, and block arrays.
 * It is not a general YAML parser. The CLI never round-trips a whole
 * hand-written file; updates are surgical so unsupported constructs survive.
 */

const SHELL_EXTS = new Set(['.sh', '.bash', '.zsh', '.py', '.rb']);

export const FRONTMATTER_ORDER = [
  'type',
  'title',
  'description',
  'apps',
  'tags',
  'owner',
  'status',
  'updated',
  'related',
];

export const KNOWN_KEYS = new Set(FRONTMATTER_ORDER);

export function parseMarkdown(text) {
  const source = String(text);
  // The closing fence must start its own line; a value ending in "---" is not a fence.
  const match = /^(?:﻿)?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { data: {}, body: source.trim(), hasFrontmatter: false };
  const data = parseYaml(match[1] || '');
  // A horizontal rule followed by prose is not frontmatter. Require at least one
  // known key so a Markdown document is never mistaken for an artifact.
  if (!hasKnownKey(data)) {
    return { data: {}, body: source.trim(), hasFrontmatter: false };
  }
  return {
    data,
    body: source.slice(match[0].length).trim(),
    hasFrontmatter: true,
  };
}

export function parseScript(text, ext) {
  const source = String(text);
  if (SHELL_EXTS.has(ext)) return parseHashScript(source);
  return parseJsScript(source);
}

/**
 * Locate a script metadata block.
 * The block must be the first content after the shebang (or the first comment
 * block) so a `---` section divider deeper in the file is never mistaken for
 * metadata, and it must contain at least two known keys.
 */
function findScriptBlock(lines, markerPattern, stripPattern) {
  let start = -1;
  for (let i = 0; i < lines.length && i < 40; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (markerPattern.test(line)) {
      start = i;
      break;
    }
    // Only a leading comment block may precede the metadata.
    if (!/^\s*(?:#!|\/\/|#|\*)/.test(line)) return null;
  }
  if (start === -1) return null;

  for (let i = start + 1; i < lines.length && i < start + 40; i++) {
    if (markerPattern.test(lines[i])) {
      const block = lines.slice(start + 1, i).map((line) => line.replace(stripPattern, ""));
      const data = parseYaml(block.join("\n"));
      if (knownKeyCount(data) >= 2 || data.type === "script") {
        return { start, end: i, data };
      }
      return null;
    }
  }
  return null;
}

function knownKeyCount(data) {
  return Object.keys(data).filter((key) => KNOWN_KEYS.has(key)).length;
}

function parseJsScript(source) {
  const lines = source.split(/\r?\n/);
  const block = findScriptBlock(lines, /^\s*\/\/\s*---\s*$/, /^\s*\/\/\s?/);
  if (block) {
    return { data: block.data, body: source.trim(), hasFrontmatter: true };
  }

  // Compatibility: a leading block comment carrying --- fences.
  const comment = /^\s*(?:#![^\n]*\n\s*)?\/\*\*?([\s\S]*?)\*\//.exec(source);
  if (comment) {
    const cleaned = comment[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, ""))
      .join("\n");
    const fenced = extractFences(cleaned);
    if (fenced !== null) {
      const data = parseYaml(fenced);
      if (hasKnownKey(data)) return { data, body: source.trim(), hasFrontmatter: true };
    }
  }

  return { data: {}, body: source.trim(), hasFrontmatter: false };
}

function parseHashScript(source) {
  const lines = source.split(/\r?\n/);
  const block = findScriptBlock(lines, /^\s*#\s*---\s*$/, /^\s*#\s?/);
  if (block) {
    return { data: block.data, body: source.trim(), hasFrontmatter: true };
  }
  return { data: {}, body: source.trim(), hasFrontmatter: false };
}

function extractFences(text) {
  const match = /(?:^|\n)[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? match[1] : null;
}

function hasKnownKey(data) {
  return Object.keys(data).some((key) => KNOWN_KEYS.has(key));
}

export function parseYaml(source) {
  const out = {};
  const lines = String(source).split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) {
      index++;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) {
      index++;
      continue;
    }
    const key = match[1];
    const rest = stripInlineComment(match[2].trim());

    if (rest === '') {
      const items = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const current = lines[cursor];
        if (/^\s*$/.test(current) || /^\s*#/.test(current)) {
          cursor++;
          continue;
        }
        const item = /^\s*-\s+(.*)$/.exec(current);
        if (!item) break;
        items.push(parseScalar(stripInlineComment(item[1].trim())));
        cursor++;
      }
      if (items.length) {
        out[key] = items;
        index = cursor;
        continue;
      }
      out[key] = '';
      index++;
      continue;
    }

    out[key] = parseScalar(rest);
    index++;
  }

  return out;
}

function stripInlineComment(value) {
  const text = String(value);
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[' || char === '{') {
      depth++;
      continue;
    }
    if (char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === '#' && depth === 0 && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

export function parseScalar(value) {
  const text = String(value).trim();
  if (text === '') return '';
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    return inner ? splitInline(inner).map((part) => parseScalar(part)) : [];
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return unquote(text);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    // Preserve formatting such as 007 or 1.0 instead of silently rewriting it.
    return String(number) === text ? number : text;
  }
  return text;
}

function splitInline(text) {
  const parts = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
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

function unquote(text) {
  const quote = text[0];
  let inner = text.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(text);
    } catch {
      // Preserve the existing permissive handling of non-JSON YAML strings.
      inner = inner.replace(/\\(?:"|n|\\)/g, (escape) => ({ '\\"': '"', '\\n': '\n', '\\\\': '\\' })[escape]);
    }
  } else {
    inner = inner.replace(/''/g, "'");
  }
  return inner;
}

export function formatScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  if (text === '') return '""';
  const needsQuote =
    /^\s|\s$/.test(text) ||
    /[\r\n\t]/.test(text) ||
    /---/.test(text) ||
    /[:#\[\]{},&*!|>'"%@`]/.test(text) ||
    /^(true|false|null|~)$/i.test(text) ||
    /^-?\d+(\.\d+)?$/.test(text);
  return needsQuote ? JSON.stringify(text) : text;
}

export function stringifyYaml(data, order = FRONTMATTER_ORDER) {
  const keys = [
    ...order.filter((key) => key in data),
    ...Object.keys(data).filter((key) => !order.includes(key)),
  ];
  return keys
    .filter((key) => data[key] !== undefined)
    .map((key) => {
      const value = data[key];
      if (Array.isArray(value)) {
        return `${key}: [${value.map((item) => formatScalar(item)).join(', ')}]`;
      }
      return `${key}: ${formatScalar(value)}`;
    })
    .join('\n');
}

export function stringifyMarkdown(data, body, order = FRONTMATTER_ORDER) {
  const yaml = stringifyYaml(data, order);
  const text = String(body || '').trim();
  return `---\n${yaml}\n---\n\n${text}${text ? '\n' : ''}`;
}

export function stringifyScriptFrontmatter(data, ext) {
  const yaml = stringifyYaml(data);
  if (SHELL_EXTS.has(ext)) {
    return `# ---\n${yaml
      .split('\n')
      .map((line) => `# ${line}`)
      .join('\n')}\n# ---\n`;
  }
  // Line comments avoid closing a block comment early when a value contains */.
  return `// ---\n${yaml
    .split('\n')
    .map((line) => `// ${line}`)
    .join('\n')}\n// ---\n`;
}

/** Add frontmatter to a script without displacing a shebang. */
export function prependScriptFrontmatter(text, ext, data, force = false) {
  if (!force && parseScript(text, ext).hasFrontmatter) return text;
  const block = stringifyScriptFrontmatter(data, ext);
  if (text.startsWith('#!')) {
    const newline = text.indexOf('\n');
    if (newline === -1) return `${text}\n${block}`;
    return `${text.slice(0, newline + 1)}${block}${text.slice(newline + 1)}`;
  }
  return `${block}${text}`;
}

/** Remove an existing frontmatter block, preserving the script body and shebang. */
export function stripScriptFrontmatter(text, ext) {
  const source = String(text);
  const lines = source.split(/\r?\n/);
  const shell = SHELL_EXTS.has(ext);
  const marker = shell ? /^\s*#\s*---\s*$/ : /^\s*\/\/\s*---\s*$/;
  const strip = shell ? /^\s*#\s?/ : /^\s*\/\/\s?/;

  const block = findScriptBlock(lines, marker, strip);
  if (block) {
    return [...lines.slice(0, block.start), ...lines.slice(block.end + 1)].join('\n');
  }

  if (!shell) {
    const comment = /^(\s*(?:#![^\n]*\n\s*)?)\/\*\*?([\s\S]*?)\*\//.exec(source);
    if (comment) {
      const cleaned = comment[2]
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*\s?/, ''))
        .join('\n');
      const fenced = extractFences(cleaned);
      if (fenced !== null && hasKnownKey(parseYaml(fenced))) {
        return source.slice(0, comment.index) + comment[1] + source.slice(comment.index + comment[0].length);
      }
    }
  }

  return source;
}

/** Replace an existing block, or prepend one when absent. */
export function upsertScriptFrontmatter(text, ext, data) {
  return prependScriptFrontmatter(stripScriptFrontmatter(text, ext), ext, data, true);
}

function findMarkerPair(lines, pattern) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length && i < 100; i++) {
    if (pattern.test(lines[i])) {
      if (start === -1) start = i;
      else {
        end = i;
        break;
      }
    }
  }
  return [start, end];
}

/** True when a script's existing frontmatter is flat YAML the CLI can merge safely. */
export function scriptFrontmatterIsSimple(text, ext) {
  const source = String(text);
  const lines = source.split(/\r?\n/);
  let block = null;

  if (SHELL_EXTS.has(ext)) {
    const found = findScriptBlock(lines, /^\s*#\s*---\s*$/, /^\s*#\s?/);
    if (found) block = lines.slice(found.start + 1, found.end).map((line) => line.replace(/^\s*#\s?/, ''));
  } else {
    const found = findScriptBlock(lines, /^\s*\/\/\s*---\s*$/, /^\s*\/\/\s?/);
    if (found) {
      block = lines.slice(found.start + 1, found.end).map((line) => line.replace(/^\s*\/\/\s?/, ''));
    } else {
      const comment = /^\s*(?:#![^\n]*\n\s*)?\/\*\*?([\s\S]*?)\*\//.exec(source);
      if (comment) {
        const cleaned = comment[1].split(/\r?\n/).map((line) => line.replace(/^\s*\*\s?/, '')).join('\n');
        const fenced = extractFences(cleaned);
        if (fenced !== null && hasKnownKey(parseYaml(fenced))) block = fenced.split('\n');
      }
    }
  }

  if (!block) return true;

  for (const raw of block) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    // Indented lines are nested maps or continuation scalars, which the parser cannot represent.
    if (/^\s+\S/.test(raw) && !/^\s*-\s+/.test(raw)) return false;
    const line = raw.trim();
    if (/^[A-Za-z0-9_.-]+:\s*[>|]/.test(line)) return false;
    if (/^[A-Za-z0-9_.-]+:\s*.*$/.test(line)) continue;
    if (/^-\s+.*$/.test(line)) continue;
    return false;
  }
  return true;
}

/**
 * Surgically set `updated` inside an existing frontmatter block by editing
 * lines. Every other line, including unsupported YAML and its line endings,
 * is preserved.
 */
export function stampFrontmatterUpdated(absPath, date, readFile, writeFile) {
  const source = readFile(absPath, 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const first = (lines[0] || '').replace(/^﻿/, '');
  if (!/^---[ \t]*$/.test(first)) return false;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return false;

  // Only stamp a block that is genuinely frontmatter. A Markdown document that
  // opens with a horizontal rule must never be written into.
  const block = lines.slice(1, end).join('\n');
  if (!hasKnownKey(parseYaml(block))) return false;

  let updated = -1;
  for (let i = 1; i < end; i++) {
    if (/^updated:/.test(lines[i])) {
      updated = i;
      break;
    }
  }

  if (updated !== -1) lines[updated] = `updated: ${date}`;
  else lines.splice(end, 0, `updated: ${date}`);

  writeFile(absPath, lines.join(eol));
  return true;
}
