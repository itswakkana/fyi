/**
 * Install, uninstall, and inspect fyi hooks in host config files. Merges are
 * non-destructive: only handlers whose command runs `fyi.mjs ... hook run`
 * are touched.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  HOOK_TIMEOUT_SECONDS,
  HOSTS,
  OPENCODE_EVENTS,
  OPENCODE_MANAGED_MARKER,
  SUPPORTED_AGENTS,
  buildHookCommand,
  hookConfigPathFor,
  hookConfigPathsFor,
  hostEventName,
  parseAgentList,
  resolveCliForAgent,
  skillDirFor,
} from './hosts.mjs';
import { renderOpenCodePlugin } from './opencode-plugin.mjs';
import { parseMarkdown } from './frontmatter.mjs';
import { ensureDir, isInsideReal, isSymlink, readJson, safeWriteFile, toPosix } from './util.mjs';

const FYI_HOOK_COMMAND_RE = /fyi\.mjs(?:"|'|\s).*hook\s+run\b/;

export function isFyiHandler(handler) {
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
    if (isSymlink(cursor)) throw new Error(`refusing to write through symlink: ${cursor}`);
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
  const entries = {};
  for (const [event, spec] of Object.entries(HOSTS[agent].events)) {
    const handler = {
      type: 'command',
      command: buildHookCommand(cliInfo, event, agent),
      timeout: HOOK_TIMEOUT_SECONDS,
    };
    if (spec.statusMessage) handler.statusMessage = spec.statusMessage;
    entries[hostEventName(event)] = spec.matcher
      ? { matcher: spec.matcher, hooks: [handler] }
      : { hooks: [handler] };
  }
  return entries;
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

/** Remove every fyi handler from every event (including events fyi no longer installs). */
function stripAllFyiHooks(hooks) {
  const next = {};
  let removed = 0;
  for (const [eventName, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) {
      next[eventName] = groups;
      continue;
    }
    const result = stripFyiHooksFromArray(groups);
    removed += result.removed;
    if (result.groups.length) next[eventName] = result.groups;
  }
  return { hooks: next, removed };
}

function hooksObjectOf(config) {
  return config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks
    : {};
}

function removeFyiHooksFromFile(root, configPath, dryRun) {
  if (!existsSync(configPath)) return 0;
  assertSafeConfigTarget(root, configPath);
  const existing = readJsonStrict(configPath);
  const { hooks, removed } = stripAllFyiHooks(hooksObjectOf(existing));
  if (!removed) return 0;
  const next = { ...existing };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  if (!dryRun) safeWriteFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return removed;
}

function installJsonHooks(root, agent, { dryRun = false, cliPath = '' } = {}) {
  const cliInfo = resolveCliForAgent(root, agent, cliPath);
  const candidates = hookConfigPathsFor(root, agent);
  // Absolute (machine-specific) commands go to the host's local, untracked file when it has one.
  const configPath = !cliInfo.local && candidates.length > 1 ? candidates[1] : candidates[0];
  for (const path of candidates) assertSafeConfigTarget(root, path);

  const existed = existsSync(configPath);
  const existing = readJsonStrict(configPath);
  for (const other of candidates) {
    if (other !== configPath) removeFyiHooksFromFile(root, other, dryRun);
  }

  const { hooks } = stripAllFyiHooks(hooksObjectOf(existing));
  const desired = buildJsonHookEntries(agent, cliInfo);
  for (const [eventName, entry] of Object.entries(desired)) {
    hooks[eventName] = [...(Array.isArray(hooks[eventName]) ? hooks[eventName] : []), entry];
  }

  const next = { ...existing, hooks };
  if (!dryRun) {
    ensureDir(dirname(configPath));
    safeWriteFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    agent,
    path: configPath,
    action: existed ? 'updated' : 'created',
    events: Object.keys(desired),
    localCli: cliInfo.local,
  };
}

function uninstallJsonHooks(root, agent, { dryRun = false } = {}) {
  const paths = hookConfigPathsFor(root, agent);
  let removed = 0;
  let touched = null;
  for (const path of paths) {
    const count = removeFyiHooksFromFile(root, path, dryRun);
    if (count) {
      removed += count;
      touched = touched || path;
    }
  }
  const primary = touched || paths[0];
  if (!removed) {
    const anyExists = paths.some((path) => existsSync(path));
    return { agent, path: primary, action: anyExists ? 'unchanged' : 'absent', removed: 0 };
  }
  return { agent, path: primary, action: 'removed', removed };
}

