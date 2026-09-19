import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateHunks } from './engine/hunks.js';
import { chunkPerFile } from './engine/prepare.js';

const SMALL_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ fn',
  ' context',
  '-old line',
  '+new line',
].join('\n');

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

test('chunkPerFile keeps an oversized source paired with its test', () => {
  const hugeFile = (path: string) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,0 +1,1500 @@',
      ...Array.from({ length: 1500 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`),
    ].join('\n');
  const source = hugeFile('src/component.tsx');
  const testFile = hugeFile('src/component.test.tsx');
  const chunks = chunkPerFile([source, testFile].join('\n'));

  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every(
      (chunk) =>
        chunk.includes('b/src/component.tsx\n') && chunk.includes('b/src/component.test.tsx\n'),
    ),
  );
  assert.ok(chunks.every((chunk) => chunk.length <= 60_000));
});

test('chunkPerFile pairs jsx files with their test files', () => {
  const chunks = chunkPerFile(
    [bigFile('src/component.jsx'), bigFile('src/component.test.jsx')].join('\n'),
  );

  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]?.includes('b/src/component.jsx\n'));
  assert.ok(chunks[0]?.includes('b/src/component.test.jsx\n'));
});

test('chunkPerFile splits an oversized file into self-contained hunk chunks', () => {
  const path = 'src/huge.ts';
  const lines = 2_000;
  const diff = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+line ${i} ${'x'.repeat(40)}`),
  ].join('\n');
  const chunks = chunkPerFile(diff);
  assert.ok(chunks.length > 1, 'the oversized file must be split');
  assert.ok(chunks.every((c) => c.length <= 60_000 + 40));
  assert.ok(chunks.every((c) => c.includes(`diff --git a/${path} b/${path}`)));
  assert.ok(chunks.every((c) => c.includes('@@ -1,0 +1,2000 @@')));
  assert.equal(
    chunks.flatMap((c) => c.split('\n')).filter((line) => line.startsWith('+line ')).length,
    lines,
    'no diff lines lost',
  );
  assert.ok(
    chunks.every((c) => annotateHunks(c).hunks.every((hunk) => hunk.file === path)),
    'every split hunk keeps its file identity',
  );
});
