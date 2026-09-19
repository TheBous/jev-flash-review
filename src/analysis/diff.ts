import type { AnalysisSide } from './types.js';

interface FileChanges {
  file: string;
  addedLines: number[];
  deletedLines: number[];
}

export function parseChangedLines(diff: string): FileChanges[] {
  const changes = new Map<string, FileChanges>();
  let current: FileChanges | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      const file = match?.[2];
      current = file ? getOrCreate(changes, file) : undefined;
      inHunk = false;
      continue;
    }

    if (line.startsWith('+++ b/')) {
      current = getOrCreate(changes, line.slice('+++ b/'.length));
      continue;
    }

    if (line.startsWith('--- a/') && !current) {
      current = getOrCreate(changes, line.slice('--- a/'.length));
      continue;
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }

    if (!current || !inHunk || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+')) {
      current.addedLines.push(newLine++);
    } else if (line.startsWith('-')) {
      current.deletedLines.push(oldLine++);
    } else if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }

  return [...changes.values()];
}

export function sideLines(
  changes: FileChanges,
  side: AnalysisSide,
): { line: number; changeType: 'added' | 'deleted' }[] {
  const lines = side === 'head' ? changes.addedLines : changes.deletedLines;
  const changeType = side === 'head' ? 'added' : 'deleted';
  return lines.map((line) => ({ line, changeType }));
}

function getOrCreate(changes: Map<string, FileChanges>, file: string): FileChanges {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  const existing = changes.get(normalized);
  if (existing) return existing;
  const created = { file: normalized, addedLines: [], deletedLines: [] };
  changes.set(normalized, created);
  return created;
}
