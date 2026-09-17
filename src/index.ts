import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';

const run = promisify(execFile);

const PASS_THRESHOLD = 0.5;
const MAX_DIFF_CHARS = 120_000;

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
}

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

async function fetchPr(prRef: string): Promise<{ meta: PrMeta; diff: string }> {
  const meta = JSON.parse(
    await gh(['pr', 'view', prRef, '--json', 'number,title,body,url']),
  ) as PrMeta;
  let diff = await gh(['pr', 'diff', prRef]);
  // ponytail: hard truncate at ~30k tokens (TypeSafe request budget is ~32k including questions)
  if (diff.length > MAX_DIFF_CHARS) {
    console.error(
      `WARNING: diff is ${diff.length.toLocaleString()} chars, over the TypeSafe request budget (~${MAX_DIFF_CHARS.toLocaleString()}). ` +
        'Truncating: rules will be evaluated on the first part of the diff only. ' +
        'Split the diff into chunks across multiple calls if you need full coverage.',
    );
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated]`;
  }
  return { meta, diff };
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
  const { meta, diff } = await fetchPr(prRef);
  const state = { pr: { title: meta.title, description: meta.body ?? '', diff } };

  const client = new TypeSafeClient({ timeout: 60_000 });

  // One batched call: one Noul per rule over the same state (parallel, ~12x cheaper than one call per rule).
  console.error(`Evaluating ${rules.length} rules with TypeSafe...`);
  const checks = await client.systemOne({
    state,
    questions: Object.fromEntries(
      rules.map((rule) => [
        sanitize(rule.id),
        noul(
          `Does \`pr\` (title, description, diff) pass this review check? Check: ${rule.check}`,
          {
            true: 'The PR satisfies the check.',
            false: 'The PR violates the check.',
          },
        ),
      ]),
    ),
  });

  const results: RuleResult[] = rules.map((rule) => {
    const probability = need(checks.answers, sanitize(rule.id)).noul;
    return { rule, probability, passed: probability >= PASS_THRESHOLD };
  });
  const failed = results.filter((result) => !result.passed);

  // Second batched call, only for failed rules: severity depends on which checks failed.
  const severities: Record<string, string> = {};
  let inputTokens = checks.usage.input_tokens;
  let outputTokens = checks.usage.output_tokens;
  if (failed.length > 0) {
    console.error(`Categorizing ${failed.length} violations...`);
    const sev = await client.systemOne({
      state,
      questions: Object.fromEntries(
        failed.map((result) => [
          sanitize(result.rule.id),
          choice(
            `The PR violates this review check: ${result.rule.check} How severe is the violation found in \`pr\`?`,
            severityQuestion.criteria,
          ),
        ]),
      ),
    });
    inputTokens += sev.usage.input_tokens;
    outputTokens += sev.usage.output_tokens;
    for (const result of failed) {
      severities[result.rule.id] = need(sev.answers, sanitize(result.rule.id)).choice;
    }
  }

  const lines: string[] = [];
  lines.push(`PR #${meta.number} "${meta.title}" — ${meta.url}`);
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
