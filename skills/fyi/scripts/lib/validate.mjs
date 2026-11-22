import { existsSync } from 'node:fs';
import { indexMarkdownPath, indexStatus, SCRIPT_EXTS, TYPE_DIRS } from './store.mjs';
import { configIssues } from './store.mjs';
import { oneLine, today } from './util.mjs';

const STATUSES = new Set(['active', 'draft', 'stale', 'deprecated']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXAMPLE_WORD = /\b(examples?|sample|placeholder|redacted|changeme|change-me|dummy|fake|todo)\b/i;
const PLACEHOLDER_VALUE = /^(?:<[^>]*>|\{\{[\s\S]*\}\})$/;

const SECRET_PATTERNS = [
  { kind: 'aws-access-key', severity: 'error', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private-key', severity: 'error', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'github-token', severity: 'error', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'slack-token', severity: 'error', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'provider-api-key', severity: 'error', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: 'bearer-token', severity: 'error', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  {
    kind: 'credential-assignment',
    severity: 'warning',
    re: /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?([^\s'"]{6,})/gi,
  },
];

export function scanSecrets(text) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const pattern of SECRET_PATTERNS) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(line)) !== null) {
        // A value that is itself a placeholder is ignored. The word "example"
        // elsewhere on the line must not hide a real key.
        const value = match[2] !== undefined ? match[2] : match[0];
        const trimmed = String(value).trim().replace(/^['"]|['"]$/g, '');
        if (EXAMPLE_WORD.test(match[0]) || PLACEHOLDER_VALUE.test(trimmed)) continue;
        findings.push({ kind: pattern.kind, severity: pattern.severity, line: lineIndex + 1 });
        if (match[0].length === 0) break;
      }
    }
  }
  return findings;
}

export function validateArtifact(artifact, config) {
  const errors = [];
  const warnings = [];

  if (!artifact.title) errors.push('missing title');
  if (!artifact.type) errors.push('missing type');
  if (!Object.keys(TYPE_DIRS).includes(artifact.type)) {
    warnings.push(`unknown type: ${artifact.type}`);
  }
  const declaredType = String(artifact.data?.type || '').trim();
  if (declaredType && declaredType !== artifact.type) {
    warnings.push(
      `type "${declaredType}" disagrees with the ${artifact.type} directory; the directory wins`,
    );
  }
  if (!artifact.description) warnings.push('missing description');
  if (!artifact.hasFrontmatter) warnings.push('missing frontmatter');
  if (!DATE.test(artifact.updated)) warnings.push(`invalid updated date: ${artifact.updated}`);
  if (!STATUSES.has(artifact.status)) warnings.push(`unknown status: ${artifact.status}`);

  const shared =
    artifact.apps.some((app) => app.toLowerCase() === 'shared') ||
    artifact.path.startsWith('knowledge/shared/');
  const knownApps = new Set((config?.apps || []).map((app) => app.name.toLowerCase()));
  if (knownApps.size) {
    for (const app of artifact.apps) {
      if (app.toLowerCase() === 'shared') continue;
      if (!knownApps.has(app.toLowerCase())) warnings.push(`unknown app: ${app}`);
    }
    if (artifact.type === 'knowledge' && !artifact.apps.length && !shared) {
      warnings.push('knowledge has no app scope');
    }
  }

  for (const finding of scanSecrets(artifact.raw || artifact.body)) {
    const message = `possible secret (${finding.kind}) at line ${finding.line}`;
    if (finding.severity === 'error') errors.push(message);
    else warnings.push(message);
  }

  return { errors, warnings };
}

