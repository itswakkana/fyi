import { cpSync, existsSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { installHooks, parseAgentList, skillDirFor } from '../lib/hooks.mjs';
import {
  SKILL_DIR,
  color,
  ensureDir,
  fail,
  flagList,
  isInsideReal,
  isSymlink,
  print,
  toPosix,
} from '../lib/util.mjs';

export function run(ctx) {
  const { flags, positionals, json } = ctx;
  const targetArg = positionals[0] || (flags.target && flags.target !== true ? flags.target : '');
  if (!targetArg) {
    return fail('expected a target repo: fyi install <path> [--agents claude,codex,opencode|all] [--hooks] [--init]');
  }
  if (flags.agent === true || flags.agents === true) {
    return fail('--agents requires a value (claude, codex, opencode, or all)');
  }

  const target = resolve(String(targetArg));
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return fail(`target is not a directory: ${target}`);
  }

  // Installing inside the source tree would make the copy recurse into itself.
  if (isInsideReal(SKILL_DIR, target)) {
    return fail(`refusing to install into the skill source tree: ${target}`);
  }

  const requestedAgents = flagList(flags, 'agent', 'agents');
  const agents = parseAgentList(requestedAgents, ['claude']);
  const sourceReal = safeRealpath(SKILL_DIR);

  // Pre-validate all destinations before writing anything.
  const destinations = agents.map((agent) => ({ agent, path: skillDirFor(target, agent) }));
  for (const { path: destination } of destinations) {
    const destinationReal = safeRealpath(destination);
    if (destinationReal === sourceReal) {
      return fail('refusing to install the skill into itself');
    }
    if (isSymlink(destination) || isSymlink(dirname(destination))) {
      return fail(`refusing to install through symlink: ${destination}`);
    }
    if (existsSync(destination) && !flags.force) {
      return fail(`skill already exists at ${destination}; pass --force to replace it.`);
    }
  }

  const installedSkills = [];
  for (const { agent, path: destination } of destinations) {
    ensureDir(dirname(destination));
    const temp = `${destination}.tmp-${process.pid}`;
    const backup = `${destination}.bak-${process.pid}`;

    try {
      rmSync(temp, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
      cpSync(SKILL_DIR, temp, {
        recursive: true,
        filter: (src) => !/(?:^|[\\/])(?:selftest\.mjs|[^\\/]+(?:\.test|-test)\.mjs)$/.test(src),
      });
      if (existsSync(destination)) renameSync(destination, backup);
      renameSync(temp, destination);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      if (existsSync(backup) && !existsSync(destination)) {
        try {
          renameSync(backup, destination);
        } catch {
          // Leave the backup in place rather than losing the previous install.
        }
      }
      return fail(`could not install skill for ${agent}: ${error.message}`);
    }

    installedSkills.push({ agent, path: destination });
    if (!json) print(`${color('32', 'installed')} ${agent.padEnd(8)} ${toPosix(destination)}`);
  }

  let installedHooks = [];
  if (flags.hooks) {
    installedHooks = installHooks(target, { agents, force: Boolean(flags.force) });
    if (!json) {
      for (const item of installedHooks) {
        print(`${color('32', 'hooks    ')} ${item.agent.padEnd(8)} ${toPosix(item.path)}`);
      }
    }
  }

  const primaryCli = join(installedSkills[0].path, 'scripts', 'fyi.mjs');
  let initialized = false;
  if (flags.init) {
    const result = spawnSync(process.execPath, [primaryCli, 'init', '--root', target], {
      stdio: json ? 'pipe' : 'inherit',
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      if (json && result.stderr) process.stderr.write(result.stderr);
      return result.status || 1;
    }
    initialized = true;
  }

  if (json) {
    print(
      JSON.stringify(
        {
          target,
          agents,
          skills: installedSkills.map((item) => ({ agent: item.agent, path: toPosix(item.path) })),
          hooks: installedHooks.map((item) => ({
            agent: item.agent,
            path: toPosix(item.path),
            action: item.action,
            events: item.events,
          })),
          initialized,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!flags.init) {
    print('');
    print('Next:');
    print(`  node ${toPosix(primaryCli)} init --root ${toPosix(target)}`);
    if (!flags.hooks) {
      print(`  node ${toPosix(primaryCli)} hook install --agents ${agents.join(',')} --root ${toPosix(target)}`);
    }
  }
  return 0;
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
