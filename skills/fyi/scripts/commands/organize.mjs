import { readFileSync, writeFileSync } from 'node:fs';
import { stampFrontmatterUpdated } from '../lib/frontmatter.mjs';
import {
  isInitialized,
  readConfig,
  rebuildIndex,
  SCRIPT_EXTS,
  storePath,
  walkArtifacts,
} from '../lib/store.mjs';
import { findNearDuplicates, validateStore } from '../lib/validate.mjs';
import { assertSafeStoreRoot, color, fail, print, toPosix } from '../lib/util.mjs';

export function run(ctx) {
  const { root, flags, json } = ctx;
  try {
    assertSafeStoreRoot(root, { allowMissing: false });
  } catch (error) {
    return fail(error.message);
  }
  if (!isInitialized(root)) return fail('store is not initialized; run `fyi init` first.');

  let artifacts = walkArtifacts(root);
  let config = readConfig(root);
  let report = validateStore(root, artifacts, config);
  let nearDuplicates = findNearDuplicates(artifacts);
  let missingUpdated = findMissingUpdated(artifacts);
  let unfrontmattered = artifacts.filter((artifact) => !artifact.archived && !artifact.hasFrontmatter);
  let stale = findStale(artifacts, report);

  const fix = Boolean(flags.fix);
  const applied = [];
  if (fix) {
    let stamped = false;
    for (const artifact of missingUpdated) {
      const changed = stampFrontmatterUpdated(
        artifact.abs,
        artifact.updated,
        readFileSync,
        writeFileSync,
      );
      if (changed) {
        stamped = true;
        applied.push(`stamped updated on ${artifact.path}`);
      }
    }
    if (stamped) artifacts = walkArtifacts(root);
    const { summary } = rebuildIndex(root, artifacts);
    applied.push(`rebuilt index (${summary.unarchived} unarchived)`);

    config = readConfig(root);
    report = validateStore(root, artifacts, config);
    nearDuplicates = findNearDuplicates(artifacts);
    missingUpdated = findMissingUpdated(artifacts);
    unfrontmattered = artifacts.filter((artifact) => !artifact.archived && !artifact.hasFrontmatter);
    stale = findStale(artifacts, report);
  }

  if (json) {
    print(
      JSON.stringify(
        {
          store: toPosix(storePath(root)),
          counts: { total: artifacts.length },
          errors: report.errors,
          warnings: report.warnings,
          nearDuplicates: nearDuplicates.map(({ a, b, similarity }) => ({
            a: a.path,
            b: b.path,
            similarity: Number(similarity.toFixed(2)),
          })),
          missingUpdated: missingUpdated.map((artifact) => artifact.path),
          unfrontmattered: unfrontmattered.map((artifact) => artifact.path),
          stale: stale.map((artifact) => artifact.path),
          applied,
        },
        null,
        2,
      ),
    );
    return report.errors.length ? 1 : 0;
  }

  print(color('1', `fyi organize · ${root}`));
  print(
    `${artifacts.length} artifacts · ${report.errors.length} errors · ${report.warnings.length} warnings`,
  );
  print('');

  if (nearDuplicates.length) {
    print(color('1', 'Near-duplicates'));
    for (const { a, b, similarity } of nearDuplicates.slice(0, 10)) {
      print(`  ${Math.round(similarity * 100)}%  ${a.path}`);
      print(`        ${b.path}`);
    }
    print('  Merge the pair, keep one canonical artifact, and link the other via `related`.');
    print('  App overviews are intentionally similar and are not reported here.');
    print('');
  }

  if (report.errors.length) {
    print(color('31', 'Errors'));
    for (const error of report.errors) print(`  ${error}`);
    print('');
  }

  if (report.warnings.length) {
    print(color('33', 'Warnings'));
    for (const warning of report.warnings.slice(0, 30)) print(`  ${warning}`);
    if (report.warnings.length > 30) print(`  … ${report.warnings.length - 30} more`);
    print('');
  }

  if (stale.length) {
    print(color('1', 'Stale'));
    for (const artifact of stale) print(`  ${artifact.path} · updated ${artifact.updated}`);
    print('  Refresh, mark `status: stale`, or move to .fyi/archive/.');
    print('');
  }

  if (unfrontmattered.length) {
    print(color('1', 'Missing frontmatter (not auto-fixable)'));
    for (const artifact of unfrontmattered) print(`  ${artifact.path}`);
    print('  Add type, title, description, apps, tags, status, updated, then run `fyi index`.');
    print('');
  }

  if (fix) {
    print(color('32', 'Applied'));
    for (const line of applied) print(`  ${line}`);
    print('');
  } else if (missingUpdated.length) {
    print('Safe fixes available: `fyi organize --fix`');
    print('');
  }

  print(
    'Semantic pass (agent): merge duplicates, split oversized artifacts, retag, move knowledge to app scope, archive deprecated. Never delete without asking.',
  );
  return report.errors.length ? 1 : 0;
}

function findMissingUpdated(artifacts) {
  return artifacts.filter(
    (artifact) =>
      !artifact.archived &&
      !SCRIPT_EXTS.includes(artifact.ext) &&
      artifact.hasFrontmatter &&
      !artifact.data.updated,
  );
}

function findStale(artifacts, report) {
  return artifacts.filter(
    (artifact) =>
      !artifact.archived &&
      artifact.status === 'active' &&
      report.warnings.some((warning) => warning.startsWith(`${artifact.path}: stale`)),
  );
}
