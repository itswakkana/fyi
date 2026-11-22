import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCRIPTS_DIR, parseArgs } from './lib/util.mjs';

const cli = join(SCRIPTS_DIR, 'fyi.mjs');

function run(root, args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', ...options });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fyi-safety-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('imported scripts retain permissions regardless of umask', (t) => {
  const root = fixture(t);
  const init = run(root, ['init', '--root', root]);
  assert.equal(init.status, 0, init.stderr);

  for (const [name, mode] of [['executable', 0o751], ['plain', 0o640]]) {
    const source = join(root, `${name}.sh`);
    writeFileSync(source, '#!/bin/sh\nprintf "ok\\n"\n');
    chmodSync(source, mode);
    const previousUmask = process.umask(0o077);
    let result;
    try {
      result = run(root, ['new', 'script', name, '--file', source, '--root', root]);
    } finally {
      process.umask(previousUmask);
    }
    assert.equal(result.status, 0, result.stderr);
    const target = join(root, '.fyi', 'scripts', `${name}.sh`);
    assert.equal(statSync(target).mode & 0o777, mode);
    assert.match(readFileSync(target, 'utf8'), /^#!\/bin\/sh/);
    if (name === 'executable') {
      const executed = spawnSync(target, [], { encoding: 'utf8' });
      assert.equal(executed.status, 0, executed.stderr);
      assert.equal(executed.stdout, 'ok\n');
    }
  }
});

test('trailing root after terminator fails without writing to fallback project', (t) => {
  const root = fixture(t);
  assert.equal(run(root, ['init', '--root', root]).status, 0);
  for (const args of [
    ['new', 'pattern', 'Unsafe', '--', '--root'],
    ['new', 'pattern', 'Unsafe', '--root', root, '--', '--root'],
  ]) {
    const result = run(root, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--root requires a directory/);
    assert.equal(existsSync(join(root, '.fyi', 'patterns', 'unsafe.md')), false);
  }
});

test('root after terminator still accepts a directory', () => {
  assert.deepEqual(parseArgs(['list', '--', '--root', '/tmp/example', 'other']), {
    flags: { root: '/tmp/example' }, positionals: ['list', 'other'],
  });
});