function installOpenCodeHook(root, { dryRun = false, force = false, cliPath = '' } = {}) {
  const pluginPath = hookConfigPathFor(root, 'opencode');
  assertSafeConfigTarget(root, pluginPath);

  const existed = existsSync(pluginPath);
  if (existed) {
    const current = readFileSync(pluginPath, 'utf8');
    if (!current.startsWith(OPENCODE_MANAGED_MARKER) && !force) {
      throw new Error(`${pluginPath} already exists and is not managed by fyi; pass --force to replace it.`);
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
    events: [...OPENCODE_EVENTS],
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
    throw new Error(`${pluginPath} is not managed by fyi; pass --force to remove it.`);
  }
  if (!dryRun) rmSync(pluginPath, { force: true });
  return { agent: 'opencode', path: pluginPath, action: 'removed', removed: 1 };
}

export function installHooks(root, options = {}) {
  const agents = parseAgentList(options.agents, SUPPORTED_AGENTS);
  return agents.map((agent) =>
    agent === 'opencode' ? installOpenCodeHook(root, options) : installJsonHooks(root, agent, options),
  );
}

export function uninstallHooks(root, options = {}) {
  const agents = parseAgentList(options.agents, SUPPORTED_AGENTS);
  return agents.map((agent) =>
    agent === 'opencode' ? uninstallOpenCodeHook(root, options) : uninstallJsonHooks(root, agent, options),
  );
}

/**
 * Resolve the fyi.mjs path a configured hook command actually runs.
 * Returns null when it cannot be determined statically (e.g. plugin roots).
 */
export function cliPathFromCommand(root, command) {
  const match = /node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(String(command || ''));
  if (!match) return null;
  let path = match[1] ?? match[2] ?? match[3];
  if (/\$\{?CLAUDE_PLUGIN_ROOT/.test(path)) return null;
  path = path
    .replace(/\$\{CLAUDE_PROJECT_DIR(?::-[^}]*)?\}/g, root)
    .replace(/\$CLAUDE_PROJECT_DIR\b/g, root);
  if (/\$/.test(path)) return null;
  return isAbsolute(path) ? path : resolve(root, path);
}

function fyiHandlersIn(config) {
  const found = [];
  for (const [eventName, groups] of Object.entries(hooksObjectOf(config))) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const handler of group.hooks) {
        if (isFyiHandler(handler)) found.push({ eventName, command: handler.command });
      }
    }
  }
  return found;
}

/** True when the project config (not a plugin) already wires fyi hooks for this agent. */
export function projectHasFyiHooks(root, agent) {
  if (agent === 'opencode') {
    try {
      return readFileSync(hookConfigPathFor(root, 'opencode'), 'utf8').startsWith(OPENCODE_MANAGED_MARKER);
    } catch {
      return false;
    }
  }
  return hookConfigPathsFor(root, agent).some((path) => {
    const parsed = readJson(path, null);
    return Boolean(parsed && typeof parsed === 'object' && fyiHandlersIn(parsed).length);
  });
}

function skillVersion(skillDir) {
  try {
    const parsed = parseMarkdown(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'));
    return parsed.data?.version ? String(parsed.data.version) : null;
  } catch {
    return null;
  }
}

/** Inspect skill and hook installation status across Claude Code, Codex, and OpenCode. */
export function inspectIntegrations(root) {
  const agents = {};
  for (const agent of SUPPORTED_AGENTS) {
    const skillDir = skillDirFor(root, agent);
    const skillInstalled = existsSync(join(skillDir, 'SKILL.md'));
    const issues = [];
    const events = new Set();
    const files = [];
    let cliPath = null;

    if (agent === 'opencode') {
      const pluginPath = hookConfigPathFor(root, 'opencode');
      if (existsSync(pluginPath)) {
        try {
          const text = readFileSync(pluginPath, 'utf8');
          if (text.startsWith(OPENCODE_MANAGED_MARKER)) {
            files.push(pluginPath);
            for (const event of OPENCODE_EVENTS) events.add(event);
            const fallback = /const FALLBACK_MODULE = ("(?:[^"\\]|\\.)*");/.exec(text);
            const fallbackPath = fallback ? JSON.parse(fallback[1]) : '';
            const local = SUPPORTED_AGENTS.map((a) => join(skillDirFor(root, a), 'scripts', 'lib', 'hooks.mjs'));
            const engine = [...local, fallbackPath].find((path) => path && existsSync(path));
            if (!engine) issues.push('plugin cannot find the fyi hook engine (install a project-local skill)');
            cliPath = engine ? join(dirname(dirname(engine)), 'fyi.mjs') : null;
          }
        } catch (error) {
          issues.push(`unreadable plugin: ${error.message}`);
        }
      }
    } else {
      for (const configPath of hookConfigPathsFor(root, agent)) {
        if (!existsSync(configPath)) continue;
        const parsed = readJson(configPath, null);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          issues.push(`invalid JSON in ${toPosix(relative(root, configPath))}`);
          continue;
        }
        const handlers = fyiHandlersIn(parsed);
        if (!handlers.length) continue;
        files.push(configPath);
        for (const { eventName, command } of handlers) {
          events.add(eventName);
          const path = cliPathFromCommand(root, command);
          if (path) cliPath = cliPath || path;
          if (path && !existsSync(path)) {
            issues.push(`${eventName} hook runs a missing CLI: ${toPosix(path)}`);
          }
        }
        if (handlers.some(({ eventName }) => eventName === 'Stop')) {
          issues.push('legacy Stop hook from fyi 1.0.0; run `fyi hook install` to refresh');
        }
      }
      if (files.length > 1) {
        issues.push(`fyi hooks are configured in ${files.length} files; run \`fyi hook install\` to dedupe`);
      }
    }

    const fallbackCli = resolveCliForAgent(root, agent);
    agents[agent] = {
      skill: {
        installed: skillInstalled,
        path: toPosix(relative(root, skillDir)),
        version: skillInstalled ? skillVersion(skillDir) : null,
      },
      hooks: {
        installed: files.length > 0,
        path: toPosix(relative(root, files[0] || hookConfigPathFor(root, agent))),
        files: files.map((file) => toPosix(relative(root, file))),
        events: [...events],
      },
      cli: cliPath ? toPosix(cliPath) : fallbackCli.rel || toPosix(fallbackCli.abs),
      issues: [...new Set(issues)],
      issue: issues[0] || null,
    };
  }
  return agents;
}

/** Distinct versions among installed project-local skill copies. */
export function skillVersionDrift(integrations) {
  const versions = {};
  for (const [agent, info] of Object.entries(integrations)) {
    if (info.skill.installed && info.skill.version) versions[agent] = info.skill.version;
  }
  const distinct = [...new Set(Object.values(versions))];
  return distinct.length > 1 ? versions : null;
}
