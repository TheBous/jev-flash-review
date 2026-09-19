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
