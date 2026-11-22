import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  configIssues,
  counts,
  indexStatus,
  isInitialized,
  readConfig,
  searchArtifacts,
  walkArtifacts,
} from './store.mjs';
import {
  SCRIPTS_DIR,
  ensureDir,
  isInsideReal,
  isSymlink,
  oneLine,
  readJson,
  safeWriteFile,
  toPosix,
  unique,
} from './util.mjs';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'opencode'];
export const SUPPORTED_HOSTS = ['claude', 'codex', 'opencode', 'plain'];
export const SUPPORTED_EVENTS = ['session-start', 'prompt-submit', 'stop'];

export const SKILL_RELATIVE_PATHS = {
  claude: ['.claude', 'skills', 'fyi'],
  codex: ['.agents', 'skills', 'fyi'],
  opencode: ['.opencode', 'skills', 'fyi'],
};

export const HOOK_CONFIG_RELATIVE_PATHS = {
  claude: ['.claude', 'settings.json'],
  codex: ['.codex', 'hooks.json'],
  opencode: ['.opencode', 'plugins', 'fyi.js'],
};

export const OPENCODE_MANAGED_MARKER = '// Managed by fyi';
const FYI_HOOK_COMMAND_RE = /fyi\.mjs(?:"|'|\s).*hook\s+run\b/;

const PROMPT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can', 'check',
  'could', 'did', 'do', 'does', 'done', 'for', 'from', 'get', 'got', 'had', 'has', 'have',
  'help', 'here', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'let', 'like',
  'look', 'make', 'may', 'me', 'more', 'my', 'need', 'not', 'now', 'of', 'on', 'or', 'our',
  'out', 'please', 'run', 'see', 'should', 'show', 'so', 'some', 'tell', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'try',
  'up', 'us', 'use', 'using', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

export function parseAgentList(input, fallback = SUPPORTED_AGENTS) {
  if (!input || (Array.isArray(input) && !input.length)) return [...fallback];
  const raw = Array.isArray(input) ? input : [input];
  const out = [];
  for (const item of raw) {
    for (const part of String(item).split(',')) {
      const token = part.trim().toLowerCase();
      if (!token) continue;
      if (token === 'all') {
        out.push(...SUPPORTED_AGENTS);
        continue;
      }
      if (!SUPPORTED_AGENTS.includes(token)) {
        throw new Error(
          `unknown agent "${part.trim()}"; expected one of: ${SUPPORTED_AGENTS.join(', ')}, all`,
        );
      }
      out.push(token);
    }
  }
  return out.length ? unique(out) : [...fallback];
}

export function skillDirFor(root, agent) {
  return join(root, ...SKILL_RELATIVE_PATHS[agent]);
}

export function hookConfigPathFor(root, agent) {
  return join(root, ...HOOK_CONFIG_RELATIVE_PATHS[agent]);
}

/** Locate the best fyi.mjs CLI path for a project and agent (preferring project-local). */
export function resolveCliForAgent(root, agent = 'claude', overrideCli = '') {
  if (overrideCli) {
    const abs = resolve(overrideCli);
    const rel = relative(root, abs);
    const inside = rel && !rel.startsWith('..') && !isAbsolute(rel);
    return { abs, rel: inside ? toPosix(rel) : null, local: Boolean(inside) };
  }
  const order = unique([agent, ...SUPPORTED_AGENTS]);
  for (const candidateAgent of order) {
    const relParts = [...SKILL_RELATIVE_PATHS[candidateAgent], 'scripts', 'fyi.mjs'];
    const abs = join(root, ...relParts);
    if (existsSync(abs)) {
      return { abs, rel: relParts.join('/'), local: true };
    }
  }
  const fallbackAbs = join(SCRIPTS_DIR, 'fyi.mjs');
  const rel = relative(root, fallbackAbs);
  const inside = rel && !rel.startsWith('..') && !isAbsolute(rel);
  return {
    abs: fallbackAbs,
    rel: inside ? toPosix(rel) : null,
    local: Boolean(inside),
  };
}

export function formatCliInvocation(cliInfo, host = 'plain') {
  if (cliInfo.local && cliInfo.rel) {
    if (host === 'claude') {
      return `node "\${CLAUDE_PROJECT_DIR:-.}/${cliInfo.rel}"`;
    }
    return `node ${quoteIfNeeded(cliInfo.rel)}`;
  }
  return `node ${quoteIfNeeded(toPosix(cliInfo.abs))}`;
}

function quoteIfNeeded(value) {
  return /[\s"'$`\\]/.test(value) ? JSON.stringify(value) : value;
}

export function buildHookCommand(cliInfo, event, host) {
  return `${formatCliInvocation(cliInfo, host)} hook run ${event} --host ${host}`;
}

/** Extract clean, high-signal search terms from a natural-language user prompt. */
export function extractPromptTerms(prompt) {
  const cleaned = String(prompt || '')
    .toLowerCase()
    .replace(/[`'"()[\]{}<>?!.,;:|\\]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[-_]+|[-_]+$/g, ''))
    .filter((token) => token.length >= 2 && !PROMPT_STOP_WORDS.has(token));
  return unique(cleaned).slice(0, 12);
}

/** Read-only SessionStart evaluation: concise store state + behavioral directives. */
export function evaluateSessionStart(root, options = {}) {
  const cliInfo = resolveCliForAgent(root, options.host || 'claude', options.cliPath);
  const cliDisplay = cliInfo.local && cliInfo.rel ? `node ${cliInfo.rel}` : `node ${toPosix(cliInfo.abs)}`;
  const initialized = isInitialized(root);

  if (!initialized) {
    const lines = [
      '<fyi-context>',
      'Project memory (.fyi/) is not initialized yet for this repository.',
      `CLI: \`${cliDisplay} <command>\``,
      'If this task needs durable project memory (debugging recipes, ownership, runbooks), run `init` on demand (skip for read-only tasks).',
      '</fyi-context>',
    ];
    return {
      initialized: false,
      additionalContext: lines.join('\n'),
      state: { initialized: false, apps: [], counts: { total: 0, unarchived: 0, archived: 0, byType: {} } },
    };
  }

  const config = readConfig(root);
  const artifacts = walkArtifacts(root);
  const summary = counts(artifacts);
  const status = indexStatus(root, artifacts);
  const apps = (config?.apps || []).map((app) => app.name);
  const issues = configIssues(config);
  const typeParts = Object.entries(summary.byType).map(([type, count]) => `${count} ${type}`);

  const lines = [
    '<fyi-context>',
    `Project memory (.fyi/) is active: ${summary.unarchived} artifact${summary.unarchived === 1 ? '' : 's'}${
      typeParts.length ? ` (${typeParts.join(', ')})` : ''
    } · apps: ${apps.length ? apps.join(', ') : 'none'} · index: ${status}.`,
    `CLI: \`${cliDisplay} <command>\``,
    'Rules:',
    '- Search before solving: for debugging, tracing, ownership, or "how does X work", run `find "<symptom>"` first.',
    '- Capture after solving: save reusable recipes when asked to remember/save/document; otherwise offer in one line (`new pattern "<title>"`).',
    '- Redact secrets and raw logs before writing. Never hand-edit generated INDEX.md or index.json.',
  ];

  if (!config) {
    lines.push('Notice: .fyi/config.json is missing or unreadable; run `init` or `doctor`.');
  } else if (issues.length) {
    lines.push(`Notice: config warning (${issues[0]}); run \`doctor\`.`);
  }
  if (status !== 'fresh') {
    lines.push('Notice: .fyi/ index is stale; run `index` before relying on INDEX.md.');
  }
  lines.push('</fyi-context>');

  return {
    initialized: true,
    additionalContext: lines.join('\n'),
    state: {
      initialized: true,
      apps,
      index: status,
      counts: summary,
    },
  };
}

/** Read-only UserPromptSubmit evaluation: surface high-confidence .fyi/ matches only. */
export function evaluatePromptSubmit(root, prompt, options = {}) {
  const minScore = options.minScore ?? 20;
  const limit = options.limit ?? 3;
  if (!isInitialized(root) || !String(prompt || '').trim()) {
    return { matched: false, terms: [], matches: [], additionalContext: '' };
  }

  const terms = extractPromptTerms(prompt);
  if (!terms.length) {
    return { matched: false, terms: [], matches: [], additionalContext: '' };
  }

  const artifacts = walkArtifacts(root);
  if (!artifacts.length) {
    return { matched: false, terms, matches: [], additionalContext: '' };
  }

  const results = searchArtifacts(artifacts, terms.join(' '), { includeArchived: false })
    .filter((entry) => entry.score >= minScore)
    .slice(0, limit);

  if (!results.length) {
    return { matched: false, terms, matches: [], additionalContext: '' };
  }

  const cliInfo = resolveCliForAgent(root, options.host || 'claude', options.cliPath);
  const cliDisplay = cliInfo.local && cliInfo.rel ? `node ${cliInfo.rel}` : `node ${toPosix(cliInfo.abs)}`;

  const lines = [
    '<fyi-matches>',
    'Relevant project memory in .fyi/ (check before re-deriving):',
    ...results.map(({ artifact }) => {
      const desc = artifact.description ? ` — ${oneLine(artifact.description, 100)}` : '';
      return `- [${artifact.type}] ${artifact.title} (\`${artifact.id}\`)${desc}`;
    }),
    `Read with: \`${cliDisplay} show <id>\``,
    '</fyi-matches>',
  ];

  return {
    matched: true,
    terms,
    matches: results.map(({ artifact, score }) => ({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      path: artifact.path,
      score,
    })),
    additionalContext: lines.join('\n'),
  };
}

/** Read-only Stop evaluation: never blocks, never loops, only surfaces stale-index notices. */
export function evaluateStop(root, payload = {}) {
  if (payload?.stop_hook_active) {
    return { skipped: true, systemMessage: '' };
  }
  if (!isInitialized(root)) {
    return { skipped: false, systemMessage: '' };
  }

  const config = readConfig(root);
  if (!config) {
    return {
      skipped: false,
      systemMessage: 'fyi: .fyi/config.json is missing or unreadable; run `fyi doctor`.',
    };
  }
  const issues = configIssues(config);
  if (issues.length) {
    return {
      skipped: false,
      systemMessage: `fyi: .fyi/config.json needs attention (${issues[0]}); run \`fyi doctor\`.`,
    };
  }

  const artifacts = walkArtifacts(root);
  const status = indexStatus(root, artifacts);
  if (status !== 'fresh') {
    return {
      skipped: false,
      systemMessage: 'fyi: .fyi/ index is stale; run `fyi index` to refresh INDEX.md and index.json.',
    };
  }
  return { skipped: false, systemMessage: '' };
}

/** Format an evaluation result for the target host protocol. */
export function formatHookOutput(host, event, evaluation) {
  if (host === 'opencode') {
    return JSON.stringify({ event, ...evaluation });
  }
  if (host === 'plain') {
    return evaluation.additionalContext || evaluation.systemMessage || '';
  }

  if (event === 'session-start') {
    const context = evaluation.additionalContext || '';
    if (!context) return '';
    if (host === 'codex') {
      // Plain stdout on SessionStart is portable across Codex CLI versions,
      // including versions that reject hookSpecificOutput.additionalContext on SessionStart.
      return context;
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    });
  }

  if (event === 'prompt-submit') {
    const context = evaluation.additionalContext || '';
    if (!context) return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    });
  }

  if (event === 'stop') {
    const message = evaluation.systemMessage || '';
    if (!message) return '';
    return JSON.stringify({ systemMessage: message });
  }

  return '';
}