export function validateStore(root, artifacts, config) {
  const errors = [];
  const warnings = [];
  const info = [];

  for (const issue of configIssues(config)) warnings.push(`config: ${issue}`);

  for (const artifact of artifacts) {
    const result = validateArtifact(artifact, config);
    for (const error of result.errors) errors.push(`${artifact.path}: ${error}`);
    for (const warning of result.warnings) warnings.push(`${artifact.path}: ${warning}`);
  }

  const byTitle = new Map();
  for (const artifact of artifacts) {
    if (artifact.archived) continue;
    const key = artifact.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(artifact);
  }
  for (const [title, group] of byTitle) {
    if (group.length > 1) {
      warnings.push(
        `duplicate title "${title}": ${group.map((artifact) => artifact.path).join(', ')}`,
      );
    }
  }

  const ids = new Set(artifacts.map((artifact) => artifact.id));
  for (const artifact of artifacts) {
    for (const related of artifact.related) {
      if (!ids.has(related)) {
        warnings.push(`${artifact.path}: related id not found: ${related}`);
      }
    }
  }

  const staleAfter = Number(config?.settings?.staleAfterDays);
  const days = Number.isFinite(staleAfter) && staleAfter > 0 ? staleAfter : 180;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  for (const artifact of artifacts) {
    if (artifact.archived) continue;
    if (artifact.status === 'active' && DATE.test(artifact.updated) && artifact.updated < cutoff) {
      warnings.push(`${artifact.path}: stale (updated ${artifact.updated}, older than ${days}d)`);
    }
  }

  for (const artifact of artifacts) {
    if (artifact.type === 'script' && !artifact.hasFrontmatter) {
      warnings.push(`${artifact.path}: script has no metadata frontmatter`);
    }
  }

  if (!existsSync(indexMarkdownPath(root))) {
    errors.push('INDEX.md is missing; run `fyi index`');
  }
  const status = indexStatus(root, artifacts);
  if (status === 'missing') errors.push('index.json is missing; run `fyi index`');
  else if (status === 'stale') warnings.push('index is stale; run `fyi index`');

  if (config && config.schemaVersion !== 1) {
    warnings.push(`config schemaVersion is ${config.schemaVersion}, expected 1`);
  }
  if (!config) errors.push('config.json is missing or unreadable; run `fyi init`');

  info.push(`checked ${artifacts.length} artifacts on ${today()}`);
  return { errors, warnings, info };
}

function appScope(artifact) {
  const match = /^knowledge\/([^/]+)\//.exec(artifact.path);
  return match ? match[1] : null;
}

function isAppOverview(artifact) {
  return /^knowledge\/[^/]+\/overview\.md$/.test(artifact.path);
}

/** Same-type, high-overlap pairs that are likely duplicates. */
export function findNearDuplicates(artifacts, threshold = 0.55) {
  const pairs = [];
  const active = artifacts.filter((artifact) => !artifact.archived);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.type !== b.type) continue;
      if (isAppOverview(a) && isAppOverview(b)) continue;
      if (a.type === 'knowledge') {
        const scopeA = appScope(a);
        const scopeB = appScope(b);
        if (scopeA && scopeB && scopeA !== scopeB) continue;
      }
      const similarity = jaccard(tokenSet(a), tokenSet(b));
      if (similarity >= threshold) pairs.push({ a, b, similarity });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

function tokenSet(artifact) {
  const text = `${artifact.title} ${artifact.description} ${artifact.body.slice(0, 1200)}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  return new Set(
    text
      .split(/\s+/)
      .filter((token) => token.length > 3)
      .filter((token) => !STOP.has(token)),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const STOP = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'when',
  'then',
  'than',
  'into',
  'your',
  'they',
  'will',
  'what',
  'which',
  'there',
  'their',
  'about',
  'using',
  'used',
  'each',
  'also',
  'more',
  'most',
  'some',
  'only',
  'other',
  'these',
  'those',
  'should',
  'could',
  'would',
  'make',
  'made',
  'need',
  'needs',
  'must',
  'does',
  'done',
  'just',
  'like',
  'over',
  'under',
  'after',
  'before',
]);

export { SCRIPT_EXTS, oneLine };
