import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SUPPORTED_AGENTS,
  SUPPORTED_EVENTS,
  SUPPORTED_HOSTS,
  evaluatePromptSubmit,
  evaluateSessionStart,
  evaluateStop,
  formatHookOutput,
  inspectIntegrations,
  installHooks,
  parseAgentList,
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
} from '../lib/util.mjs';

const HOOK_USAGE = `Usage:
  fyi hook install [--agents claude,codex,opencode|all] [--root <dir>] [--dry-run] [--force]
  fyi hook uninstall [--agents claude,codex,opencode|all] [--root <dir>] [--dry-run] [--force]
  fyi hook status [--root <dir>] [--json]
  fyi hook run <session-start|prompt-submit|stop> [--host claude|codex|opencode|plain] [--root <dir>]`;

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

function resolveHookRoot(ctx, payload) {
  if (ctx.flags.root && ctx.flags.root !== true) {
    return resolve(normalizeRoot(ctx.flags.root));
  }
  if (typeof payload?.cwd === 'string' && payload.cwd.trim()) {
    return resolve(findProjectRoot(payload.cwd));
  }
  if (process.env.CLAUDE_PROJECT_DIR) {
    return resolve(findProjectRoot(process.env.CLAUDE_PROJECT_DIR));
  }
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

  const payload = readStdinPayload();
  const root = resolveHookRoot(ctx, payload);

  let evaluation;
  if (event === 'session-start') {
    evaluation = evaluateSessionStart(root, { host });
  } else if (event === 'prompt-submit') {
    const prompt =
      args.slice(1).join(' ').trim() ||
      payload.prompt ||
      payload.user_prompt ||
      payload.message ||
      '';
    evaluation = evaluatePromptSubmit(root, prompt, { host });
  } else {
    evaluation = evaluateStop(root, payload);
  }

  const output = formatHookOutput(host, event, evaluation);
  if (output) process.stdout.write(`${output}\n`);
  return 0;
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
        'Note: no project-local skill was found in this repo, so hooks reference an absolute path on this machine. Run `fyi install <repo>` for team-portable relative hook paths.',
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
  if (json) {
    print(JSON.stringify({ root, agents }, null, 2));
    return 0;
  }

  print(color('1', `fyi hook status · ${root}`));
  print('');
  for (const [name, info] of Object.entries(agents)) {
    const skillMark = info.skill.installed ? color('32', 'skill:yes') : color('2', 'skill:no ');
    const hookMark = info.hooks.installed ? color('32', 'hooks:yes') : color('2', 'hooks:no ');
    const detail = info.hooks.installed
      ? `${info.hooks.path} (${info.hooks.events.join(', ')})`
      : info.hooks.path;
    print(`  ${name.padEnd(9)} ${skillMark}  ${hookMark}  ${detail}`);
    if (info.issue) print(`            ${color('33', `warning: ${info.issue}`)}`);
  }
  return 0;
}
