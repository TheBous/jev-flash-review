import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reviewDiff } from './engine.js';
import { TypeSafeJudge } from './judge.js';
import { loadRules } from './rules.js';
import type { Result, ReviewOutput } from './types.js';

const run = promisify(execFile);

// exit code 1 severities
const FAIL_SEVERITIES = new Set(['blocker']);

interface PrMeta {
  number: number;
  title: string;
  body: string | null;
  url: string;
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

function parsePrMeta(raw: unknown): Result<PrMeta, 'invalid-pr'> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid-pr' };
  const meta = raw as Record<string, unknown>;
  if (
    typeof meta.number !== 'number' ||
    typeof meta.title !== 'string' ||
    typeof meta.url !== 'string' ||
    (meta.body !== null && typeof meta.body !== 'string')
  ) {
    return { ok: false, error: 'invalid-pr' };
  }
  return {
    ok: true,
    value: {
      number: meta.number,
      title: meta.title,
      body: meta.body as string | null,
      url: meta.url,
    },
  };
}

function formatReport(output: ReviewOutput, meta: PrMeta): string {
  const lines: string[] = [];
  lines.push(`PR #${meta.number} "${meta.title}" — ${meta.url}`);
  if (output.chunks > 1)
    lines.push(`(${output.chunks} diff chunks evaluated, worst outcome per rule wins)`);
  lines.push('');
  for (const result of output.results) {
    const mark = result.answer === 'YES' ? '✓' : result.answer === 'NO' ? '✗' : '–';
    lines.push(
      `  ${mark} ${result.rule_id} [${result.severity}] ${result.answer} ` +
        `(p ${result.probability.toFixed(2)}, conf ${result.confidence.toFixed(2)})`,
    );
  }
  const violations = output.violations;
  for (const severity of ['blocker', 'high', 'medium', 'low', 'info', 'advisory']) {
    const bucket = violations.filter((result) => result.severity === severity);
    if (bucket.length === 0) continue;
    lines.push('');
    lines.push(severity.toUpperCase());
    for (const result of bucket) {
      lines.push(
        `  - [${result.rule_id}] ${result.question} (impact: ${result.impact ?? 'unrated'})`,
      );
      for (const e of result.evidence) {
        lines.push(`      ↳ ${e.location} (p ${e.probability.toFixed(2)})`);
      }
    }
  }
  const notApplicable = output.results.filter((result) => result.answer === 'N/A');
  if (notApplicable.length > 0) {
    lines.push('');
    lines.push(`N/A: ${notApplicable.map((result) => result.rule_id).join(', ')}`);
  }
  lines.push('');
  lines.push(
    `${output.summary.total} rules checked: ${output.summary.yes} yes, ` +
      `${output.summary.no} no, ${output.summary.na} n/a, ${output.summary.dropped} dropped (weak or unsupported evidence)`,
  );
  lines.push(
    `Usage: ${output.usage.inputTokens} input / ${output.usage.outputTokens} output tokens`,
  );
  return lines.join('\n');
}

async function main(): Promise<number> {
  const prRef = process.argv[2];
  if (!prRef) {
    console.error('Usage: npm run review -- <pr-number-or-url>');
    return 2;
  }
  const rules = await loadRules();
  if (!rules.ok) {
    console.error(`Cannot load rules: ${rules.error}`);
    return 2;
  }
  const meta = parsePrMeta(
    JSON.parse(await gh(['pr', 'view', prRef, '--json', 'number,title,body,url'])),
  );
  if (!meta.ok) {
    console.error(`Cannot parse PR metadata: ${meta.error}`);
    return 2;
  }
  const diff = await gh(['pr', 'diff', prRef]);
  const reviewed = await reviewDiff(
    { diff, title: meta.value.title, description: meta.value.body ?? '' },
    rules.value,
    new TypeSafeJudge(),
  );
  if (!reviewed.ok) {
    console.error(`Review failed: ${reviewed.error}`);
    return 2;
  }
  console.log(formatReport(reviewed.value, meta.value));
  return reviewed.value.violations.some((result) => FAIL_SEVERITIES.has(result.severity)) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
