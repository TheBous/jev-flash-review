import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';

const run = promisify(execFile);

const PASS_THRESHOLD = 0.5;
// ~20k tokens worst case (code diffs tokenize at ~3 chars/token), leaving headroom
// inside the ~32k TypeSafe request budget shared with the questions
const CHUNK_CHARS = 60_000;

interface Rule {
  id: string;
  check: string;
}

interface PrMeta {
  number: number;
  title: string;
  body: string | null;
  url: string;
}

interface RuleResult {
  rule: Rule;
  probability: number;
  passed: boolean;
  worstChunkIndex: number;
}

type PrState = {
  pr: { title: string; description: string; part: string; diff: string };
};

const severityQuestion = choice('How severe is this violation?', {
  must_fix: 'Blocking: bug, security issue, data loss, or the change breaks its stated intent.',
  recommended: 'Should be changed before merge, but the change still works.',
  minor: 'Nitpick: style, naming, docs, or an optional improvement.',
});

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function need<T>(map: Record<string, T>, key: string): T {
  const value = map[key];
  if (value === undefined) throw new Error(`Missing answer for question "${key}"`);
  return value;
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

function chunkDiff(diff: string): string[] {
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

async function main(): Promise<number> {
  const prRef = process.argv[2];
  if (!prRef) {
    console.error('Usage: npm run review -- <pr-number-or-url>');
    return 2;
  }

  const rules = JSON.parse(await readFile('rules.json', 'utf8')) as Rule[];
  if (!Array.isArray(rules) || rules.length === 0) {
    console.error('rules.json must be a non-empty array of { id, check }');
    return 2;
  }

  console.error(`Fetching PR ${prRef}...`);
  const meta = JSON.parse(
    await gh(['pr', 'view', prRef, '--json', 'number,title,body,url']),
  ) as PrMeta;
  const diff = await gh(['pr', 'diff', prRef]);

  const chunks = chunkDiff(diff);
  if (chunks.length > 1) {
    console.error(
      `Diff is ${diff.length.toLocaleString()} chars: split into ${chunks.length} chunks ` +
        `(≤${CHUNK_CHARS.toLocaleString()} chars each), one TypeSafe call per chunk`,
    );
  }
  const states: PrState[] = chunks.map((chunk, i) => ({
    pr: {
      title: meta.title,
      description: meta.body ?? '',
      part: `${i + 1} of ${chunks.length}`,
      diff: chunk,
    },
  }));

  const client = new TypeSafeClient({ timeout: 60_000 });

  // One batched call per chunk: one Noul per rule over the same chunk state.
  console.error(`Evaluating ${rules.length} rules on ${chunks.length} chunk(s) with TypeSafe...`);
  const questions = Object.fromEntries(
    rules.map((rule) => [
      sanitize(rule.id),
      noul(`Does \`pr\` (title, description, diff) pass this review check? Check: ${rule.check}`, {
        true: 'The PR satisfies the check.',
        false: 'The PR violates the check.',
      }),
    ]),
  );
  const responses = await Promise.all(
    states.map((state) => client.systemOne({ state, questions })),
  );

  // A rule passes only if it passes in every chunk: merge with the worst (min) probability.
  const results: RuleResult[] = rules.map((rule) => {
    const probabilities = responses.map(
      (response) => need(response.answers, sanitize(rule.id)).noul,
    );
    const probability = Math.min(...probabilities);
    return {
      rule,
      probability,
      passed: probability >= PASS_THRESHOLD,
      worstChunkIndex: probabilities.indexOf(probability),
    };
  });
  const failed = results.filter((result) => !result.passed);

  // Second batched call, only for failed rules, against the chunk where each rule scored worst.
  const severities: Record<string, string> = {};
  let inputTokens = responses.reduce((sum, response) => sum + response.usage.input_tokens, 0);
  let outputTokens = responses.reduce((sum, response) => sum + response.usage.output_tokens, 0);
  if (failed.length > 0) {
    console.error(`Categorizing ${failed.length} violations...`);
    const severityQuestions = Object.fromEntries(
      failed.map((result) => [
        sanitize(result.rule.id),
        choice(
          `The PR violates this review check: ${result.rule.check} How severe is the violation found in \`pr\`?`,
          severityQuestion.criteria,
        ),
      ]),
    );
    const sevResponses = await Promise.all(
      states.map((state) => client.systemOne({ state, questions: severityQuestions })),
    );
    for (const response of sevResponses) {
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
    }
    for (const result of failed) {
      const response = sevResponses[result.worstChunkIndex];
      if (!response)
        throw new Error(`Missing severity response for chunk ${result.worstChunkIndex}`);
      severities[result.rule.id] = need(response.answers, sanitize(result.rule.id)).choice;
    }
  }

  const lines: string[] = [];
  lines.push(`PR #${meta.number} "${meta.title}" — ${meta.url}`);
  if (chunks.length > 1)
    lines.push(`(${chunks.length} diff chunks evaluated, worst chunk per rule wins)`);
  lines.push('');
  for (const result of results) {
    const mark = result.passed ? '✓' : '✗';
    const tag = result.passed ? '' : ` → ${severities[result.rule.id]}`;
    lines.push(
      `  ${mark} ${result.rule.id} (pass probability ${result.probability.toFixed(2)})${tag}`,
    );
  }
  for (const bucket of ['must_fix', 'recommended', 'minor'] as const) {
    const inBucket = failed.filter((result) => severities[result.rule.id] === bucket);
    if (inBucket.length === 0) continue;
    lines.push('');
    lines.push(bucket.replace('_', ' ').toUpperCase());
    for (const result of inBucket) {
      lines.push(`  - [${result.rule.id}] ${result.rule.check}`);
    }
  }
  lines.push('');
  lines.push(
    `${results.length} rules checked, ${results.length - failed.length} passed, ${failed.length} failed`,
  );
  lines.push(`Usage: ${inputTokens} input / ${outputTokens} output tokens`);
  console.log(lines.join('\n'));

  return failed.some((result) => severities[result.rule.id] === 'must_fix') ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
