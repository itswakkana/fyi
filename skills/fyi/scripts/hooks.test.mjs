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
import { SCRIPTS_DIR, toPosix } from './lib/util.mjs';

const CLI = join(SCRIPTS_DIR, 'fyi.mjs');

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyi-hooks-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, { cwd, input, env } = {}) {
  const mergedEnv = { ...process.env, ...env };
  if (!env || !Object.prototype.hasOwnProperty.call(env, 'CLAUDE_PROJECT_DIR')) {
    delete mergedEnv.CLAUDE_PROJECT_DIR;
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    env: mergedEnv,
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
  assert.equal(existsSync(join(repo, '.claude', 'settings.local.json')), false);
  assert.equal(existsSync(join(repo, '.codex', 'hooks.json')), true);
  assert.equal(existsSync(join(repo, '.opencode', 'plugins', 'fyi.js')), true);
  assert.equal(existsSync(join(repo, '.fyi', 'config.json')), true);

  const claudeSettings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeSettings.hooks.SessionStart[0].matcher, 'startup|clear|compact');
  assert.equal(claudeSettings.hooks.SessionStart[0].hooks[0].timeout, 5);
  assert.ok(claudeSettings.hooks.SessionStart[0].hooks[0].command.includes('--host claude'));
  assert.ok(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command.includes('--host claude'));
  assert.equal(claudeSettings.hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.ok(claudeSettings.hooks.PostToolUse[0].hooks[0].command.includes('post-tool-use --host claude'));
  assert.equal(claudeSettings.hooks.Stop, undefined);

  const codexHooks = JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codexHooks.hooks.SessionStart[0].matcher, '.*');
  assert.ok(codexHooks.hooks.SessionStart[0].hooks[0].command.includes('.agents/skills/fyi/scripts/fyi.mjs'));
  assert.ok(codexHooks.hooks.UserPromptSubmit[0].hooks[0].command.includes('--host codex'));
  assert.equal(codexHooks.hooks.PostToolUse[0].matcher, 'apply_patch|Edit|Write');
  assert.ok(codexHooks.hooks.PostToolUse[0].hooks[0].command.includes('post-tool-use --host codex'));
  assert.equal(codexHooks.hooks.Stop, undefined);

  const status = runCli(['hook', 'status', '--root', repo, '--json']);
  assert.equal(status.status, 0, status.stderr);
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.versionDrift, null);
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

