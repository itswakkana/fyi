import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectApps } from './lib/repo.mjs';

test('app names remain unique and deterministic across path collisions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fyi-repo-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = [
    'north/apps/api', 'south/apps/api',
    'apps/web', 'services/web', 'apps/apps-web',
    'a-b/apps/job', 'a/b-apps/job',
    'apps/standalone',
  ];
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: paths }));
  for (const path of paths) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, 'package.json'), '{}');
  }

  const apps = detectApps(root);
  assert.deepEqual(detectApps(root), apps);
  assert.equal(new Set(apps.map((app) => app.name)).size, paths.length);
  const names = Object.fromEntries(apps.map((app) => [app.path, app.name]));
  assert.equal(names['north/apps/api'], 'north-apps-api');
  assert.equal(names['south/apps/api'], 'south-apps-api');
  assert.equal(names['apps/apps-web'], 'apps-web');
  assert.equal(names['apps/web'], 'apps-web-2');
  assert.equal(names['services/web'], 'services-web');
  assert.equal(names['apps/standalone'], 'standalone');
  assert.notEqual(names['a-b/apps/job'], names['a/b-apps/job']);
});
