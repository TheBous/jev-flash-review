// Diff parsing: splits a raw unified diff into review chunks inside the request
// budget. Each review unit is one file plus its direct neighbors — changed
// files it imports or that import it, and its test/source pair — so a rule
// judging a contract sees both sides. Units are duplicated per relationship
// and the worst-across-chunks merge in the engine makes duplicates safe.
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

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** A contiguous per-file slice of the diff (header + hunks). */
interface FileUnit {
  path: string;
  text: string;
}

export function chunkDiff(diff: string): string[] {
  if (diff.length <= CHUNK_CHARS) return [diff];
  return packUnits(egoUnits(splitFileUnits(diff)));
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

// ponytail: imports are extracted from changed lines with a regex and matched
// by path suffix — a heuristic for grouping, not a resolver. Aliased imports
// only match by suffix; exotic module systems simply don't couple.
function importSpecs(unit: FileUnit): string[] {
  const specs: string[] = [];
  for (const line of unit.text.split('\n')) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    for (const m of line.matchAll(/(?:from|require\(|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec) continue;
      if (
        spec.startsWith('./') ||
        spec.startsWith('../') ||
        spec.startsWith('@/') ||
        spec.startsWith('~/')
      ) {
        specs.push(spec);
      }
    }
  }
  return specs;
}

/** Resolves a relative/alias import specifier to a repo path (extensionless). */
function resolveSpec(spec: string, fromDir: string): string {
  if (spec.startsWith('@/') || spec.startsWith('~/')) return spec.slice(2);
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function matchesPath(candidate: string, filePath: string): boolean {
  const variants = [candidate];
  for (const ext of EXTENSIONS) variants.push(candidate + ext, `${candidate}/index${ext}`);
  return variants.some((v) => filePath === v || filePath.endsWith(`/${v}`));
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

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

// ponytail: one-hop adjacency, neighbors capped — a hub imported everywhere
// would otherwise be duplicated into every dependent unit. Raise NEIGHBOR_CAP
// if cross-file findings seem to miss context.
const NEIGHBOR_CAP = 2;

function egoUnits(units: FileUnit[]): FileUnit[][] {
  const specs = units.map((u) => (u.path ? importSpecs(u) : []));
  const dirs = units.map((u) => dirOf(u.path));
  const neighbors = (i: number, j: number): boolean => {
    const a = units[i];
    const b = units[j];
    const sa = specs[i];
    const sb = specs[j];
    const da = dirs[i];
    const db = dirs[j];
    if (i === j || !a || !b || !sa || !sb || !da || !db || !a.path || !b.path) return false;
    if (testPaired(a.path, b.path)) return true;
    return (
      sa.some((spec) => matchesPath(resolveSpec(spec, da), b.path)) ||
      sb.some((spec) => matchesPath(resolveSpec(spec, db), a.path))
    );
  };
  const used = new Map<FileUnit, number>();
  return units.map((center, i) => {
    const group = [center];
    for (const [j, other] of units.entries()) {
      if (!neighbors(i, j)) continue;
      const n = used.get(other) ?? 0;
      if (n >= NEIGHBOR_CAP) continue;
      used.set(other, n + 1);
      group.push(other);
    }
    return group;
  });
}

/** Greedy packing under the budget; a file lands once per chunk. */
function packUnits(groups: FileUnit[][]): string[] {
  const chunks: string[] = [];
  let buf: FileUnit[] = [];
  let seen = new Set<FileUnit>();
  let size = 0;
  const expand = (u: FileUnit): FileUnit[] =>
    u.text.length > CHUNK_CHARS ? lineSplit(u.text).map((text) => ({ path: u.path, text })) : [u];
  for (const group of groups) {
    for (const unit of group) {
      for (const u of expand(unit)) {
        if (seen.has(u)) continue;
        seen.add(u);
        if (buf.length > 0 && size + u.text.length + 1 > CHUNK_CHARS) {
          chunks.push(buf.map((v) => v.text).join('\n'));
          buf = [];
          seen = new Set();
          size = 0;
        }
        buf.push(u);
        size += u.text.length + 1;
      }
    }
  }
  if (buf.length > 0) chunks.push(buf.map((v) => v.text).join('\n'));
  return chunks;
}

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
// loses its marker in one chunk; only oversized single files still line-split —
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