function isFyiHandler(handler) {
  return Boolean(
    handler &&
      typeof handler === 'object' &&
      typeof handler.command === 'string' &&
      FYI_HOOK_COMMAND_RE.test(handler.command),
  );
}

function assertSafeConfigTarget(root, targetPath) {
  const rootAbs = resolve(root);
  let cursor = targetPath;
  while (true) {
    if (isSymlink(cursor)) {
      throw new Error(`refusing to write through symlink: ${cursor}`);
    }
    if (cursor === rootAbs) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!isInsideReal(rootAbs, targetPath)) {
    throw new Error(`refusing to write outside project root: ${targetPath}`);
  }
}

function readJsonStrict(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object in ${path}`);
  }
  return parsed;
}

function buildJsonHookEntries(agent, cliInfo) {
  const withMatcher = agent === 'codex';
  const wrap = (handler) => (withMatcher ? { matcher: '.*', hooks: [handler] } : { hooks: [handler] });
  return {
    SessionStart: wrap({
      type: 'command',
      command: buildHookCommand(cliInfo, 'session-start', agent),
      timeout: 10,
      statusMessage: 'Loading fyi project memory',
    }),
    UserPromptSubmit: wrap({
      type: 'command',
      command: buildHookCommand(cliInfo, 'prompt-submit', agent),
      timeout: 10,
    }),
    Stop: wrap({
      type: 'command',
      command: buildHookCommand(cliInfo, 'stop', agent),
      timeout: 10,
    }),
  };
}

function stripFyiHooksFromArray(groups) {
  if (!Array.isArray(groups)) return { groups: [], removed: 0 };
  let removed = 0;
  const kept = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const remaining = group.hooks.filter((handler) => {
      if (isFyiHandler(handler)) {
        removed++;
        return false;
      }
      return true;
    });
    if (remaining.length) kept.push({ ...group, hooks: remaining });
  }
  return { groups: kept, removed };
}

function installJsonHooks(root, agent, { dryRun = false, cliPath = '' } = {}) {
  const configPath = hookConfigPathFor(root, agent);
  assertSafeConfigTarget(root, configPath);

  const existing = readJsonStrict(configPath);
  const hooksObj =
    existing.hooks && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks)
      ? { ...existing.hooks }
      : {};

  const cliInfo = resolveCliForAgent(root, agent, cliPath);
  const desired = buildJsonHookEntries(agent, cliInfo);

  for (const [eventName, entry] of Object.entries(desired)) {
    const { groups } = stripFyiHooksFromArray(hooksObj[eventName]);
    hooksObj[eventName] = [...groups, entry];
  }

  const next = { ...existing, hooks: hooksObj };
  if (!dryRun) {
    ensureDir(dirname(configPath));
    safeWriteFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    agent,
    path: configPath,
    action: existsSync(configPath) ? 'updated' : 'created',
    events: Object.keys(desired),
    localCli: cliInfo.local,
  };
}

function uninstallJsonHooks(root, agent, { dryRun = false } = {}) {
  const configPath = hookConfigPathFor(root, agent);
  if (!existsSync(configPath)) {
    return { agent, path: configPath, action: 'absent', removed: 0 };
  }
  assertSafeConfigTarget(root, configPath);
  const existing = readJsonStrict(configPath);
  if (!existing.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks)) {
    return { agent, path: configPath, action: 'unchanged', removed: 0 };
  }

  const hooksObj = { ...existing.hooks };
  let totalRemoved = 0;
  for (const eventName of Object.keys(hooksObj)) {
    const { groups, removed } = stripFyiHooksFromArray(hooksObj[eventName]);
    totalRemoved += removed;
    if (groups.length) hooksObj[eventName] = groups;
    else delete hooksObj[eventName];
  }

  if (!totalRemoved) {
    return { agent, path: configPath, action: 'unchanged', removed: 0 };
  }

  const next = { ...existing };
  if (Object.keys(hooksObj).length) next.hooks = hooksObj;
  else delete next.hooks;

  if (!dryRun) {
    safeWriteFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { agent, path: configPath, action: 'removed', removed: totalRemoved };
}

export function renderOpenCodePlugin(fallbackHooksAbs = '') {
  const fallbackLiteral = fallbackHooksAbs ? JSON.stringify(toPosix(fallbackHooksAbs)) : '""';
  return `${OPENCODE_MANAGED_MARKER} — project memory hooks for OpenCode.
// Update with \`fyi hook install --agents opencode\`; remove with \`fyi hook uninstall --agents opencode\`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE_MODULES = [
  ['.opencode', 'skills', 'fyi', 'scripts', 'lib', 'hooks.mjs'],
  ['.claude', 'skills', 'fyi', 'scripts', 'lib', 'hooks.mjs'],
  ['.agents', 'skills', 'fyi', 'scripts', 'lib', 'hooks.mjs'],
];
const FALLBACK_MODULE = ${fallbackLiteral};

