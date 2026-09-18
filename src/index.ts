import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewOutput } from './engine.js';
import { loadRules, reviewDiff } from './engine.js';

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
  const violations = output.results.filter((result) => result.answer === 'NO');
  for (const severity of ['blocker', 'high', 'medium', 'low', 'info', 'advisory']) {
    const bucket = violations.filter((result) => result.severity === severity);
    if (bucket.length === 0) continue;
    lines.push('');
    lines.push(severity.toUpperCase());
    for (const result of bucket) {
      lines.push(`  - [${result.rule_id}] ${result.question}`);
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
      `${output.summary.no} no, ${output.summary.na} n/a`,
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

  console.error(`Fetching PR ${prRef}...`);
  const meta = JSON.parse(
    await gh(['pr', 'view', prRef, '--json', 'number,title,body,url']),
  ) as PrMeta;
  const diff = await gh(['pr', 'diff', prRef]);

  console.error('Evaluating rules with TypeSafe...');
  const config = await loadRules();
  const output = await reviewDiff(
    { diff, title: meta.title, description: meta.body ?? '' },
    config,
  );

  console.log(formatReport(output, meta));
  return output.results.some(
    (result) => result.answer === 'NO' && FAIL_SEVERITIES.has(result.severity),
  )
    ? 1
    : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