test('hook run emits valid host-specific payloads, deduplicates, and stays silent when unneeded', (t) => {
  const repo = fixture(t);

  // 0. Uninitialized repo without a local skill stays completely silent on SessionStart
  const unopted = runCli(['hook', 'run', 'session-start', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, source: 'startup' }),
  });
  assert.equal(unopted.status, 0, unopted.stderr);
  assert.equal(unopted.stdout.trim(), '');

  // Installing a local skill opts the repo in even before .fyi/ is initialized
  mkdirSync(join(repo, '.claude', 'skills', 'fyi'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'skills', 'fyi', 'SKILL.md'), '---\nname: fyi\nversion: 1.0.1\n---\n');
  const optedUninit = runCli(['hook', 'run', 'session-start', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, source: 'startup' }),
  });
  assert.equal(optedUninit.status, 0, optedUninit.stderr);
  assert.match(JSON.parse(optedUninit.stdout).hookSpecificOutput.additionalContext, /not initialized yet/);

  seedSampleStore(repo);

  // 1. SessionStart — emits absolute CLI + --root; skips resume
  const claudeStart = runCli(['hook', 'run', 'session-start', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }),
  });
  assert.equal(claudeStart.status, 0, claudeStart.stderr);
  const claudeStartJson = JSON.parse(claudeStart.stdout);
  assert.equal(claudeStartJson.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(claudeStartJson.hookSpecificOutput.additionalContext, /<fyi-context>/);
  assert.match(claudeStartJson.hookSpecificOutput.additionalContext, /1 artifact/);
  assert.ok(claudeStartJson.hookSpecificOutput.additionalContext.includes(`--root ${toPosix(repo)}`));

  const resumed = runCli(['hook', 'run', 'session-start', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, source: 'resume' }),
  });
  assert.equal(resumed.status, 0);
  assert.equal(resumed.stdout.trim(), '');

  const codexStart = runCli(['hook', 'run', 'session-start', '--host', 'codex'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo }),
  });
  assert.equal(codexStart.status, 0, codexStart.stderr);
  assert.match(codexStart.stdout, /^<fyi-context>/);

  // 2. UserPromptSubmit — relevant prompt matches, unrelated and slash prompts stay silent
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

  for (const noisy of [
    'Rename the primary button border radius to 8px',
    'fix typo in api docs',
    '/fyi find trace request',
  ]) {
    const silent = runCli(['hook', 'run', 'prompt-submit', '--host', 'claude'], {
      cwd: repo,
      input: JSON.stringify({ cwd: repo, prompt: noisy }),
    });
    assert.equal(silent.status, 0, silent.stderr);
    assert.equal(silent.stdout.trim(), '', `expected silence for "${noisy}"`);
  }

  // Transcript deduplication skips already-injected ids
  const transcript = join(repo, 'transcript.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ content: '<fyi-matches>\n- [pattern] Trace a request across services (`patterns/trace-a-request-across-services`)\n</fyi-matches>' })}\n`,
  );
  const deduped = runCli(['hook', 'run', 'prompt-submit', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({
      cwd: repo,
      prompt: 'How do we trace a request id in api logs?',
      transcript_path: transcript,
    }),
  });
  assert.equal(deduped.status, 0);
  assert.equal(deduped.stdout.trim(), '');

  // 3. PostToolUse — silent on code edits, nudges agent when .fyi/ is edited
  const codeEdit = runCli(['hook', 'run', 'post-tool-use', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, tool_input: { file_path: join(repo, 'src', 'index.js') } }),
  });
  assert.equal(codeEdit.status, 0);
  assert.equal(codeEdit.stdout.trim(), '');

  // Generated file hand-edit warning
  const generatedEdit = runCli(['hook', 'run', 'post-tool-use', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, tool_input: { file_path: join(repo, '.fyi', 'INDEX.md') } }),
  });
  assert.equal(generatedEdit.status, 0);
  const generatedJson = JSON.parse(generatedEdit.stdout);
  assert.equal(generatedJson.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(generatedJson.hookSpecificOutput.additionalContext, /INDEX\.md is generated/);

  // Direct artifact edit makes index stale -> PostToolUse tells agent to rebuild index
  writeFileSync(
    join(repo, '.fyi', 'docs', 'extra.md'),
    '---\ntype: doc\ntitle: Extra\nstatus: active\nupdated: 2026-11-10\n---\nBody\n',
  );
  const staleClaude = runCli(['hook', 'run', 'post-tool-use', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, tool_input: { file_path: '.fyi/docs/extra.md' } }),
  });
  assert.equal(staleClaude.status, 0);
  assert.match(JSON.parse(staleClaude.stdout).hookSpecificOutput.additionalContext, /index is now stale/);

  // Codex apply_patch payload shape
  const staleCodex = runCli(['hook', 'run', 'post-tool-use', '--host', 'codex'], {
    cwd: repo,
    input: JSON.stringify({
      cwd: repo,
      tool_name: 'apply_patch',
      tool_input: { patch: '*** Begin Patch\n*** Add File: .fyi/docs/extra.md\n+hello\n*** End Patch\n' },
    }),
  });
  assert.equal(staleCodex.status, 0);
  assert.match(JSON.parse(staleCodex.stdout).hookSpecificOutput.additionalContext, /index is now stale/);

  // 4. Legacy Stop — silent when index is stale or healthy; warns only on unreadable config; respects stop_hook_active
  const staleStop = runCli(['hook', 'run', 'stop', '--host', 'codex'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, stop_hook_active: false }),
  });
  assert.equal(staleStop.status, 0);
  assert.equal(staleStop.stdout.trim(), '');

  writeFileSync(join(repo, '.fyi', 'config.json'), '{broken');
  const brokenConfigStop = runCli(['hook', 'run', 'stop', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, stop_hook_active: false }),
  });
  assert.equal(brokenConfigStop.status, 0);
  assert.match(JSON.parse(brokenConfigStop.stdout).systemMessage, /config\.json/i);

  const guardedStop = runCli(['hook', 'run', 'stop', '--host', 'claude'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, stop_hook_active: true }),
  });
  assert.equal(guardedStop.status, 0);
  assert.equal(guardedStop.stdout.trim(), '');
});

