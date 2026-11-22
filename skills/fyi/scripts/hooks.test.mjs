import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SCRIPTS_DIR } from './lib/util.mjs';

const CLI = join(SCRIPTS_DIR, 'fyi.mjs');

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyi-hooks-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
  });
}

function seedSampleStore(root) {
  const init = runCli(['init', '--root', root]);
  assert.equal(init.status, 0, init.stderr);
  const created = runCli([
    'new',
    'pattern',
    'Trace a request across services',
    '--app',
    'api',
    '--tag',
    'logs,tracing',
    '--description',
    'Follow one request id through gateway, api, and worker logs.',
    '--root',
    root,
  ]);
  assert.equal(created.status, 0, created.stderr);
}

test('install --agents all --hooks --init sets up Claude, Codex, and OpenCode together', (t) => {
  const repo = fixture(t);
  const res = runCli(['install', repo, '--agents', 'all', '--hooks', '--init', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);

  assert.deepEqual(out.agents, ['claude', 'codex', 'opencode']);
  assert.equal(out.initialized, true);
  assert.equal(existsSync(join(repo, '.claude', 'skills', 'fyi', 'SKILL.md')), true);
  assert.equal(existsSync(join(repo, '.agents', 'skills', 'fyi', 'SKILL.md')), true);
  assert.equal(existsSync(join(repo, '.opencode', 'skills', 'fyi', 'SKILL.md')), true);
  assert.equal(existsSync(join(repo, '.claude', 'skills', 'fyi', 'scripts', 'selftest.mjs')), false);
  assert.equal(existsSync(join(repo, '.claude', 'skills', 'fyi', 'scripts', 'hooks.test.mjs')), false);
  assert.equal(existsSync(join(repo, '.claude', 'settings.json')), true);
  assert.equal(existsSync(join(repo, '.codex', 'hooks.json')), true);
  assert.equal(existsSync(join(repo, '.opencode', 'plugins', 'fyi.js')), true);
  assert.equal(existsSync(join(repo, '.fyi', 'config.json')), true);

  const claudeSettings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.ok(claudeSettings.hooks.SessionStart[0].hooks[0].command.includes('--host claude'));
  assert.ok(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command.includes('--host claude'));
  assert.ok(claudeSettings.hooks.Stop[0].hooks[0].command.includes('--host claude'));

  const codexHooks = JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codexHooks.hooks.SessionStart[0].matcher, '.*');
  assert.ok(codexHooks.hooks.SessionStart[0].hooks[0].command.includes('.agents/skills/fyi/scripts/fyi.mjs'));
  assert.ok(codexHooks.hooks.UserPromptSubmit[0].hooks[0].command.includes('--host codex'));
  assert.ok(codexHooks.hooks.Stop[0].hooks[0].command.includes('--host codex'));

  const status = runCli(['hook', 'status', '--root', repo, '--json']);
  assert.equal(status.status, 0, status.stderr);
  const statusJson = JSON.parse(status.stdout);
  for (const agent of ['claude', 'codex', 'opencode']) {
    assert.equal(statusJson.agents[agent].skill.installed, true);
    assert.equal(statusJson.agents[agent].hooks.installed, true);
    assert.equal(statusJson.agents[agent].issue, null);
  }

  const context = runCli(['context', '--root', repo, '--json']);
  assert.equal(context.status, 0, context.stderr);
  assert.equal(JSON.parse(context.stdout).integrations.codex.hooks.installed, true);

  const doctor = runCli(['doctor', '--root', repo, '--json']);
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorJson = JSON.parse(doctor.stdout);
  const hooksCheck = doctorJson.checks.find((c) => c.name === 'hooks');
  assert.equal(hooksCheck.ok, true);
  assert.match(hooksCheck.detail, /claude, codex, opencode/);
});

