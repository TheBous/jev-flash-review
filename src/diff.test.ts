import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateHunks, chunkDiff, chunkPerFile } from './diff.js';

const SMALL_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ fn',
  ' context',
  '-old line',
  '+new line',
].join('\n');

test('chunkDiff keeps a small diff as one chunk', () => {
  const chunks = chunkDiff(SMALL_DIFF);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], SMALL_DIFF);
});

test('chunkDiff splits large diffs without losing lines', () => {
  const big = Array.from({ length: 4_000 }, (_, i) => `context line ${i} ${'x'.repeat(20)}`).join(
    '\n',
  );
  const chunks = chunkDiff(big);
  assert.ok(chunks.length > 1, 'expected the diff to be split');
  assert.ok(chunks.every((chunk) => chunk.length <= 60_000 + 40));
  const totalLines = chunks.flatMap((chunk) => chunk.split('\n')).length;
  assert.equal(totalLines, 4_000);
});

test('annotateHunks numbers hunks and tracks the current file', () => {
  const { text, hunks } = annotateHunks(SMALL_DIFF);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    id: 'hunk_001',
    file: 'src/a.ts',
    start: '10',
    count: '4',
    lines: [' context', '-old line', '+new line'],
  });
  assert.ok(text.includes('[hunk_001] @@ -10,3 +10,4 @@ fn'));
});

test('annotateHunks survives a malformed hunk header', () => {
  const { hunks } = annotateHunks('@@ garbage');
  assert.deepEqual(hunks[0], { id: 'hunk_001', file: '', start: '?', count: '?', lines: [] });
});

// ~25k chars per file: two files fit a chunk, three do not.
const bigFile = (path: string, spec?: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,0 +1,500 @@',
    ...(spec ? [`+import x from '${spec}';`] : []),
    ...Array.from({ length: 500 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`),
  ].join('\n');

test('chunkDiff keeps every file whole: no duplication across chunks', () => {
  const diff = [
    bigFile('src/a.ts', './b'),
    bigFile('src/c.ts', './d'),
    bigFile('src/b.ts'),
    bigFile('src/d.ts'),
  ].join('\n');
  const chunks = chunkDiff(diff);
  const fileHeaders = chunks.reduce((sum, c) => sum + [...c.matchAll(/^diff --git /gm)].length, 0);
  assert.equal(fileHeaders, 4, 'every file appears exactly once');
});

test('chunkDiff packs unrelated files together', () => {
  const diff = [bigFile('src/a.ts'), bigFile('src/b.ts'), bigFile('src/c.ts')].join('\n');
  const chunks = chunkDiff(diff);
  assert.equal(chunks.length, 2);
  const paths = chunks.map((c) =>
    ['src/a.ts', 'src/b.ts', 'src/c.ts'].filter((p) => c.includes(`b/${p}\n`)),
  );
  assert.equal(paths.flat().length, 3, 'every file appears in exactly one chunk');
});

test('chunkDiff splits an oversized single file by lines', () => {
  const path = 'src/huge.ts';
  const lines = 2_000;
  const diff = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+line ${i} ${'x'.repeat(40)}`),
  ].join('\n');
  const chunks = chunkDiff(diff);
  assert.ok(chunks.length > 1, 'expected the file to be split');
  assert.ok(chunks.every((c) => c.length <= 60_000 + 40));
  const totalLines = chunks.flatMap((c) => c.split('\n')).length;
  assert.equal(totalLines, lines + 4);
});

test('chunkPerFile makes one chunk per file in diff order', () => {
  const diff = [bigFile('src/a.ts', './b'), bigFile('src/b.ts'), bigFile('src/c.ts')].join('\n');
  const chunks = chunkPerFile(diff);
  assert.equal(chunks.length, 3);
  ['src/a.ts', 'src/b.ts', 'src/c.ts'].forEach((p, i) => {
    const chunk = chunks.at(i);
    assert.ok(chunk, `missing chunk for ${p}`);
    assert.match(chunk, new RegExp(`^diff --git a/${p.replaceAll('.', '\\.')} b/`));
  });
});

test('chunkPerFile pairs only a changed file with its changed test', () => {
  const diff = [
    bigFile('src/service.ts', './repository'),
    bigFile('src/repository.ts'),
    bigFile('src/service.test.ts'),
  ].join('\n');
  const chunks = chunkPerFile(diff);
  assert.equal(chunks.length, 2);
  const serviceChunk = chunks.find((chunk) => chunk.includes('b/src/service.ts\n'));
  assert.ok(serviceChunk);
  assert.ok(serviceChunk.includes('b/src/service.test.ts\n'));
  assert.ok(!serviceChunk.includes('b/src/repository.ts\n'));
});

test('chunkPerFile splits an oversized file by lines', () => {
  const lines = 2_000;
  const diff = [
    'diff --git a/src/huge.ts b/src/huge.ts',
    '--- a/src/huge.ts',
    '+++ b/src/huge.ts',
    `@@ -1,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+line ${i} ${'x'.repeat(40)}`),
  ].join('\n');
  const chunks = chunkPerFile(diff);
  assert.ok(chunks.length > 1, 'the oversized file must be split');
  assert.ok(chunks.every((c) => c.length <= 60_000 + 40));
  assert.equal(chunks.flatMap((c) => c.split('\n')).length, lines + 4, 'no lines lost');
});
