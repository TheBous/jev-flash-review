// Prepare the review input into bounded, self-contained chunks before Jev steps.

import type { PrState, Result, ReviewError, ReviewInput, RuleConfig } from '../types.js';
import { type AnnotatedChunk, annotateHunks } from './hunks.js';

const CHUNK_CHARS = 60_000;

interface FileUnit {
  path: string;
  text: string;
}

export interface PreparedReview {
  chunks: AnnotatedChunk[];
  states: PrState[];
}

export function prepareReview(
  input: ReviewInput,
  config: RuleConfig,
): Result<PreparedReview, ReviewError> {
  if (input.diff.trim().length === 0) return { ok: false, error: 'empty-diff' };
  const chunks = chunkPerFile(input.diff).map((chunk) => annotateHunks(chunk));
  const states = chunks.map(({ text }, index) => ({
    pr: {
      title: input.title ?? '',
      description: input.description ?? '',
      part: `${index + 1} of ${chunks.length}`,
      diff: text,
    },
    task_context: input.taskContext ?? '',
    answer_rules: config.contract.rules,
  }));
  return { ok: true, value: { chunks, states } };
}

/** One review unit per file, pairing only its changed test file. */
export function chunkPerFile(diff: string): string[] {
  return pairTestUnits(splitFileUnits(diff))
    .flatMap((unit) => expand(unit))
    .map((unit) => unit.text);
}

function splitFileUnits(diff: string): FileUnit[] {
  const units: FileUnit[] = [];
  let path = '';
  let lines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (lines.length > 0) units.push({ path, text: lines.join('\n') });
      path = /^diff --git a\/(.+) b\/(.+)$/.exec(line)?.[2] ?? '';
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  if (lines.length > 0) units.push({ path, text: lines.join('\n') });
  return units;
}

function pairTestUnits(units: FileUnit[]): FileUnit[] {
  // ponytail: O(n²) scan is enough for normal PR file counts; index test
  // basenames if very large PRs make pairing measurable.
  const used = new Set<FileUnit>();
  const groups: FileUnit[] = [];
  for (const unit of units) {
    if (used.has(unit)) continue;
    const pair = units.find(
      (candidate) => !used.has(candidate) && testPaired(unit.path, candidate.path),
    );
    if (!pair) {
      used.add(unit);
      groups.push(unit);
      continue;
    }
    used.add(unit);
    used.add(pair);
    const members = [unit, pair].sort((a, b) => units.indexOf(a) - units.indexOf(b));
    groups.push({ path: unit.path, text: members.map((member) => member.text).join('\n') });
  }
  return groups;
}

function testPaired(p1: string, p2: string): boolean {
  const strip = (path: string) => path.replace(/\.[^.]+$/, '');
  const b1 = strip(p1);
  const b2 = strip(p2);
  const [src, test] = b1.length <= b2.length ? [b1, b2] : [b2, b1];
  return (
    test === `${src}.test` ||
    test === `${src}.spec` ||
    test.startsWith(`${src}.test.`) ||
    test.startsWith(`${src}.spec.`)
  );
}

function expand(unit: FileUnit): FileUnit[] {
  if (unit.text.length <= CHUNK_CHARS) return [unit];

  const members = splitFileUnits(unit.text);
  const [sourceMember, testMember] = members;
  if (sourceMember && testMember && testPaired(sourceMember.path, testMember.path)) {
    const pairLimit = Math.floor(CHUNK_CHARS / 2);
    const sourceParts = splitByHunks(sourceMember.text, pairLimit);
    const testParts = splitByHunks(testMember.text, pairLimit);
    const count = Math.max(sourceParts.length, testParts.length);
    return Array.from({ length: count }, (_, index) => {
      const source = sourceParts[index] ?? sourceParts.at(-1) ?? '';
      const test = testParts[index] ?? testParts.at(-1) ?? '';
      return { path: sourceMember.path, text: `${source}\n${test}` };
    });
  }

  return members.flatMap((member) =>
    splitByHunks(member.text).map((text) => ({ path: member.path, text })),
  );
}

function splitByHunks(text: string, limit = CHUNK_CHARS): string[] {
  const lines = text.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) return lineSplit(text, limit);

  const header = lines.slice(0, firstHunk);
  const sections: string[][] = [];
  let section: string[] = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('@@') && section.length > 0) {
      sections.push(section);
      section = [];
    }
    section.push(line);
  }
  if (section.length > 0) sections.push(section);

  const chunks: string[] = [];
  let current: string[] = [];
  let size = header.join('\n').length + 1;
  for (const hunk of sections) {
    const hunkText = hunk.join('\n');
    if (current.length > 0 && size + hunkText.length + 1 > limit) {
      chunks.push([...header, ...current].join('\n'));
      current = [];
      size = header.join('\n').length + 1;
    }

    if (header.join('\n').length + hunkText.length + 1 <= limit) {
      current.push(...hunk);
      size += hunkText.length + 1;
      continue;
    }

    if (current.length > 0) {
      chunks.push([...header, ...current].join('\n'));
      current = [];
      size = header.join('\n').length + 1;
    }

    const hunkHeader = hunk[0] ?? '';
    let body: string[] = [];
    let bodySize = header.join('\n').length + hunkHeader.length + 2;
    for (const line of hunk.slice(1)) {
      if (body.length > 0 && bodySize + line.length + 1 > limit) {
        chunks.push([...header, hunkHeader, ...body].join('\n'));
        body = [];
        bodySize = header.join('\n').length + hunkHeader.length + 2;
      }
      body.push(line);
      bodySize += line.length + 1;
    }
    if (body.length > 0) chunks.push([...header, hunkHeader, ...body].join('\n'));
  }

  if (current.length > 0) chunks.push([...header, ...current].join('\n'));
  return chunks;
}

function lineSplit(text: string, limit = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let lines: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    if (size + line.length + 1 > limit && lines.length > 0) {
      chunks.push(lines.join('\n'));
      lines = [];
      size = 0;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length > 0) chunks.push(lines.join('\n'));
  return chunks;
}
