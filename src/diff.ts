// Diff parsing: chunks a raw unified diff within the request budget and marks
// hunks so the judge can point at evidence by id instead of generating text.
export interface Hunk {
  id: string;
  file: string;
  start: string;
  count: string;
}

export interface AnnotatedChunk {
  text: string;
  hunks: Hunk[];
}

// ~20k tokens worst case (code diffs tokenize at ~3 chars/token), leaving headroom
// inside the ~32k TypeSafe request budget shared with the questions
const CHUNK_CHARS = 60_000;

export function chunkDiff(diff: string): string[] {
  if (diff.length <= CHUNK_CHARS) return [diff];
  const chunks: string[] = [];
  let lines: string[] = [];
  let size = 0;
  for (const line of diff.split('\n')) {
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
// loses its marker in one chunk; upgrade to hunk-aware splitting if evidence gaps show up
export function annotateHunks(chunk: string): AnnotatedChunk {
  const out: string[] = [];
  const hunks: Hunk[] = [];
  let file = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = /^diff --git a\/(.+) b\/(.+)$/.exec(line)?.[2] ?? file;
    }
    if (line.startsWith('@@')) {
      const id = `hunk_${String(hunks.length + 1).padStart(3, '0')}`;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunks.push({ id, file, start: m?.[1] ?? '?', count: m?.[2] ?? '?' });
      out.push(`[${id}] ${line}`);
    } else {
      out.push(line);
    }
  }
  return { text: out.join('\n'), hunks };
}