test('hook run emits valid host-specific payloads for Claude, Codex, and OpenCode', (t) => {
  const repo = fixture(t);
  seedSampleStore(repo);

  // 1. SessionStart
  const claudeStart = runCli(['hook', 'run', 'session-start', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, hook_event_name: 'SessionStart' }),
  });
  assert.equal(claudeStart.status, 0, claudeStart.stderr);
  const claudeStartJson = JSON.parse(claudeStart.stdout);
  assert.equal(claudeStartJson.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(claudeStartJson.hookSpecificOutput.additionalContext, /<fyi-context>/);
  assert.match(claudeStartJson.hookSpecificOutput.additionalContext, /1 artifact/);

  const codexStart = runCli(['hook', 'run', 'session-start', '--host', 'codex'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo }),
  });
  assert.equal(codexStart.status, 0, codexStart.stderr);
  assert.match(codexStart.stdout, /^<fyi-context>/);

  // 2. UserPromptSubmit — relevant prompt matches, unrelated prompt is silent
  const matchingPrompt = JSON.stringify({
    cwd: repo,
    prompt: 'How do we trace a request id in api logs?',
  });
  for (const host of ['claude', 'codex']) {
    const res = runCli(['hook', 'run', 'prompt-submit', '--host', host], {
      cwd: repo,
      input: matchingPrompt,
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /<fyi-matches>/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Trace a request across services/);
  }

  const unrelatedPrompt = JSON.stringify({
    cwd: repo,
    prompt: 'Rename the primary button border radius to 8px',
  });
  const silent = runCli(['hook', 'run', 'prompt-submit', '--host', 'claude'], {
    cwd: repo,
    input: unrelatedPrompt,
  });
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout.trim(), '');

  // 3. Stop — silent when healthy, non-blocking notice when stale, skipped when stop_hook_active
  const healthyStop = runCli(['hook', 'run', 'stop', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, stop_hook_active: false }),
  });
  assert.equal(healthyStop.status, 0);
  assert.equal(healthyStop.stdout.trim(), '');

  // Make index stale by adding an artifact directly
  writeFileSync(
    join(repo, '.fyi', 'docs', 'extra.md'),
    '---\ntype: doc\ntitle: Extra\nstatus: active\nupdated: 2026-11-10\n---\nBody\n',
  );
  const staleStop = runCli(['hook', 'run', 'stop', '--host', 'codex'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, stop_hook_active: false }),
  });
  assert.equal(staleStop.status, 0);
  const staleJson = JSON.parse(staleStop.stdout);
  assert.match(staleJson.systemMessage, /index is stale/i);

  const guardedStop = runCli(['hook', 'run', 'stop', '--host', 'codex'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, stop_hook_active: true }),
  });
  assert.equal(guardedStop.status, 0);
  assert.equal(guardedStop.stdout.trim(), '');
});

test('hook install and uninstall preserve unrelated settings, are idempotent, and stay safe', (t) => {
  const repo = fixture(t);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  mkdirSync(join(repo, '.codex'), { recursive: true });

  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify(
      {
        permissions: { allow: ['Read'] },
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repo, '.codex', 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }],
        },
      },
      null,
      2,
    ),
  );

  // Install twice to verify idempotency
  assert.equal(runCli(['hook', 'install', '--agents', 'all', '--root', repo]).status, 0);
  assert.equal(runCli(['hook', 'install', '--agents', 'all', '--root', repo]).status, 0);

  const claude = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claude.permissions, { allow: ['Read'] });
  assert.equal(claude.hooks.SessionStart.length, 2);
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, 'echo user-hook');

  const codex = JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, 'echo guard');
  assert.equal(codex.hooks.SessionStart.length, 1);

  // Uninstall removes only fyi hooks
  assert.equal(runCli(['hook', 'uninstall', '--agents', 'all', '--root', repo]).status, 0);
  const claudeAfter = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claudeAfter.permissions, { allow: ['Read'] });
  assert.equal(claudeAfter.hooks.SessionStart.length, 1);
  assert.equal(claudeAfter.hooks.SessionStart[0].hooks[0].command, 'echo user-hook');
  assert.equal(claudeAfter.hooks.UserPromptSubmit, undefined);

  const codexAfter = JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codexAfter.hooks.PreToolUse.length, 1);
  assert.equal(codexAfter.hooks.SessionStart, undefined);
  assert.equal(existsSync(join(repo, '.opencode', 'plugins', 'fyi.js')), false);
});

