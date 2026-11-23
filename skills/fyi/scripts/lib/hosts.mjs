/**
 * Host adapter table: where each agent keeps skills and hook config, which
 * lifecycle events fyi wires, and how hook output is encoded per protocol.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SCRIPTS_DIR, toPosix, unique } from './util.mjs';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'opencode'];
export const SUPPORTED_HOSTS = ['claude', 'codex', 'opencode', 'plain'];
/** `stop` is kept so hook configs written by 1.0.0 keep working; it is no longer installed. */
export const SUPPORTED_EVENTS = ['session-start', 'prompt-submit', 'post-tool-use', 'stop'];

export const HOOK_TIMEOUT_SECONDS = 5;
export const OPENCODE_MANAGED_MARKER = '// Managed by fyi';
export const OPENCODE_EVENTS = [
  'chat.message',
  'experimental.chat.system.transform',
  'experimental.session.compacting',
  'tool.execute.after',
  'session.idle',
];

/** Host event name for each fyi event, per JSON-config host. */
const EVENT_NAMES = {
  'session-start': 'SessionStart',
  'prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
};

export const HOSTS = {
  claude: {
    skillPath: ['.claude', 'skills', 'fyi'],
    // Team-shared config first; the local file holds machine-specific absolute paths.
    configPaths: [
      ['.claude', 'settings.json'],
      ['.claude', 'settings.local.json'],
    ],
    events: {
      'session-start': { matcher: 'startup|clear|compact', statusMessage: 'Loading fyi project memory' },
      'prompt-submit': {},
      'post-tool-use': { matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
    },
  },
  codex: {
    skillPath: ['.agents', 'skills', 'fyi'],
    configPaths: [['.codex', 'hooks.json']],
    events: {
      'session-start': { matcher: '.*', statusMessage: 'Loading fyi project memory' },
      'prompt-submit': { matcher: '.*' },
      'post-tool-use': { matcher: 'apply_patch|Edit|Write' },
    },
  },
  opencode: {
    skillPath: ['.opencode', 'skills', 'fyi'],
    configPaths: [['.opencode', 'plugins', 'fyi.js']],
    events: null,
  },
};

export const SKILL_RELATIVE_PATHS = Object.fromEntries(
  SUPPORTED_AGENTS.map((agent) => [agent, HOSTS[agent].skillPath]),
);
export const HOOK_CONFIG_RELATIVE_PATHS = Object.fromEntries(
  SUPPORTED_AGENTS.map((agent) => [agent, HOSTS[agent].configPaths[0]]),
);

export function hostEventName(event) {
  return EVENT_NAMES[event] || '';
}

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
  return join(root, ...HOSTS[agent].skillPath);
}

export function hookConfigPathFor(root, agent, variant = 0) {
  const paths = HOSTS[agent].configPaths;
  return join(root, ...paths[Math.min(variant, paths.length - 1)]);
}

export function hookConfigPathsFor(root, agent) {
  return HOSTS[agent].configPaths.map((parts) => join(root, ...parts));
}

/** True when any agent's skill is installed inside this project. */
export function hasLocalSkill(root) {
  return SUPPORTED_AGENTS.some((agent) => existsSync(join(skillDirFor(root, agent), 'SKILL.md')));
}

function insideRoot(root, abs) {
  const rel = relative(root, abs);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Locate the best fyi.mjs CLI path for a project and agent (preferring project-local). */
export function resolveCliForAgent(root, agent = 'claude', overrideCli = '') {
  if (overrideCli) {
    const abs = resolve(overrideCli);
    const inside = insideRoot(root, abs);
    return { abs, rel: inside ? toPosix(relative(root, abs)) : null, local: inside };
  }
  const order = unique([SUPPORTED_AGENTS.includes(agent) ? agent : 'claude', ...SUPPORTED_AGENTS]);
  for (const candidateAgent of order) {
    const relParts = [...HOSTS[candidateAgent].skillPath, 'scripts', 'fyi.mjs'];
    const abs = join(root, ...relParts);
    if (existsSync(abs)) return { abs, rel: relParts.join('/'), local: true };
  }
  const fallbackAbs = join(SCRIPTS_DIR, 'fyi.mjs');
  const inside = insideRoot(root, fallbackAbs);
  return {
    abs: fallbackAbs,
    rel: inside ? toPosix(relative(root, fallbackAbs)) : null,
    local: inside,
  };
}

export function quoteIfNeeded(value) {
  return /[\s"'$`\\]/.test(value) ? JSON.stringify(value) : value;
}

/** Command prefix written into hook config files (relative when portable). */
export function formatCliInvocation(cliInfo, host = 'plain') {
  if (cliInfo.local && cliInfo.rel) {
    if (host === 'claude') return `node "\${CLAUDE_PROJECT_DIR:-.}/${cliInfo.rel}"`;
    return `node ${quoteIfNeeded(cliInfo.rel)}`;
  }
  return `node ${quoteIfNeeded(toPosix(cliInfo.abs))}`;
}

/** Command shown to the model at runtime: absolute, so it works from any working directory. */
export function formatRuntimeCli(root, cliInfo) {
  return `node ${quoteIfNeeded(toPosix(cliInfo.abs))} <command> --root ${quoteIfNeeded(toPosix(root))}`;
}

export function runtimeCommand(root, cliInfo, command) {
  return `node ${quoteIfNeeded(toPosix(cliInfo.abs))} ${command} --root ${quoteIfNeeded(toPosix(root))}`;
}

export function buildHookCommand(cliInfo, event, host) {
  return `${formatCliInvocation(cliInfo, host)} hook run ${event} --host ${host}`;
}

/** Format an evaluation result for the target host protocol. */
export function formatHookOutput(host, event, evaluation) {
  if (host === 'opencode') return JSON.stringify({ event, ...evaluation });
  if (host === 'plain') return evaluation.additionalContext || evaluation.systemMessage || '';

  if (event === 'stop') {
    const message = evaluation.systemMessage || '';
    return message ? JSON.stringify({ systemMessage: message }) : '';
  }

  const context = evaluation.additionalContext || '';
  if (!context) return '';
  if (event === 'session-start' && host === 'codex') {
    // Plain stdout on SessionStart is portable across Codex CLI versions,
    // including versions that reject hookSpecificOutput.additionalContext on SessionStart.
    return context;
  }
  const hookEventName = hostEventName(event);
  if (!hookEventName) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } });
}
