import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findProjectRoot, SCRIPTS_DIR } from './lib/util.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyi-root-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(cwd, ...args) {
  return spawnSync(process.execPath, [join(SCRIPTS_DIR, 'fyi.mjs'), ...args], {
    cwd, encoding: 'utf8',
  });
}

test('nested project boundaries stop discovery before a parent store', (t) => {
  const parent = fixture(t);
  mkdirSync(join(parent, '.fyi'));
  for (const marker of ['git-directory', 'git-file', 'claude-skill', 'codex-skill', 'opencode-skill']) {
    const child = join(parent, marker);
    const cwd = join(child, 'src', 'deep');
    mkdirSync(cwd, { recursive: true });
    if (marker === 'git-directory') mkdirSync(join(child, '.git'));
    else if (marker === 'git-file') writeFileSync(join(child, '.git'), 'gitdir: /unused/worktree\n');
    else if (marker === 'claude-skill') mkdirSync(join(child, '.claude', 'skills', 'fyi'), { recursive: true });
    else if (marker === 'codex-skill') mkdirSync(join(child, '.agents', 'skills', 'fyi'), { recursive: true });
    else mkdirSync(join(child, '.opencode', 'skills', 'fyi'), { recursive: true });
    assert.equal(findProjectRoot(cwd), child);
    const context = run(cwd, 'context', '--json');
    assert.equal(context.status, 0, context.stderr);
    assert.equal(JSON.parse(context.stdout).root, child);
    assert.equal(JSON.parse(context.stdout).initialized, false);
  }
});

test('ordinary subdirectories share the nearest store and unmarked paths fall back to cwd', (t) => {
  const parent = fixture(t);
  const child = join(parent, 'src', 'deep');
  mkdirSync(child, { recursive: true });
  assert.equal(findProjectRoot(child), child);
  mkdirSync(join(parent, '.git'));
  mkdirSync(join(parent, '.fyi'));
  assert.equal(findProjectRoot(child), parent);
  mkdirSync(join(child, '.fyi'));
  assert.equal(findProjectRoot(child), child);
});

test('first-run initialization stays in a nested project and explicit root can select the parent', (t) => {
  const parent = fixture(t);
  assert.equal(run(parent, 'init', '--root', parent).status, 0);
  const parentIndex = readFileSync(join(parent, '.fyi', 'index.json'), 'utf8');
  const child = join(parent, 'nested');
  const cwd = join(child, 'src');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(child, '.git'), 'gitdir: /unused/worktree\n');
  const init = run(cwd, 'init');
  assert.equal(init.status, 0, init.stderr);
  assert.equal(existsSync(join(child, '.fyi', 'config.json')), true);
  assert.equal(existsSync(join(cwd, '.fyi')), false);
  assert.equal(readFileSync(join(parent, '.fyi', 'index.json'), 'utf8'), parentIndex);
  const search = run(cwd, 'find', 'new user', '--json');
  assert.equal(search.status, 1);
  assert.deepEqual(JSON.parse(search.stdout).results, []);
  const explicit = run(cwd, 'context', '--json', '--root', join(parent, '.fyi'));
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).root, parent);
});
