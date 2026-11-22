#!/usr/bin/env node
/**
 * Self-test for the fyi CLI. Runs in a throwaway directory so it never
 * touches the real store.
 *
 *   node skills/fyi/scripts/selftest.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SCRIPTS_DIR, SKILL_DIR, VERSION, findProjectRoot } from './lib/util.mjs';

const CLI = join(SCRIPTS_DIR, 'fyi.mjs');
let passed = 0;
let failed = 0;

function run(args, root) {
  return spawnSync(process.execPath, [CLI, ...args, '--root', root], {
    encoding: 'utf8',
    // Run inside the fixture so a root-resolution fallback can never write
    // into the real repository.
    cwd: root,
  });
}

function jsonOf(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fyi-selftest-'));
  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, workspaces: ['apps/*'] }),
  );
  writeFileSync(
    join(root, 'apps', 'api', 'package.json'),
    JSON.stringify({ name: '@fixture/api', description: 'The API app.' }),
  );
  writeFileSync(
    join(root, 'apps', 'web', 'package.json'),
    JSON.stringify({ name: '@fixture/web', description: 'The web app.' }),
  );
  return root;
}

const root = fixture();
// Guard: the suite must never modify the real repository's store.
const repoStore = join(findProjectRoot(SKILL_DIR), '.fyi');
const repoSnapshot = existsSync(repoStore)
  ? readdirSync(repoStore, { recursive: true }).sort().join('\n')
  : '';
try {
  console.log('fyi selftest');

  // --- init -------------------------------------------------------------
  const init = run(['init'], root);
  check('init exits 0', init.status === 0, init.stderr);
  check('store created', existsSync(join(root, '.fyi', 'config.json')));
  const config = JSON.parse(readFileSync(join(root, '.fyi', 'config.json'), 'utf8'));
  check('detects two apps', config.apps.length === 2, JSON.stringify(config.apps));
  check('seeds app overviews', existsSync(join(root, '.fyi', 'knowledge', 'api', 'overview.md')));

  // --- capture ----------------------------------------------------------
  const pattern = run(
    [
      'new',
      'pattern',
      'Trace a request across services',
      '--app',
      'api',
      '--tag',
      'logs,tracing',
      '--description',
      'Follow one request id through gateway, api, and worker logs.',
    ],
    root,
  );
  check('creates pattern', pattern.status === 0, pattern.stderr);
  check(
    'pattern file exists',
    existsSync(join(root, '.fyi', 'patterns', 'trace-a-request-across-services.md')),
  );

  const knowledge = run(
    ['new', 'knowledge', 'Refund policy', '--app', 'api', '--description', 'How refunds settle.'],
    root,
  );
  check('creates app-scoped knowledge', knowledge.status === 0, knowledge.stderr);
  check(
    'knowledge scoped to api',
    existsSync(join(root, '.fyi', 'knowledge', 'api', 'refund-policy.md')),
  );

  const shared = run(
    ['new', 'knowledge', 'Shared fact', '--description', 'Cross-app behavior.'],
    root,
  );
  check('creates shared knowledge', shared.status === 0, shared.stderr);
  check(
    'shared knowledge has no app-scope warning',
    !run(['doctor'], root).stdout.includes('no app scope'),
  );

  // --- script metadata round-trip --------------------------------------
  const source = join(root, 'helper.mjs');
  writeFileSync(source, '#!/usr/bin/env node\nconsole.log("ok");\n');
  const script = run(
    [
      'new',
      'script',
      'Dump slow queries',
      '--file',
      source,
      '--app',
      'api',
      '--tag',
      'database',
      '--description',
      'Slowest queries per hour.',
    ],
    root,
  );
  check('creates script', script.status === 0, script.stderr);
  const scriptPath = join(root, '.fyi', 'scripts', 'dump-slow-queries.mjs');
  check('script file exists', existsSync(scriptPath));
  const scriptText = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
  check('script keeps shebang first', scriptText.startsWith('#!/usr/bin/env node'));
  check('script has frontmatter', scriptText.includes('type: script'));

  const listed = jsonOf(run(['list', '--json'], root));
  const scriptEntry = listed?.artifacts?.find((entry) => entry.id === 'scripts/dump-slow-queries');
  check('script metadata parses back', Boolean(scriptEntry));
  check('script title round-trips', scriptEntry?.title === 'Dump slow queries', scriptEntry?.title);
  check(
    'script apps round-trip',
    JSON.stringify(scriptEntry?.apps) === JSON.stringify(['api']),
    JSON.stringify(scriptEntry?.apps),
  );
  check(
    'script tags round-trip',
    JSON.stringify(scriptEntry?.tags) === JSON.stringify(['database']),
    JSON.stringify(scriptEntry?.tags),
  );
  check(
    'script description round-trips',
    scriptEntry?.description === 'Slowest queries per hour.',
    scriptEntry?.description,
  );
  check(
    'doctor does not warn about generated script metadata',
    !run(['doctor'], root).stdout.includes('script has no metadata frontmatter'),
  );

  // --- search -----------------------------------------------------------
  const find = run(['find', 'request id logs'], root);
  check('find exits 0', find.status === 0, find.stderr);
  check('find returns the pattern', find.stdout.includes('Trace a request across services'));

  const findJson = run(['find', 'refund', '--json'], root);
  const parsed = jsonOf(findJson);
  check('find --json parses', Boolean(parsed));
  check('find --json has results', Boolean(parsed && parsed.total >= 1));

  const flagOrder = jsonOf(run(['find', '--json', 'no-such-thing'], root));
  check('boolean flag before query does not swallow it', flagOrder?.total === 0);
  check(
    'find --json no-match exits 1',
    run(['find', 'zzzz-nothing', '--json'], root).status === 1,
  );

  // --- organize / index -------------------------------------------------
  const near = jsonOf(run(['organize', '--json'], root));
  check('app overviews are not near-duplicates', near?.nearDuplicates?.length === 0);

  const handPath = join(root, '.fyi', 'patterns', 'hand-written.md');
  writeFileSync(
    handPath,
    `---
type: pattern
title: Hand written
description: >
  This description spans
  two folded lines.
tags:
  - logs
  - tracing
meta:
  team: platform
status: active
---
body
`,
  );
  const fix = run(['organize', '--fix'], root);
  check('organize --fix exits 0', fix.status === 0, fix.stderr);
  const handText = readFileSync(handPath, 'utf8');
  check('fix preserves folded scalar', handText.includes('This description spans'));
  check('fix preserves nested map', handText.includes('team: platform'));
  check('fix stamps updated', /^updated: \d{4}-\d{2}-\d{2}$/m.test(handText));

  const doctor = run(['doctor'], root);
  check('doctor exits 0', doctor.status === 0, doctor.stderr);
  check('doctor reports healthy', doctor.stdout.includes('Healthy'));

  const index = run(['index'], root);
  check('index exits 0', index.status === 0, index.stderr);
  check('INDEX.md exists', existsSync(join(root, '.fyi', 'INDEX.md')));

  const context = run(['context', '--json'], root);
  const contextJson = jsonOf(context);
  check('context --json parses', Boolean(contextJson));
  check('context counts artifacts', Boolean(contextJson && contextJson.counts.total >= 3));

  // --- index drift ------------------------------------------------------
  writeFileSync(handPath, readFileSync(handPath, 'utf8').replace('title: Hand written', 'title: Hand written edited'));
  const drift = jsonOf(run(['context', '--json'], root));
  check('index drift is detected', drift?.index === 'stale', drift?.index);
  run(['index'], root);
  check('index rebuild restores freshness', jsonOf(run(['context', '--json'], root))?.index === 'fresh');

  // --- safety -----------------------------------------------------------
  const traversal = run(['new', 'knowledge', 'Escape', '--app', '../../escape'], root);
  check('path traversal via --app is rejected', traversal.status !== 0);
  check('no file written outside the store', !existsSync(join(root, '..', 'escape', 'escape.md')));

  const unsupportedSource = join(root, 'notes.txt');
  writeFileSync(unsupportedSource, 'x');
  const unsupported = run(['new', 'script', 'Notes', '--file', unsupportedSource], root);
  check('unsupported script source is rejected', unsupported.status !== 0, unsupported.stderr);

  const evil = run(['new', 'script', 'Evil */ title'], root);
  check('script title containing */ is accepted', evil.status === 0, evil.stderr);
  const evilCheck = spawnSync(
    process.execPath,
    ['--check', join(root, '.fyi', 'scripts', 'evil-title.mjs')],
    { encoding: 'utf8' },
  );
  check('generated script with */ is valid JavaScript', evilCheck.status === 0, evilCheck.stderr);

  const multiline = run(['new', 'doc', 'Multiline', '--description', 'line one\nline two'], root);
  check('multiline description is accepted', multiline.status === 0, multiline.stderr);
  const multilineShow = jsonOf(run(['show', 'multiline', '--json'], root));
  check('multiline description round-trips', multilineShow?.description === 'line one\nline two');

  const separator = run(['new', 'doc', 'Separator', '--description', 'before ---'], root);
  check('value ending in --- is accepted', separator.status === 0, separator.stderr);
  const separatorShow = jsonOf(run(['show', 'separator', '--json'], root));
  check(
    'value ending in --- does not corrupt frontmatter',
    separatorShow?.description === 'before ---',
    separatorShow?.description,
  );

  const multilineScript = run(['new', 'script', 'line one\nline two'], root);
  check('multiline script title is accepted', multilineScript.status === 0, multilineScript.stderr);
  const multilineScriptCheck = spawnSync(
    process.execPath,
    ['--check', join(root, '.fyi', 'scripts', 'line-one-line-two.mjs')],
    { encoding: 'utf8' },
  );
  check(
    'multiline script title produces valid JavaScript',
    multilineScriptCheck.status === 0,
    multilineScriptCheck.stderr,
  );

  const pythonScript = run(['new', 'script', 'T """ break', '--ext', '.py'], root);
  check('python title with triple quotes is accepted', pythonScript.status === 0, pythonScript.stderr);
  const pythonCheck = spawnSync(
    'python3',
    ['-m', 'py_compile', join(root, '.fyi', 'scripts', 't-break.py')],
    { encoding: 'utf8' },
  );
  if (pythonCheck.error?.code === 'ENOENT') {
    check('python triple-quote compile skipped (no python3)', true);
  } else {
    check(
      'python title with triple quotes compiles',
      pythonCheck.status === 0,
      pythonCheck.stderr,
    );
  }

  const quotedPath = join(root, '.fyi', 'docs', 'quoted.md');
  writeFileSync(
    quotedPath,
    `---\ntype: doc\ntitle: "foo" # note\ntags: ["a # b", c]\nstatus: active\nupdated: 2026-01-01\n---\nbody\n`,
  );
  const quoted = jsonOf(run(['show', 'quoted', '--json'], root));
  check('quoted title strips a trailing comment', quoted?.title === 'foo', quoted?.title);
  check(
    'hash inside a quoted tag survives',
    JSON.stringify(quoted?.tags) === JSON.stringify(['a # b', 'c']),
    JSON.stringify(quoted?.tags),
  );

  const awsLikeKey = ['AKIA', 'Z7Q2LMN4RT6XW9PY'].join('');
  const secret = run(
    ['new', 'doc', 'Leaky', '--description', `Use ${awsLikeKey} # example`],
    root,
  );
  check('secret artifact is created for the test', secret.status === 0, secret.stderr);
  const secretDoctor = run(['doctor'], root);
  check('doctor fails on a secret in frontmatter', secretDoctor.status === 1);
  check(
    'doctor names the secret finding',
    secretDoctor.stdout.includes('possible secret'),
    secretDoctor.stdout,
  );
  rmSync(join(root, '.fyi', 'docs', 'leaky.md'));
  run(['index'], root);

  const mixed = run(
    ['new', 'doc', 'Mixed', '--description', `Use <token> and ${awsLikeKey} here`],
    root,
  );
  check('artifact with a secret beside a placeholder is created', mixed.status === 0, mixed.stderr);
  check(
    'secret beside a placeholder is still detected',
    run(['doctor'], root).status === 1,
  );
  rmSync(join(root, '.fyi', 'docs', 'mixed.md'));
  run(['index'], root);

  try {
    const outside = join(root, 'outside.md');
    writeFileSync(outside, 'TOPSECRET\n');
    symlinkSync(outside, join(root, '.fyi', 'docs', 'leak.md'));
    const leakList = run(['list', '--json'], root);
    check('symlinked artifacts are skipped', !leakList.stdout.includes('TOPSECRET'));
    rmSync(join(root, '.fyi', 'docs', 'leak.md'));
  } catch {
    check('symlink test skipped (unsupported platform)', true);
  }

  const parentSymRoot = mkdtempSync(join(tmpdir(), 'fyi-parentsym-'));
  try {
    run(['init'], parentSymRoot);
    const outsideDir = join(parentSymRoot, 'outside-patterns');
    mkdirSync(outsideDir, { recursive: true });
    rmSync(join(parentSymRoot, '.fyi', 'patterns'), { recursive: true, force: true });
    symlinkSync(outsideDir, join(parentSymRoot, '.fyi', 'patterns'));
    const escape = run(['new', 'pattern', 'Escape pattern'], parentSymRoot);
    check('new refuses a symlinked type directory', escape.status !== 0);
    check(
      'new does not write outside a symlinked type directory',
      !existsSync(join(outsideDir, 'escape-pattern.md')),
    );
  } finally {
    rmSync(parentSymRoot, { recursive: true, force: true });
  }

  const indexSymRoot = mkdtempSync(join(tmpdir(), 'fyi-idxsym-'));
  try {
    run(['init'], indexSymRoot);
    const outsideIndex = join(indexSymRoot, 'outside-index.json');
    rmSync(join(indexSymRoot, '.fyi', 'index.json'), { force: true });
    symlinkSync(outsideIndex, join(indexSymRoot, '.fyi', 'index.json'));
    const partial = run(['new', 'doc', 'Partial'], indexSymRoot);
    check('new refuses a symlinked index', partial.status !== 0);
    check(
      'new does not create the artifact when the index is symlinked',
      !existsSync(join(indexSymRoot, '.fyi', 'docs', 'partial.md')),
    );
    check('new does not create the outside index target', !existsSync(outsideIndex));
  } finally {
    rmSync(indexSymRoot, { recursive: true, force: true });
  }

  const appSymRoot = mkdtempSync(join(tmpdir(), 'fyi-appsym-'));
  try {
    mkdirSync(join(appSymRoot, 'apps', 'api'), { recursive: true });
    writeFileSync(
      join(appSymRoot, 'package.json'),
      JSON.stringify({ name: 'x', workspaces: ['apps/*'] }),
    );
    writeFileSync(
      join(appSymRoot, 'apps', 'api', 'package.json'),
      JSON.stringify({ name: 'api' }),
    );
    run(['init'], appSymRoot);
    const outsideApi = join(appSymRoot, 'outside-api');
    mkdirSync(outsideApi, { recursive: true });
    rmSync(join(appSymRoot, '.fyi', 'knowledge', 'api'), { recursive: true, force: true });
    symlinkSync(outsideApi, join(appSymRoot, '.fyi', 'knowledge', 'api'));
    const initEscape = run(['init'], appSymRoot);
    check('init refuses a symlinked app directory', initEscape.status !== 0);
    check(
      'init does not write outside a symlinked app directory',
      !existsSync(join(outsideApi, 'overview.md')),
    );
  } finally {
    rmSync(appSymRoot, { recursive: true, force: true });
  }

  // --- refresh / limits -------------------------------------------------
  rmSync(join(root, 'apps', 'web'), { recursive: true, force: true });
  mkdirSync(join(root, 'apps', 'worker'), { recursive: true });
  writeFileSync(join(root, 'apps', 'worker', 'package.json'), JSON.stringify({ name: '@fixture/worker' }));
  const refresh = jsonOf(run(['init', '--refresh', '--json'], root));
  const names = (refresh?.apps || []).map((app) => app.name);
  check('refresh adds a new app', names.includes('worker'), JSON.stringify(names));
  check('refresh prunes a removed app', !names.includes('web'), JSON.stringify(names));
  check('refresh reports the removed app', (refresh?.removed || []).some((app) => app.name === 'web'));

  const limited = jsonOf(run(['list', '--limit', '1', '--json'], root));
  check('list honors --limit', limited?.artifacts?.length === 1, JSON.stringify(limited?.artifacts?.length));
  check(
    'list reports the pre-limit total',
    limited?.total > 1 && limited?.shown === 1,
    JSON.stringify({ total: limited?.total, shown: limited?.shown }),
  );

  const badLimit = run(['find', 'x', '--limit', 'abc'], root);
  check('invalid --limit is rejected', badLimit.status !== 0);
  check('--limit without a value is rejected', run(['list', '--limit'], root).status !== 0);
  check(
    '--app without a value is rejected',
    run(['new', 'knowledge', 'No app', '--app'], root).status !== 0,
  );
  check('value-less find filter is rejected', run(['find', 'x', '--tag'], root).status !== 0);
  check('unknown flag is rejected', run(['find', 'x', '--appp', 'api'], root).status !== 0);

  const version = run(['--version'], root);
  check('--version prints the version', version.stdout.includes(`fyi skill ${VERSION}`), version.stdout);

  const archivedOnly = jsonOf(run(['find', '--include-archived', '--json'], root));
  check('--include-archived alone is a valid filter', Boolean(archivedOnly));

  const duplicate = run(['new', 'pattern', 'Trace a request across services'], root);
  check('refuses a duplicate artifact path', duplicate.status !== 0);

  // --- "--" must not swallow --root ------------------------------------
  const dashRoot = mkdtempSync(join(tmpdir(), 'fyi-dashroot-'));
  try {
    const cwdStore = join(dashRoot, 'cwd');
    const targetStore = join(dashRoot, 'target');
    mkdirSync(cwdStore, { recursive: true });
    mkdirSync(targetStore, { recursive: true });
    run(['init'], cwdStore);
    run(['init'], targetStore);
    const dashed = spawnSync(
      process.execPath,
      [CLI, 'new', 'pattern', '--', '-dash title', '--root', targetStore],
      { encoding: 'utf8', cwd: cwdStore },
    );
    check('"--" with --root writes to the requested root', dashed.status === 0, dashed.stderr);
    check(
      'the file lands in the requested root',
      existsSync(join(targetStore, '.fyi', 'patterns', 'dash-title.md')),
    );
    check(
      'nothing is written to the cwd store',
      !existsSync(join(cwdStore, '.fyi', 'patterns', 'dash-title.md')),
    );
  } finally {
    rmSync(dashRoot, { recursive: true, force: true });
  }

  // --- dash-prefixed values --------------------------------------------
  const dashValue = run(['new', 'doc', 'Dash value', '--description=--json'], root);
  check('a dash-prefixed value is accepted with =', dashValue.status === 0, dashValue.stderr);
  const dashList = jsonOf(run(['list', '--json'], root));
  check(
    'the dash-prefixed value round-trips',
    dashList?.artifacts?.some((artifact) => artifact.description === '--json'),
  );
  check(
    'a value-less --description is still rejected',
    run(['new', 'doc', 'No value', '--description'], root).status !== 0,
  );

  // --- secret placeholders ---------------------------------------------
  const placeholderRoot = mkdtempSync(join(tmpdir(), 'fyi-placeholder-'));
  try {
    run(['init'], placeholderRoot);
    writeFileSync(
      join(placeholderRoot, '.fyi', 'docs', 'ph.md'),
      `---\ntype: doc\ntitle: Ph\ndescription: d\napps: []\ntags: []\nstatus: active\nupdated: 2026-01-01\n---\npassword: {{PH}}\napi_key: <K>\ntoken: <TOK>\nsecret: {{ANOTHER}}\n`,
    );
    const placeholderDoctor = run(['doctor'], placeholderRoot);
    check(
      'placeholder credential values are not flagged',
      !placeholderDoctor.stdout.includes('possible secret'),
      placeholderDoctor.stdout,
    );
  } finally {
    rmSync(placeholderRoot, { recursive: true, force: true });
  }

  // --- markdown horizontal rules ---------------------------------------
  const ruleRoot = mkdtempSync(join(tmpdir(), 'fyi-rule-'));
  try {
    run(['init'], ruleRoot);
    const rulePath = join(ruleRoot, '.fyi', 'docs', 'hr.md');
    const ruleText = `---\n# Real Title\n\nIntro paragraph with important content.\n\n---\n\nSecond section.\n`;
    writeFileSync(rulePath, ruleText);
    run(['organize', '--fix'], ruleRoot);
    check(
      'a Markdown document with a horizontal rule is untouched',
      readFileSync(rulePath, 'utf8') === ruleText,
    );
    const ruleShow = jsonOf(run(['show', 'hr', '--json'], ruleRoot));
    check(
      'the title of a rule document is preserved',
      ruleShow?.title === 'Real Title',
      ruleShow?.title,
    );
  } finally {
    rmSync(ruleRoot, { recursive: true, force: true });
  }

  // --- script section dividers -----------------------------------------
  const dividerRoot = mkdtempSync(join(tmpdir(), 'fyi-divider-'));
  try {
    run(['init'], dividerRoot);
    const divider = join(dividerRoot, 'div.sh');
    writeFileSync(
      divider,
      '#!/usr/bin/env bash\n# ---\n# title: My Section Header\n# ---\necho "content"\n\n# ---\n# Another section\n# ---\necho bye\n',
    );
    run(['new', 'script', 'Divider', '--file', divider], dividerRoot);
    const copied = readFileSync(join(dividerRoot, '.fyi', 'scripts', 'divider.sh'), 'utf8');
    check(
      'a section divider is not treated as metadata',
      copied.includes('My Section Header'),
      copied.slice(0, 200),
    );
    check('the divider script keeps its second section', copied.includes('Another section'));
  } finally {
    rmSync(dividerRoot, { recursive: true, force: true });
  }

  // --- pnpm patterns with comments -------------------------------------
  const pnpmRoot = mkdtempSync(join(tmpdir(), 'fyi-pnpm-'));
  try {
    mkdirSync(join(pnpmRoot, 'custom', 'thing'), { recursive: true });
    writeFileSync(join(pnpmRoot, 'custom', 'thing', 'package.json'), JSON.stringify({ name: 'thing' }));
    writeFileSync(
      join(pnpmRoot, 'pnpm-workspace.yaml'),
      "packages:\n  - 'custom/*' # a comment\n",
    );
    const pnpm = jsonOf(run(['init', '--dry-run', '--include-packages', '--json'], pnpmRoot));
    check(
      'a pnpm pattern with a trailing comment is detected',
      (pnpm?.apps || []).some((app) => app.name === 'thing'),
      JSON.stringify(pnpm?.apps),
    );
  } finally {
    rmSync(pnpmRoot, { recursive: true, force: true });
  }

  // --- limit format -----------------------------------------------------
  check('--limit 1e3 is rejected', run(['find', 'x', '--limit', '1e3'], root).status !== 0);
  check('--limit 0x10 is rejected', run(['find', 'x', '--limit', '0x10'], root).status !== 0);

  // --- install recursion guard ------------------------------------------
  const installRoot = mkdtempSync(join(tmpdir(), 'fyi-install-'));
  try {
    const inside = join(SKILL_DIR, '..', 'fyi-install-probe');
    const probe = run(['install', inside], root);
    check('install into the skill source tree is refused', probe.status !== 0);
    check(
      'the skill source tree is intact after a refused install',
      existsSync(join(SKILL_DIR, 'SKILL.md')),
    );
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }

  // --- partial store ----------------------------------------------------
  const partialRoot = mkdtempSync(join(tmpdir(), 'fyi-partial-'));
  try {
    mkdirSync(join(partialRoot, '.fyi', 'patterns'), { recursive: true });
    const repaired = run(['init'], partialRoot);
    check('init repairs a partial store', repaired.status === 0, repaired.stderr);
    check(
      'partial store gets config',
      existsSync(join(partialRoot, '.fyi', 'config.json')),
    );
    rmSync(join(partialRoot, '.fyi', 'patterns'), { recursive: true, force: true });
    const repairedDirs = run(['init'], partialRoot);
    check('init repairs missing directories', repairedDirs.status === 0, repairedDirs.stderr);
    check(
      'missing directories are recreated',
      existsSync(join(partialRoot, '.fyi', 'patterns')),
    );
  } finally {
    rmSync(partialRoot, { recursive: true, force: true });
  }

  // --- unsafe config app name ------------------------------------------
  const configRoot = mkdtempSync(join(tmpdir(), 'fyi-config-'));
  try {
    run(['init'], configRoot);
    const cfgPath = join(configRoot, '.fyi', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.apps = [{ name: '../../escape', path: 'x', kind: 'app', description: '', owner: '' }];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const refreshUnsafe = run(['init', '--refresh'], configRoot);
    check('unsafe config app name is handled', refreshUnsafe.status === 0, refreshUnsafe.stderr);
    check(
      'unsafe config app name does not seed outside the store',
      !existsSync(join(configRoot, '..', 'escape', 'overview.md')),
    );
    const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
    check(
      'unsafe config app name is removed from config',
      !after.apps.some((app) => app.name.includes('..')),
    );
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }

  // --- generated-file symlink ------------------------------------------
  const symRoot = mkdtempSync(join(tmpdir(), 'fyi-sym-'));
  try {
    run(['init'], symRoot);
    const outside = join(symRoot, 'outside-index.json');
    const link = join(symRoot, '.fyi', 'INDEX.md');
    rmSync(link, { force: true });
    symlinkSync(outside, link);
    const symRun = run(['index'], symRoot);
    check('index refuses to write through a symlink', symRun.status !== 0, symRun.stderr);
    check('index does not create the outside target', !existsSync(outside));
  } finally {
    rmSync(symRoot, { recursive: true, force: true });
  }

  // --- monorepo detection ----------------------------------------------
  const monoRoot = mkdtempSync(join(tmpdir(), 'fyi-mono-'));
  try {
    mkdirSync(join(monoRoot, 'apps', 'api'), { recursive: true });
    mkdirSync(join(monoRoot, 'services', 'billing'), { recursive: true });
    mkdirSync(join(monoRoot, 'packages', 'web'), { recursive: true });
    writeFileSync(join(monoRoot, 'package.json'), JSON.stringify({ name: 'm', workspaces: ['apps/*'] }));
    writeFileSync(join(monoRoot, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
    writeFileSync(
      join(monoRoot, 'services', 'billing', 'package.json'),
      JSON.stringify({ name: 'billing' }),
    );
    writeFileSync(join(monoRoot, 'packages', 'web', 'package.json'), JSON.stringify({ name: 'web' }));
    const mono = jsonOf(run(['init', '--dry-run', '--include-packages', '--json'], monoRoot));
    const monoApps = mono?.apps || [];
    const names = monoApps.map((app) => app.name);
    check(
      'standard dirs are scanned alongside workspaces',
      names.includes('api') && names.includes('billing'),
      JSON.stringify(names),
    );
    const packageWeb = monoApps.find((app) => app.path === 'packages/web');
    check(
      'packages/ is classified as a package',
      packageWeb?.kind === 'package',
      JSON.stringify(packageWeb),
    );
  } finally {
    rmSync(monoRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (existsSync(repoStore)) {
  const after = readdirSync(repoStore, { recursive: true }).sort().join('\n');
  check('the real repository store is untouched', after === repoSnapshot);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
