// Diff parsing: splits a raw unified diff into file-sized review chunks inside
// the request budget. Each chunk contains one changed file and, when present,
// its changed test file — never imported modules.
// Hunks are marked so the judge can point at evidence by id instead of
// generating text.
export interface Hunk {
  id: string;
  file: string;
  start: string;
  count: string;
  /** Body lines of the hunk (without the @@ header), for confirm quotes. */
  lines: string[];
}

export interface AnnotatedChunk {
  text: string;
  hunks: Hunk[];
}

// ~20k tokens worst case (code diffs tokenize at ~3 chars/token), leaving headroom
// inside the ~32k TypeSafe request budget shared with the questions
const CHUNK_CHARS = 60_000;

/** A contiguous per-file slice of the diff (header + hunks). */
interface FileUnit {
  path: string;
  text: string;
}

/** One chunk per file, pairing only its changed test file; oversized chunks are hunk-split. */
export function chunkPerFile(diff: string): string[] {
  return pairTestUnits(splitFileUnits(diff))
    .flatMap((unit) => expand(unit))
    .map((u) => u.text);
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
  const strip = (p: string) => p.replace(/\.[^.]+$/, '');
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

  // A paired source+test unit can be larger than the budget. Split its members
  // independently, but keep every resulting piece self-contained and never
  // mix it with an unrelated file.
  const members = splitFileUnits(unit.text);
  return members.flatMap((member) =>
    splitByHunks(member.text).map((text) => ({ path: member.path, text })),
  );
}

function splitByHunks(text: string): string[] {
  const lines = text.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) return lineSplit(text);

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
    if (current.length > 0 && size + hunkText.length + 1 > CHUNK_CHARS) {
      chunks.push([...header, ...current].join('\n'));
      current = [];
      size = header.join('\n').length + 1;
    }

    if (header.join('\n').length + hunkText.length + 1 <= CHUNK_CHARS) {
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
      if (body.length > 0 && bodySize + line.length + 1 > CHUNK_CHARS) {
        chunks.push([...header, hunkHeader, ...body].join('\n'));
        body = [];
        bodySize = header.join('\n').length + hunkHeader.length + 2;
      }
      body.push(line);
      bodySize += line.length + 1;
    }
    if (body.length > 0) {
      chunks.push([...header, hunkHeader, ...body].join('\n'));
    }
  }

  if (current.length > 0) chunks.push([...header, ...current].join('\n'));
  return chunks;
}

// Fallback for malformed or header-only diffs. Normal review diffs go through
// splitByHunks, which preserves the file and hunk headers on every piece.
function lineSplit(text: string): string[] {
  const chunks: string[] = [];
  let lines: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    if (size + line.length + 1 > CHUNK_CHARS && lines.length > 0) {
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

// ponytail: chunks are cut on line boundaries, so a hunk straddling a chunk edge
// loses its marker in one chunk; oversized file/test chunks still line-split —
// upgrade to hunk-aware splitting if evidence gaps show up
export function annotateHunks(chunk: string): AnnotatedChunk {
  const out: string[] = [];
  const hunks: Hunk[] = [];
  let file = '';
  let current: Hunk | null = null;
  for (const line of chunk.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = /^diff --git a\/(.+) b\/(.+)$/.exec(line)?.[2] ?? file;
      current = null;
    }
    if (line.startsWith('@@')) {
      const id = `hunk_${String(hunks.length + 1).padStart(3, '0')}`;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      current = { id, file, start: m?.[1] ?? '?', count: m?.[2] ?? '?', lines: [] };
      hunks.push(current);
      out.push(`[${id}] ${line}`);
    } else {
      current?.lines.push(line);
      out.push(line);
    }
  }
  return { text: out.join('\n'), hunks };
}
