import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateHunks, chunkDiff } from './diff.js';

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

// ~25k chars per file: two coupled files fit a chunk, three do not.
const bigFile = (path: string, spec?: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,0 +1,500 @@',
    ...(spec ? [`+import x from '${spec}';`] : []),
    ...Array.from({ length: 500 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`),
  ].join('\n');

function chunkOf(chunks: string[], path: string): string {
  const chunk = chunks.find((c) => c.includes(`b/${path}\n`));
  assert.ok(chunk, `expected a chunk containing ${path}`);
  return chunk;
}

test('chunkDiff reviews a file together with the file it imports', () => {
  // Order interleaves the pairs so naive in-order packing would pair a/c and b/d.
  const diff = [
    bigFile('src/a.ts', './b'),
    bigFile('src/c.ts', './d'),
    bigFile('src/b.ts'),
    bigFile('src/d.ts'),
  ].join('\n');
  const chunks = chunkDiff(diff);
  assert.ok(chunks.length >= 2);
  assert.equal(chunkOf(chunks, 'src/a.ts'), chunkOf(chunks, 'src/b.ts'));
  assert.equal(chunkOf(chunks, 'src/c.ts'), chunkOf(chunks, 'src/d.ts'));
});

test('chunkDiff keeps a test file with its source file', () => {
  const diff = [bigFile('src/foo.ts'), bigFile('src/other.ts'), bigFile('src/foo.test.ts')].join(
    '\n',
  );
  const chunks = chunkDiff(diff);
  assert.equal(chunkOf(chunks, 'src/foo.ts'), chunkOf(chunks, 'src/foo.test.ts'));
});

test('chunkDiff caps hub duplication across review units', () => {
  const dependents = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => bigFile(`src/${n}.ts`, './hub'));
  const diff = [...dependents, bigFile('src/hub.ts')].join('\n');
  const chunks = chunkDiff(diff);
  const hubChunks = chunks.filter((c) => c.includes('b/src/hub.ts\n')).length;
  assert.ok(hubChunks >= 2, 'hub must appear in its own unit and at least one dependent');
  assert.ok(hubChunks <= 1 + 2, `hub capped at own unit + 2 neighbors, found ${hubChunks}`);
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

test('chunkDiff ignores imports of files outside the diff', () => {
  const diff = [bigFile('src/a.ts', './missing'), bigFile('src/b.ts'), bigFile('src/c.ts')].join(
    '\n',
  );
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
