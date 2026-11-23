import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  SUPPORTED_AGENTS,
  SUPPORTED_EVENTS,
  SUPPORTED_HOSTS,
  evaluatePostToolUse,
  evaluatePromptSubmit,
  evaluateSessionStart,
  evaluateStop,
  formatHookOutput,
  inspectIntegrations,
  installHooks,
  parseAgentList,
  projectHasFyiHooks,
  skillVersionDrift,
  uninstallHooks,
} from '../lib/hooks.mjs';
import {
  color,
  fail,
  findProjectRoot,
  flagList,
  normalizeRoot,
  print,
  toPosix,
  warn,
} from '../lib/util.mjs';

const HOOK_USAGE = `Usage:
  fyi hook install [--agents claude,codex,opencode|all] [--root <dir>] [--dry-run] [--force]
  fyi hook uninstall [--agents claude,codex,opencode|all] [--root <dir>] [--dry-run] [--force]
  fyi hook status [--root <dir>] [--json]
  fyi hook run <session-start|prompt-submit|post-tool-use|stop> [--host claude|codex|opencode|plain] [--source plugin] [--root <dir>]`;

export function run(ctx) {
  const { positionals } = ctx;
  const action = (positionals[0] || '').toLowerCase();

  if (!action || action === 'help') {
    print(HOOK_USAGE);
    return 0;
  }

  if (action === 'run') return runHookEvent(ctx, positionals.slice(1));
  if (action === 'install') return runHookInstall(ctx);
  if (action === 'uninstall' || action === 'remove') return runHookUninstall(ctx);
  if (action === 'status') return runHookStatus(ctx);

  return fail(`unknown hook action "${action}"\n${HOOK_USAGE}`);
}

function readStdinPayload() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isSameOrInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveHookRoot(ctx, payload, host) {
  if (ctx.flags.root && ctx.flags.root !== true) {
    return resolve(normalizeRoot(ctx.flags.root));
  }
  const envDir = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : '';
  const cwdDir = typeof payload?.cwd === 'string' && payload.cwd.trim() ? resolve(payload.cwd.trim()) : '';

  // In Claude Code, prefer CLAUDE_PROJECT_DIR over a nested cwd (e.g. a submodule),
  // while still honoring an unrelated payload.cwd (such as test fixtures).
  if (host === 'claude' && envDir && (!cwdDir || isSameOrInside(envDir, cwdDir))) {
    return resolve(findProjectRoot(envDir));
  }
  if (cwdDir) return resolve(findProjectRoot(cwdDir));
  if (envDir) return resolve(findProjectRoot(envDir));
  return ctx.root;
}

function runHookEvent(ctx, args) {
  const event = (args[0] || '').toLowerCase();
  if (!SUPPORTED_EVENTS.includes(event)) {
    return fail(
      `unknown hook event "${event || '(missing)'}"; expected one of: ${SUPPORTED_EVENTS.join(', ')}`,
    );
  }

  const hostRaw = ctx.flags.host;
  if (hostRaw === true) return fail('--host requires a value');
  const host = String(hostRaw || 'plain').toLowerCase();
  if (!SUPPORTED_HOSTS.includes(host)) {
    return fail(`unknown host "${host}"; expected one of: ${SUPPORTED_HOSTS.join(', ')}`);
  }

  const sourceRaw = ctx.flags.source;
  if (sourceRaw === true) return fail('--source requires a value');
  const source = String(sourceRaw || '').toLowerCase();

  // Hooks must always fail open so transient filesystem errors never disrupt a session.
  try {
    const payload = readStdinPayload();
    const root = resolveHookRoot(ctx, payload, host);

    // Yield to project-level hooks when the same agent has both plugin and project hooks wired.
    if (source === 'plugin' && host !== 'plain' && projectHasFyiHooks(root, host)) {
      return 0;
    }

    let evaluation;
    if (event === 'session-start') {
      evaluation = evaluateSessionStart(root, { host, source: payload.source });
    } else if (event === 'prompt-submit') {
      const prompt =
        args.slice(1).join(' ').trim() ||
        payload.prompt ||
        payload.user_prompt ||
        payload.message ||
        '';
      evaluation = evaluatePromptSubmit(root, prompt, {
        host,
        transcriptPath: payload.transcript_path,
      });
    } else if (event === 'post-tool-use') {
      evaluation = evaluatePostToolUse(root, payload, { host });
    } else {
      evaluation = evaluateStop(root, payload);
    }

    const output = formatHookOutput(host, event, evaluation);
    if (output) process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    if (process.env.FYI_HOOK_DEBUG === '1') {
      warn(`fyi hook debug (${event}/${host}): ${error?.stack || error}`);
    }
    return 0;
  }
}

