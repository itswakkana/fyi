import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdown,
  parseScalar,
  parseScript,
  parseYaml,
  scriptFrontmatterIsSimple,
  stringifyMarkdown,
  stringifyYaml,
  upsertScriptFrontmatter,
} from './lib/frontmatter.mjs';

test('quoted scalars round-trip JSON escapes and literal escape sequences', () => {
  const values = [
    'literal \\n and \\t', 'literal \\n: quoted', 'backslash then "quote"', 'tab\tand\rcarriage',
    'line\nbreak', 'control \u0001', 'C:\\new\\folder', 'quote " and slash \\',
  ];
  for (const value of values) {
    assert.deepEqual(parseYaml(stringifyYaml({ title: value, tags: [value] })), {
      title: value, tags: [value],
    });
    assert.equal(parseMarkdown(stringifyMarkdown({ title: value }, 'body')).data.title, value);
  }
  assert.equal(parseScalar('"\\u263a\\t\\r\\/"'), '\u263a\t\r/');
  assert.equal(parseScalar("'it''s \\n'"), "it's \\n");
});

test('block-comment fenced script metadata is checked without its fences', () => {
  for (const source of [
    '/**\n * ---\n * type: script\n * title: Example\n * tags: [one, two]\n * ---\n */\nrun();\n',
    '#!/usr/bin/env node\r\n/*\r\n---\r\ntype: script\r\ntitle: Example\r\n---\r\n*/\r\nrun();\r\n',
  ]) {
    assert.equal(parseScript(source, '.js').hasFrontmatter, true);
    assert.equal(scriptFrontmatterIsSimple(source, '.js'), true);
    const result = upsertScriptFrontmatter(source, '.js', { type: 'script', title: 'Updated' });
    assert.equal(parseScript(result, '.js').data.title, 'Updated');
    assert.match(result, /run\(\);/);
  }
});

test('block-comment metadata with unsupported YAML remains unsafe', () => {
  for (const yaml of ['title: |\n *   multiline', 'title:\n *   nested: value']) {
    const source = `/**\n * ---\n * type: script\n * ${yaml}\n * ---\n */`;
    assert.equal(parseScript(source, '.js').hasFrontmatter, true);
    assert.equal(scriptFrontmatterIsSimple(source, '.js'), false);
  }
});
