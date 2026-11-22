#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  KNOWN_FLAGS,
  VERSION,
  color,
  fail,
  findProjectRoot,
  normalizeRoot,
  parseArgs,
  print,
} from './lib/util.mjs';
import { SCRIPT_EXTS } from './lib/store.mjs';

const ALIASES = {
  new: 'new',
  save: 'new',
  add: 'new',
  capture: 'new',
  find: 'find',
  search: 'find',
  list: 'list',
  ls: 'list',
  show: 'show',
  cat: 'show',
  index: 'index',
  organize: 'organize',
  tidy: 'organize',
  lint: 'organize',
  doctor: 'doctor',
  check: 'doctor',
  init: 'init',
  context: 'context',
  install: 'install',
  hook: 'hook',
  hooks: 'hook',
  help: 'help',
  version: 'version',
};

const USAGE = `fyi — project memory for multi-app repos

Usage:
  fyi <command> [arguments] [flags]

Commands:
  context                 Print store state and session directives (run first)
  init [--refresh]        Detect apps and create or repair .fyi/
  new <type> <title>      Capture an artifact (aliases: save, add, capture)
  find <query>            Search the store (alias: search)
  list                    Catalog artifacts (alias: ls)
  show <id|path|title>    Print one artifact
  index                   Rebuild index.json and INDEX.md
  organize [--fix]        Report duplicates, stale files, and layout issues
  doctor                  Health check; exits 1 on errors
  hook <action>           Manage or run hooks for Claude Code, Codex, and OpenCode
  install <target>        Copy skill (and optional --hooks) into another repo
  help                    Show this help
  version                 Print the skill version

Types:
  pattern   Reusable investigation recipe: log search, trace, repro
  knowledge Durable business or architecture fact
  runbook   Operational procedure: deploy, rollback, incident
  doc       Durable document or pointer to one
  script    Runnable helper with metadata and usage notes

Flags:
  --root <dir>        Project root (default: nearest store, Git root, or local skill)
  --app <name>        Scope to one or more apps (repeat or comma-separate)
  --tag <tag>         Filter or tag (repeat or comma-separate)
  --type <type>       Filter by type
  --status <s>        Filter or set status: active, draft, stale, deprecated
  --owner <name>      Filter or set owner
  --description <s>   One-line description (new)
  --title <s>         Title override (new)
  --file <path>       Copy a script source (new script)
  --ext <ext>         Script extension: ${SCRIPT_EXTS.join(', ')}
  --related <id>      Related artifact id (new; repeat)
  --agents <list>     Target agents: claude, codex, opencode, all (install, hook)
  --hooks             Install lifecycle hooks for selected agents (install)
  --host <name>       Hook host protocol: claude, codex, opencode, plain (hook run)
  --dry-run           Validate and print the plan without writing
  --refresh           Re-detect apps on init; prunes apps that disappeared
  --include-packages  Include packages as well as apps on init
  --fix               Apply safe repairs on organize
  --force             Replace an existing skill or plugin (install, hook)
  --init              Initialize the target store after install
  --json              Machine-readable output
  --limit <n>         Maximum results (find, list)
  --include-archived  Include archived artifacts

Examples:
  fyi init
  fyi install /path/to/repo --agents all --hooks --init
  fyi hook install --agents claude,codex,opencode
  fyi hook status
  fyi new pattern "Trace a request across services" --app api --tag logs,tracing
  fyi new script "Dump slow queries" --file ./dump-slow.mjs --app db
  fyi find "request id logs" --app api
  fyi organize --fix
  fyi doctor

Store:
  .fyi/knowledge/  .fyi/patterns/  .fyi/runbooks/  .fyi/docs/  .fyi/scripts/

If no fyi executable is on PATH, run:
  node .claude/skills/fyi/scripts/fyi.mjs <command>
`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgs(argv);
  for (const key of Object.keys(flags)) {
    if (!KNOWN_FLAGS.has(key)) return fail(`unknown flag --${key}`);
  }

  let command = positionals.shift();
  if (!command) command = flags.version ? 'version' : 'help';
  const verb = ALIASES[command];

  if (!verb) {
    print(color('31', `fyi: unknown command "${command}"`));
    print(USAGE);
    return 1;
  }

  if (verb === 'help') {
    print(USAGE);
    return 0;
  }

  if (verb === 'version') {
    print(`fyi skill ${VERSION}`);
    return 0;
  }

  const rootFlag = flags.root;
  if (rootFlag === true) return fail('--root requires a directory');
  const start = rootFlag ? normalizeRoot(rootFlag) : findProjectRoot(process.cwd());
  const ctx = {
    root: resolve(start),
    flags,
    positionals,
    json: Boolean(flags.json),
  };

  try {
    const module = await import(`./commands/${verb}.mjs`);
    return (await module.run(ctx)) ?? 0;
  } catch (error) {
    return fail(error?.message || String(error));
  }
}

process.exitCode = await main();