test('hook install refuses invalid JSON, unmanaged OpenCode plugins, and symlinks', (t) => {
  const repo = fixture(t);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), '{not-json');
  const badJson = runCli(['hook', 'install', '--agents', 'claude', '--root', repo]);
  assert.notEqual(badJson.status, 0);
  assert.equal(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'), '{not-json');

  mkdirSync(join(repo, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(join(repo, '.opencode', 'plugins', 'fyi.js'), '// custom user plugin\n');
  const unmanaged = runCli(['hook', 'install', '--agents', 'opencode', '--root', repo]);
  assert.notEqual(unmanaged.status, 0);
  assert.equal(
    readFileSync(join(repo, '.opencode', 'plugins', 'fyi.js'), 'utf8'),
    '// custom user plugin\n',
  );

  const outside = join(repo, 'outside.json');
  mkdirSync(join(repo, '.codex'), { recursive: true });
  symlinkSync(outside, join(repo, '.codex', 'hooks.json'));
  const sym = runCli(['hook', 'install', '--agents', 'codex', '--root', repo]);
  assert.notEqual(sym.status, 0);
  assert.equal(existsSync(outside), false);
});

test('generated OpenCode plugin loads as ESM and mutates system/compacting outputs in-place', async (t) => {
  const repo = fixture(t);
  const installed = runCli(['install', repo, '--agents', 'opencode', '--hooks', '--init']);
  assert.equal(installed.status, 0, installed.stderr);
  seedSampleStore(repo);

  const pluginPath = join(repo, '.opencode', 'plugins', 'fyi.js');
  const mod = await import(`${pathToFileURL(pluginPath).href}?t=${Date.now()}`);
  const toasts = [];
  const hooks = await mod.default({
    directory: repo,
    client: {
      tui: {
        showToast: async (payload) => toasts.push(payload),
      },
    },
  });

  // Record user message, then run system transform and verify in-place mutation
  await hooks['chat.message'](
    { sessionID: 'sess-1' },
    { parts: [{ type: 'text', text: 'How do we trace a request id across api logs?' }] },
  );
  const systemArr = ['base system prompt'];
  const output = { system: systemArr };
  await hooks['experimental.chat.system.transform']({ sessionID: 'sess-1' }, output);
  assert.equal(output.system, systemArr, 'must mutate output.system in-place');
  assert.equal(systemArr.length, 3);
  assert.match(systemArr[1], /<fyi-context>/);
  assert.match(systemArr[2], /<fyi-matches>/);

  // Compaction preserves fyi context
  const compactArr = [];
  await hooks['experimental.session.compacting']({ sessionID: 'sess-1' }, { context: compactArr });
  assert.equal(compactArr.length, 1);
  assert.match(compactArr[0], /<fyi-context>/);

  // Healthy idle produces no toast; stale index triggers warning toast
  await hooks.event({ event: { type: 'session.idle' } });
  assert.equal(toasts.length, 0);

  writeFileSync(
    join(repo, '.fyi', 'docs', 'stale-trigger.md'),
    '---\ntype: doc\ntitle: Stale trigger\nstatus: active\nupdated: 2026-11-10\n---\nBody\n',
  );
  await hooks.event({ event: { type: 'session.idle' } });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body.message, /index is stale/i);
});

test('search normalizes trailing punctuation on query terms', (t) => {
  const repo = fixture(t);
  seedSampleStore(repo);
  const found = runCli(['find', 'request?', '--root', repo, '--json']);
  assert.equal(found.status, 0, found.stderr);
  const data = JSON.parse(found.stdout);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].title, 'Trace a request across services');
});