async function loadHooksEngine(root) {
  for (const parts of CANDIDATE_MODULES) {
    const candidate = join(root, ...parts);
    if (existsSync(candidate)) {
      return import(pathToFileURL(candidate).href);
    }
  }
  if (FALLBACK_MODULE && existsSync(FALLBACK_MODULE)) {
    return import(pathToFileURL(FALLBACK_MODULE).href);
  }
  return null;
}

function extractPromptText(input, output) {
  const parts = output?.parts || input?.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (typeof input?.prompt === 'string') return input.prompt;
  if (typeof input?.text === 'string') return input.text;
  if (typeof output?.message?.content === 'string') return output.message.content;
  return '';
}

export default async function fyiPlugin(ctx = {}) {
  const root = ctx.directory || ctx.worktree || process.cwd();
  let engine = null;
  try {
    engine = await loadHooksEngine(root);
  } catch {
    return {};
  }
  if (!engine) return {};

  const lastPrompts = new Map();
  const rememberPrompt = (sessionId, text) => {
    const key = sessionId || '__default__';
    if (lastPrompts.size > 32) {
      const oldest = lastPrompts.keys().next().value;
      lastPrompts.delete(oldest);
    }
    lastPrompts.set(key, text);
  };

  return {
    'chat.message': async (input, output) => {
      try {
        const text = extractPromptText(input, output);
        if (text) rememberPrompt(input?.sessionID || input?.sessionId, text);
      } catch {
        // Never disrupt chat flow.
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (!Array.isArray(output?.system)) return;
        const session = engine.evaluateSessionStart(root, { host: 'opencode' });
        if (session?.additionalContext) {
          // Mutate output.system in-place (reassignment is ignored by OpenCode).
          output.system.push(session.additionalContext);
        }
        const key = input?.sessionID || input?.sessionId || '__default__';
        const prompt = lastPrompts.get(key) || '';
        if (prompt) {
          const matched = engine.evaluatePromptSubmit(root, prompt, { host: 'opencode' });
          if (matched?.additionalContext) {
            output.system.push(matched.additionalContext);
          }
        }
      } catch {
        // Fail open if store cannot be read.
      }
    },

    'experimental.session.compacting': async (input, output) => {
      try {
        const session = engine.evaluateSessionStart(root, { host: 'opencode' });
        if (!session?.additionalContext) return;
        if (Array.isArray(output?.context)) {
          output.context.push(session.additionalContext);
        }
      } catch {
        // Fail open.
      }
    },

    event: async (payload) => {
      try {
        const ev = payload?.event || payload;
        if (ev?.type === 'session.deleted') {
          const id = ev?.properties?.info?.id || ev?.sessionID;
          if (id) lastPrompts.delete(id);
          return;
        }
        if (ev?.type === 'session.idle') {
          const result = engine.evaluateStop(root, {});
          if (result?.systemMessage && ctx?.client?.tui?.showToast) {
            await ctx.client.tui.showToast({
              body: { message: result.systemMessage, variant: 'warning' },
            });
          }
        }
      } catch {
        // Fail open.
      }
    },
  };
}
`;
}

function installOpenCodeHook(root, { dryRun = false, force = false, cliPath = '' } = {}) {
  const pluginPath = hookConfigPathFor(root, 'opencode');
  assertSafeConfigTarget(root, pluginPath);

  const existed = existsSync(pluginPath);
  if (existed) {
    const current = readFileSync(pluginPath, 'utf8');
    if (!current.startsWith(OPENCODE_MANAGED_MARKER) && !force) {
      throw new Error(
        `${pluginPath} already exists and is not managed by fyi; pass --force to replace it.`,
      );
    }
  }

  const cliInfo = resolveCliForAgent(root, 'opencode', cliPath);
  const fallbackHooksAbs = cliInfo.local ? '' : join(dirname(cliInfo.abs), 'lib', 'hooks.mjs');
  const source = renderOpenCodePlugin(fallbackHooksAbs);

  if (!dryRun) {
    ensureDir(dirname(pluginPath));
    safeWriteFile(pluginPath, source);
  }

  return {
    agent: 'opencode',
    path: pluginPath,
    action: existed ? 'updated' : 'created',
    events: [
      'chat.message',
      'experimental.chat.system.transform',
      'experimental.session.compacting',
      'event(session.idle)',
    ],
    localCli: cliInfo.local,
  };
}

function uninstallOpenCodeHook(root, { dryRun = false, force = false } = {}) {
  const pluginPath = hookConfigPathFor(root, 'opencode');
  if (!existsSync(pluginPath)) {
    return { agent: 'opencode', path: pluginPath, action: 'absent', removed: 0 };
  }
  assertSafeConfigTarget(root, pluginPath);
  const current = readFileSync(pluginPath, 'utf8');
  if (!current.startsWith(OPENCODE_MANAGED_MARKER) && !force) {
    throw new Error(
      `${pluginPath} is not managed by fyi; pass --force to remove it.`,
    );
  }
  if (!dryRun) {
    rmSync(pluginPath, { force: true });
  }
  return { agent: 'opencode', path: pluginPath, action: 'removed', removed: 1 };
}

export function installHooks(root, options = {}) {
  const agents = parseAgentList(options.agents, SUPPORTED_AGENTS);
  const results = [];
  for (const agent of agents) {
    if (agent === 'opencode') {
      results.push(installOpenCodeHook(root, options));
    } else {
      results.push(installJsonHooks(root, agent, options));
    }
  }
  return results;
}

export function uninstallHooks(root, options = {}) {
  const agents = parseAgentList(options.agents, SUPPORTED_AGENTS);
  const results = [];
  for (const agent of agents) {
    if (agent === 'opencode') {
      results.push(uninstallOpenCodeHook(root, options));
    } else {
      results.push(uninstallJsonHooks(root, agent, options));
    }
  }
  return results;
}

/** Inspect skill and hook installation status across Claude Code, Codex, and OpenCode. */
export function inspectIntegrations(root) {
  const agents = {};
  for (const agent of SUPPORTED_AGENTS) {
    const skillDir = skillDirFor(root, agent);
    const skillInstalled = existsSync(join(skillDir, 'SKILL.md'));
    const configPath = hookConfigPathFor(root, agent);
    const configExists = existsSync(configPath);
    let hooksInstalled = false;
    let events = [];
    let issue = null;

    if (agent === 'opencode') {
      if (configExists) {
        try {
          const text = readFileSync(configPath, 'utf8');
          hooksInstalled = text.startsWith(OPENCODE_MANAGED_MARKER);
          if (hooksInstalled) {
            events = [
              'chat.message',
              'experimental.chat.system.transform',
              'experimental.session.compacting',
              'session.idle',
            ];
          }
        } catch (error) {
          issue = `unreadable plugin: ${error.message}`;
        }
      }
    } else if (configExists) {
      const parsed = readJson(configPath, null);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        issue = `invalid JSON in ${toPosix(relative(root, configPath))}`;
      } else if (parsed.hooks && typeof parsed.hooks === 'object') {
        for (const [eventName, groups] of Object.entries(parsed.hooks)) {
          if (!Array.isArray(groups)) continue;
          const hasFyi = groups.some(
            (group) => Array.isArray(group?.hooks) && group.hooks.some((h) => isFyiHandler(h)),
          );
          if (hasFyi) events.push(eventName);
        }
        hooksInstalled = events.length > 0;
      }
    }

    const cli = resolveCliForAgent(root, agent);
    if (hooksInstalled && !existsSync(cli.abs)) {
      issue = `configured CLI missing at ${toPosix(cli.abs)}`;
    }

    agents[agent] = {
      skill: { installed: skillInstalled, path: toPosix(relative(root, skillDir)) },
      hooks: {
        installed: hooksInstalled,
        path: toPosix(relative(root, configPath)),
        events,
      },
      cli: cli.rel || toPosix(cli.abs),
      issue,
    };
  }
  return agents;
}