test('plugin hooks yield when project hooks are installed and prefer CLAUDE_PROJECT_DIR over submodule cwd', (t) => {
  const repo = fixture(t);
  seedSampleStore(repo);

  // Without project hooks, --source plugin runs normally
  const pluginOnly = runCli(['hook', 'run', 'session-start', '--host', 'claude', '--source', 'plugin'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo }),
  });
  assert.equal(pluginOnly.status, 0);
  assert.match(pluginOnly.stdout, /<fyi-context>/);

  // Nested submodule with its own .git still resolves parent repo via CLAUDE_PROJECT_DIR
  const sub = join(repo, 'vendor', 'sub');
  mkdirSync(join(sub, '.git'), { recursive: true });
  const fromSub = runCli(['hook', 'run', 'session-start', '--host', 'claude'], {
    cwd: sub,
    env: { CLAUDE_PROJECT_DIR: repo },
    input: JSON.stringify({ cwd: sub }),
  });
  assert.equal(fromSub.status, 0);
  assert.match(fromSub.stdout, /1 artifact/);

  // Once project hooks are installed, --source plugin yields silently
  assert.equal(runCli(['hook', 'install', '--agents', 'claude', '--root', repo]).status, 0);
  const yielded = runCli(['hook', 'run', 'session-start', '--host', 'claude', '--source', 'plugin'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo }),
  });
  assert.equal(yielded.status, 0);
  assert.equal(yielded.stdout.trim(), '');
});

test('Claude routes absolute paths to settings.local.json and migrates to settings.json once local skill exists', (t) => {
  const repo = fixture(t);

  // No local skill -> writes .claude/settings.local.json (keeps .claude/settings.json clean for git)
  const localInstall = runCli(['hook', 'install', '--agents', 'claude', '--root', repo, '--json']);
  assert.equal(localInstall.status, 0, localInstall.stderr);
  assert.equal(existsSync(join(repo, '.claude', 'settings.local.json')), true);
  assert.equal(existsSync(join(repo, '.claude', 'settings.json')), false);

  // Once a project-local skill is installed, hook install migrates hooks to .claude/settings.json
  assert.equal(runCli(['install', repo, '--agents', 'claude']).status, 0);
  assert.equal(runCli(['hook', 'install', '--agents', 'claude', '--root', repo]).status, 0);
  assert.equal(existsSync(join(repo, '.claude', 'settings.json')), true);
  const localAfter = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(localAfter.hooks, undefined);
});

