import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractPromptTerms,
  rankForPrompt,
  shouldSkipPrompt,
  stem,
  tokenize,
} from './lib/relevance.mjs';

const ARTIFACTS = [
  {
    id: 'patterns/trace-request',
    type: 'pattern',
    title: 'Trace a request across services',
    description: 'Follow one request id through gateway, api, and worker logs.',
    apps: ['api', 'worker'],
    tags: ['logs', 'tracing', '日志', '链路追踪'],
    status: 'active',
    archived: false,
    body: 'This body mentions button, border, radius, catalog, and prefix for testing body isolation.',
  },
  {
    id: 'runbooks/deploy-web',
    type: 'runbook',
    title: 'Deploy the web app',
    description: 'Ship web to production with rollback steps.',
    apps: ['web'],
    tags: ['deploy', 'release', '部署', '发布'],
    status: 'active',
    archived: false,
    body: 'Run pnpm deploy --prod and monitor error rates.',
  },
  {
    id: 'knowledge/api/login-session',
    type: 'knowledge',
    title: 'Login session ownership',
    description: 'Who owns login tokens and session cookies.',
    apps: ['api'],
    tags: ['auth', 'session', '登录'],
    status: 'active',
    archived: false,
    body: 'Identity team owns session cookies.',
  },
  {
    id: 'patterns/slow-queries',
    type: 'pattern',
    title: 'Debug slow database queries',
    description: 'Find slow SQL queries with pg_stat_statements. 排查数据库慢查询。',
    apps: ['api'],
    tags: ['db', 'performance', '数据库', '慢查询'],
    status: 'active',
    archived: false,
    body: 'SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC;',
  },
  {
    id: 'patterns/legacy-auth',
    type: 'pattern',
    title: 'Debug legacy oauth cookies',
    description: 'Old oauth cookie debugging flow.',
    apps: ['api'],
    tags: ['oauth', 'cookies'],
    status: 'deprecated',
    archived: false,
    body: 'Deprecated flow.',
  },
  {
    id: 'archive/old-deploy',
    type: 'runbook',
    title: 'Deploy web via heroku',
    description: 'Archived web deploy steps.',
    apps: ['web'],
    tags: ['deploy', 'heroku'],
    status: 'active',
    archived: true,
    body: 'Archived.',
  },
];

test('shouldSkipPrompt rejects empty, slash/bang commands, and explicit fyi mentions', () => {
  assert.equal(shouldSkipPrompt(''), 'empty');
  assert.equal(shouldSkipPrompt('   '), 'empty');
  assert.equal(shouldSkipPrompt('/fyi find deploy'), 'command');
  assert.equal(shouldSkipPrompt('!ls -la'), 'command');
  assert.equal(shouldSkipPrompt('Can you check fyi for deploy steps?'), 'explicit');
  assert.equal(shouldSkipPrompt('How do we trace a request id?'), '');
});

test('stemmer folds English inflections without mangling CJK or short words', () => {
  assert.equal(stem('queries'), 'query');
  assert.equal(stem('deployment'), 'deploy');
  assert.equal(stem('tracing'), 'trac');
  assert.equal(stem('trace'), 'trac');
  assert.equal(stem('logs'), 'log');
  assert.equal(stem('api'), 'api');
  assert.equal(stem('数据库'), '数据库');
});

test('tokenize handles ASCII, snake_case, and CJK via Intl.Segmenter', () => {
  assert.ok(tokenize('Check pg_stat_statements!').includes('pg_stat_statements'));
  assert.ok(tokenize('Check pg_stat_statements!').includes('stat'));
  const zh = tokenize('如何部署 web 应用？');
  assert.ok(zh.includes('web'));
  assert.ok(!zh.some((t) => t.includes('？')), 'full-width punctuation must be stripped');
  assert.ok(extractPromptTerms('数据库慢查询怎么查').length >= 2);
});

test('golden precision suite: unrelated coding prompts produce zero false positives', () => {
  const negativePrompts = [
    'Fix the catalog page layout',
    'Rename prefix in the rapid build config',
    'Add a valid id check to the form',
    'Update the README wording',
    'why does the login button look blurry',
    'refactor dialog component to use hooks',
    'add a new app icon',
    'rename the session variable in utils',
    'fix typo in api docs',
    'write unit tests for the web form',
    'make the button slower to animate',
    'change border radius on the catalog card', // body-only words must not match
    '修改首页按钮的圆角和颜色',
  ];

  for (const prompt of negativePrompts) {
    const matches = rankForPrompt(prompt, ARTIFACTS);
    assert.deepEqual(
      matches.map((m) => m.artifact.id),
      [],
      `unexpected false positive for "${prompt}": ${JSON.stringify(matches.map((m) => [m.artifact.id, m.score, m.matched]))}`,
    );
  }
});

test('golden recall suite: relevant English and Chinese prompts rank the right artifact first', () => {
  const positiveCases = [
    ['How do we trace a request id in api logs?', 'patterns/trace-request'],
    ['deployment failed on web, need rollback', 'runbooks/deploy-web'],
    ['the database queries are slow today', 'patterns/slow-queries'],
    ['who owns login session cookies?', 'knowledge/api/login-session'],
    ['请帮我排查 api 请求日志里的 request id', 'patterns/trace-request'],
    ['如何部署 web 应用并回滚？', 'runbooks/deploy-web'],
    ['数据库慢查询怎么查', 'patterns/slow-queries'],
    ['tracing', 'patterns/trace-request'], // short exact-tag prompt
  ];

  for (const [prompt, expectedId] of positiveCases) {
    const matches = rankForPrompt(prompt, ARTIFACTS);
    assert.ok(matches.length >= 1, `expected a match for "${prompt}"`);
    assert.equal(
      matches[0].artifact.id,
      expectedId,
      `expected ${expectedId} first for "${prompt}", got ${matches[0].artifact.id}`,
    );
  }
});

test('deprecated and archived artifacts are excluded from automatic injection', () => {
  assert.deepEqual(rankForPrompt('debug legacy oauth cookies', ARTIFACTS), []);
  const ids = rankForPrompt('deploy web via heroku', ARTIFACTS).map((m) => m.artifact.id);
  assert.ok(!ids.includes('archive/old-deploy'), 'archived artifact must never be injected');
  assert.deepEqual(rankForPrompt('heroku migration steps', ARTIFACTS), []);
});