function runHookInstall(ctx) {
  const { root, flags, json } = ctx;
  if (flags.agent === true || flags.agents === true) {
    return fail('--agents requires a value (claude, codex, opencode, or all)');
  }
  const agentList = flagList(flags, 'agent', 'agents');
  const agents = parseAgentList(agentList, SUPPORTED_AGENTS);
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);

  const results = installHooks(root, { agents, dryRun, force });
  if (json) {
    print(JSON.stringify({ root, dryRun, results }, null, 2));
    return 0;
  }

  print(color('1', `fyi hook install${dryRun ? ' (dry run)' : ''} · ${root}`));
  for (const item of results) {
    const badge = dryRun ? color('33', 'plan   ') : color('32', item.action.padEnd(7));
    print(`  ${badge} ${item.agent.padEnd(9)} ${toPosix(item.path)}`);
  }
  if (results.some((item) => item.localCli === false)) {
    print('');
    print(
      color(
        '33',
        'Note: no project-local skill was found, so hooks reference an absolute path on this machine (Claude wrote .claude/settings.local.json to keep it out of git). Run `fyi install <repo>` for team-portable relative hook paths.',
      ),
    );
  }
  if (results.some((item) => item.agent === 'codex')) {
    print('');
    print(
      color(
        '2',
        'Codex CLI: approve or trust project hooks via `/hooks` after installing or updating .codex/hooks.json.',
      ),
    );
  }
  if (dryRun) print('\nNo files written.');
  return 0;
}

function runHookUninstall(ctx) {
  const { root, flags, json } = ctx;
  if (flags.agent === true || flags.agents === true) {
    return fail('--agents requires a value (claude, codex, opencode, or all)');
  }
  const agentList = flagList(flags, 'agent', 'agents');
  const agents = parseAgentList(agentList, SUPPORTED_AGENTS);
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);

  const results = uninstallHooks(root, { agents, dryRun, force });
  if (json) {
    print(JSON.stringify({ root, dryRun, results }, null, 2));
    return 0;
  }

  print(color('1', `fyi hook uninstall${dryRun ? ' (dry run)' : ''} · ${root}`));
  for (const item of results) {
    const badge =
      item.action === 'removed'
        ? dryRun
          ? color('33', 'plan     ')
          : color('32', 'removed  ')
        : color('2', item.action.padEnd(9));
    print(`  ${badge} ${item.agent.padEnd(9)} ${toPosix(item.path)}`);
  }
  if (dryRun) print('\nNo files modified.');
  return 0;
}

function runHookStatus(ctx) {
  const { root, json } = ctx;
  const agents = inspectIntegrations(root);
  const drift = skillVersionDrift(agents);
  if (json) {
    print(JSON.stringify({ root, agents, versionDrift: drift }, null, 2));
    return 0;
  }

  print(color('1', `fyi hook status · ${root}`));
  print('');
  for (const [name, info] of Object.entries(agents)) {
    const skillMark = info.skill.installed ? color('32', 'skill:yes') : color('2', 'skill:no ');
    const hookMark = info.hooks.installed ? color('32', 'hooks:yes') : color('2', 'hooks:no ');
    const files = info.hooks.files?.length ? info.hooks.files.join(', ') : info.hooks.path;
    const detail = info.hooks.installed ? `${files} (${info.hooks.events.join(', ')})` : info.hooks.path;
    print(`  ${name.padEnd(9)} ${skillMark}  ${hookMark}  ${detail}`);
    for (const issue of info.issues || (info.issue ? [info.issue] : [])) {
      print(`            ${color('33', `warning: ${issue}`)}`);
    }
  }
  if (drift) {
    const summary = Object.entries(drift)
      .map(([agent, ver]) => `${agent}=${ver}`)
      .join(', ');
    print('');
    print(color('33', `warning: local skill copies have mismatched versions (${summary}); re-run \`fyi install --force\`.`));
  }
  if (agents.codex?.hooks.installed) {
    print('');
    print(color('2', 'note: Codex trust approval is stored outside the repo and is not inspected here.'));
  }
  return 0;
}