test('hook install and uninstall preserve unrelated settings, are idempotent, and strip legacy Stop hooks', (t) => {
  const repo = fixture(t);
  // Install local skills so Claude writes .claude/settings.json
  assert.equal(runCli(['install', repo, '--agents', 'all']).status, 0);

  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify(
      {
        permissions: { allow: ['Read'] },
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'node .claude/skills/fyi/scripts/fyi.mjs hook run stop --host claude' }] }],
        },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(repo, '.codex'), { recursive: true });
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

  // Before refresh, hook status flags the legacy Stop hook
  const before = JSON.parse(runCli(['hook', 'status', '--root', repo, '--json']).stdout);
  assert.match(before.agents.claude.issue, /legacy Stop hook/);

  // Install twice to verify idempotency and legacy Stop removal
  assert.equal(runCli(['hook', 'install', '--agents', 'all', '--root', repo]).status, 0);
  assert.equal(runCli(['hook', 'install', '--agents', 'all', '--root', repo]).status, 0);

  const claude = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claude.permissions, { allow: ['Read'] });
  assert.equal(claude.hooks.SessionStart.length, 2);
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, 'echo user-hook');
  assert.equal(claude.hooks.Stop, undefined);
  assert.equal(claude.hooks.PostToolUse.length, 1);

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
  assert.equal(claudeAfter.hooks.PostToolUse, undefined);

  const codexAfter = JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codexAfter.hooks.PreToolUse.length, 1);
  assert.equal(codexAfter.hooks.SessionStart, undefined);
  assert.equal(existsSync(join(repo, '.opencode', 'plugins', 'fyi.js')), false);
});

test('hook status and doctor catch missing configured CLI paths and local skill version drift', (t) => {
  const repo = fixture(t);
  assert.equal(runCli(['install', repo, '--agents', 'claude,codex', '--hooks', '--init']).status, 0);

  // Point Claude's configured command at a non-existent CLI path
  const settingsPath = join(repo, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.hooks.SessionStart[0].hooks[0].command = 'node .claude/skills/fyi/scripts/missing-fyi.mjs hook run session-start --host claude';
  // Keep `fyi.mjs` suffix so isFyiHandler recognizes it while path is missing
  settings.hooks.SessionStart[0].hooks[0].command = 'node /nonexistent/path/fyi.mjs hook run session-start --host claude';
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // Create version drift between Claude and Codex local skill copies
  const codexSkill = join(repo, '.agents', 'skills', 'fyi', 'SKILL.md');
  writeFileSync(codexSkill, readFileSync(codexSkill, 'utf8').replace(/version:\s*\S+/, 'version: 0.9.0'));

  const doctor = JSON.parse(runCli(['doctor', '--root', repo, '--json']).stdout);
  assert.ok(doctor.warnings.some((w) => /missing CLI/i.test(w)), `expected missing CLI warning, got ${JSON.stringify(doctor.warnings)}`);
  assert.ok(doctor.warnings.some((w) => /mismatched versions/i.test(w)), `expected version drift warning, got ${JSON.stringify(doctor.warnings)}`);
});

test('hook install refuses invalid JSON, unmanaged OpenCode plugins, and symlinks', (t) => {
  const repo = fixture(t);
  // Install local claude skill so claude targets .claude/settings.json
  assert.equal(runCli(['install', repo, '--agents', 'claude']).status, 0);
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

test('generated OpenCode plugin loads as ESM, handles edits, caches reads, and deduplicates toasts', async (t) => {
  const repo = fixture(t);
  // Node 18 requires package.json type=module to dynamically import a .js file; OpenCode runs on Bun.
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
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

  // Healthy idle produces no toast; stale index triggers toast once per session
  await hooks.event({ event: { type: 'session.idle', sessionID: 'sess-1' } });
  assert.equal(toasts.length, 0);

  const extraFile = join(repo, '.fyi', 'docs', 'stale-trigger.md');
  writeFileSync(
    extraFile,
    '---\ntype: doc\ntitle: Stale trigger\nstatus: active\nupdated: 2026-11-10\n---\nBody\n',
  );

  // Edit tool hook appends <fyi-notice> directly to tool output
  await hooks['tool.execute.before']({ tool: 'write', callID: 'c1' }, { args: { filePath: extraFile } });
  const toolOut = { output: 'Wrote file.' };
  await hooks['tool.execute.after']({ tool: 'write', callID: 'c1' }, toolOut);
  assert.match(toolOut.output, /<fyi-notice>/);
  assert.match(toolOut.output, /index is now stale/);

  // Idle toast fires once per session for the same message
  await hooks.event({ event: { type: 'session.idle', sessionID: 'sess-1' } });
  await hooks.event({ event: { type: 'session.idle', sessionID: 'sess-1' } });
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
