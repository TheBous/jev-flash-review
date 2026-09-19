export interface Hunk {
  id: string;
  file: string;
  start: string;
  count: string;
  lines: string[];
}

export interface AnnotatedChunk {
  text: string;
  hunks: Hunk[];
}

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
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      current = { id, file, start: match?.[1] ?? '?', count: match?.[2] ?? '?', lines: [] };
      hunks.push(current);
      out.push(`[${id}] ${line}`);
    } else {
      current?.lines.push(line);
      out.push(line);
    }
  }
  return { text: out.join('\n'), hunks };
}
