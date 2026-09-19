import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTypeScriptRepository } from './analysis/typescript.js';

const DIFF = [
  'diff --git a/src/api.ts b/src/api.ts',
  '--- a/src/api.ts',
  '+++ b/src/api.ts',
  '@@ -1,5 +1,6 @@',
  ' export function load(): string {',
  '+  return helper();',
  ' }',
  ' ',
  ' export function helper(): string {',
  '   return "ok";',
  ' }',
].join('\n');

test('maps changed TypeScript lines to the smallest enclosing exported symbol', () => {
  const analysis = analyzeTypeScriptRepository({
    diff: DIFF,
    headFiles: {
      'src/api.ts': [
        'export function load(): string {',
        '  return helper();',
        '}',
        '',
        'export function helper(): string {',
        '  return "ok";',
        '}',
      ].join('\n'),
    },
    baseFiles: {
      'src/api.ts': [
        'export function load(): string {',
        '}',
        '',
        'export function helper(): string {',
        '  return "ok";',
        '}',
      ].join('\n'),
    },
    rootDir: '/repo',
  });

  assert.equal(analysis.uncoveredLines.length, 0);
  assert.deepEqual(
    analysis.changedSymbols.map(({ side, symbolId, exported }) => ({
      side,
      name: analysis.symbols.find((symbol) => symbol.id === symbolId)?.name,
      exported,
    })),
    [{ side: 'head', name: 'load', exported: true }],
  );
  assert.equal(analysis.changedSymbols[0]?.publicContractChanged, false);
});

test('detects a changed exported contract by comparing base and head', () => {
  const analysis = analyzeTypeScriptRepository({
    diff: [
      'diff --git a/src/api.ts b/src/api.ts',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,1 +1,1 @@',
      '-export function load(): string { return "ok"; }',
      '+export function load(): number { return 1; }',
    ].join('\n'),
    baseFiles: { 'src/api.ts': 'export function load(): string { return "ok"; }' },
    headFiles: { 'src/api.ts': 'export function load(): number { return 1; }' },
    rootDir: '/repo',
  });

  assert.equal(analysis.changedSymbols[0]?.publicContractChanged, true);
});

test('resolves local calls and records semantic graph edges', () => {
  const analysis = analyzeTypeScriptRepository({
    diff: DIFF,
    headFiles: {
      'src/api.ts': [
        'export function load(): string {',
        '  return helper();',
        '}',
        '',
        'export function helper(): string {',
        '  return "ok";',
        '}',
      ].join('\n'),
    },
    rootDir: '/repo',
  });

  assert.ok(analysis.calls.some((call) => call.expression === 'helper' && call.resolved));
  assert.ok(analysis.edges.some((edge) => edge.type === 'CALLS'));
  assert.ok(analysis.edges.filter((edge) => edge.type === 'EXPORTS').length >= 2);
});

test('keeps non-TypeScript changes visible as uncovered lines', () => {
  const analysis = analyzeTypeScriptRepository({
    diff: [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,1 +1,2 @@',
      ' title',
      '+details',
    ].join('\n'),
    headFiles: { 'README.md': 'title\ndetails' },
    rootDir: '/repo',
  });

  assert.equal(analysis.changedLines.length, 1);
  assert.equal(analysis.uncoveredLines.length, 1);
  assert.equal(analysis.uncoveredLines[0]?.file, 'README.md');
});

test('resolves imports between supplied repository files', () => {
  const analysis = analyzeTypeScriptRepository({
    diff: [
      'diff --git a/src/main.ts b/src/main.ts',
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '@@ -1,1 +1,2 @@',
      '+import { helper } from "./helper.js";',
    ].join('\n'),
    headFiles: {
      'src/main.ts': 'import { helper } from "./helper.js";\nexport const run = () => helper();',
      'src/helper.ts': 'export function helper(): string { return "ok"; }',
    },
    rootDir: '/repo',
  });

  assert.ok(analysis.edges.some((edge) => edge.type === 'IMPORTS'));
});

test('reports compiler diagnostics for supplied files', () => {
  const analysis = analyzeTypeScriptRepository({
    diff: [
      'diff --git a/src/api.ts b/src/api.ts',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -0,0 +1,1 @@',
      '+export const value: string = 1;',
    ].join('\n'),
    headFiles: { 'src/api.ts': 'export const value: string = 1;' },
    rootDir: '/repo',
  });

  assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.code === 2322));
});

test('uses compiler options to include JavaScript files', () => {
  const analysis = analyzeTypeScriptRepository({
    diff: '',
    headFiles: { 'src/helper.js': 'export function helper() { return "ok"; }' },
    rootDir: '/repo',
    compilerOptions: { allowJs: true, checkJs: true },
  });

  assert.ok(analysis.symbols.some((symbol) => symbol.file === 'src/helper.js'));
});
