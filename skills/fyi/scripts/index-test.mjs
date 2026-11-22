import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexStatus, rebuildIndex, walkArtifacts } from './lib/store.mjs';

const cli = fileURLToPath(new URL('./fyi.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fyi-index-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, '.fyi');
  mkdirSync(join(store, 'docs'), { recursive: true });
  writeFileSync(join(store, 'docs', 'example.md'), '# Example\n');
  return { root, store, json: join(store, 'index.json'), markdown: join(store, 'INDEX.md') };
}

function noStaging(store) {
  assert.deepEqual(readdirSync(store).filter((name) => name.startsWith('.index-')), []);
}

function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--root', root], { cwd: root, encoding: 'utf8' });
}

test('rebuild generates both indexes and reflects later changes', (t) => {
  const f = fixture(t);
  rebuildIndex(f.root);
  assert.equal(indexStatus(f.root), 'fresh');
  assert.match(readFileSync(f.markdown, 'utf8'), /Example/);
  writeFileSync(join(f.store, 'docs', 'example.md'), '# Changed\n');
  assert.equal(indexStatus(f.root), 'stale');
  rebuildIndex(f.root);
  assert.equal(indexStatus(f.root), 'fresh');
  assert.match(readFileSync(f.markdown, 'utf8'), /Changed/);
  assert.equal(JSON.parse(readFileSync(f.json, 'utf8')).artifacts[0].title, 'Changed');
  noStaging(f.store);
});

test('render failure leaves both previous indexes unchanged', (t) => {
  const f = fixture(t);
  rebuildIndex(f.root);
  const json = readFileSync(f.json, 'utf8');
  const markdown = readFileSync(f.markdown, 'utf8');
  const artifacts = walkArtifacts(f.root);
  artifacts[0].apps = null;
  assert.throws(() => rebuildIndex(f.root, artifacts));
  assert.equal(readFileSync(f.json, 'utf8'), json);
  assert.equal(readFileSync(f.markdown, 'utf8'), markdown);
  noStaging(f.store);
});

test('blocked Markdown destination preserves the previous JSON', (t) => {
  const f = fixture(t);
  rebuildIndex(f.root);
  const json = readFileSync(f.json, 'utf8');
  rmSync(f.markdown);
  mkdirSync(f.markdown);
  writeFileSync(join(f.store, 'docs', 'example.md'), '# Changed\n');
  assert.throws(() => rebuildIndex(f.root), /non-file/);
  assert.equal(readFileSync(f.json, 'utf8'), json);
  noStaging(f.store);
});

test('write commands refuse a symlinked .fyi root without touching its target', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fyi-index-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, '.fyi'));
  for (const args of [['init'], ['index'], ['new', 'pattern', 'Probe'], ['organize', '--fix']]) {
    const result = run(root, ...args);
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
    assert.match(result.stderr, /\.fyi is a symlink/);
    assert.deepEqual(readdirSync(outside), []);
  }
});

test('doctor JSON exposes soft warnings as structured checks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fyi-doctor-json-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = run(root, 'init');
  assert.equal(init.status, 0, init.stderr);
  const doctor = run(root, 'doctor', '--json');
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.deepEqual(report.softWarnings.map((check) => check.name), ['apps', 'artifacts']);
  assert.equal(report.warnings.length, 0);
});

test('rebuild refuses a symlinked .fyi root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fyi-index-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, '.fyi'));
  assert.throws(() => rebuildIndex(root), /\.fyi is a symlink/);
  assert.deepEqual(readdirSync(outside), []);
});

test('symlinked destinations are refused without modifying either target', (t) => {
  for (const target of ['index.json', 'INDEX.md']) {
    const f = fixture(t);
    rebuildIndex(f.root);
    const other = target === 'index.json' ? f.markdown : f.json;
    const before = readFileSync(other, 'utf8');
    const outside = join(f.root, 'outside');
    writeFileSync(outside, 'outside');
    rmSync(join(f.store, target));
    symlinkSync(outside, join(f.store, target));
    assert.throws(() => rebuildIndex(f.root), /symlink/);
    assert.equal(readFileSync(outside, 'utf8'), 'outside');
    assert.equal(readFileSync(other, 'utf8'), before);
    noStaging(f.store);
  }
});
