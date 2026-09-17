import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';

const run = promisify(execFile);

// ~20k tokens worst case (code diffs tokenize at ~3 chars/token), leaving headroom
// inside the ~32k TypeSafe request budget shared with the questions
const CHUNK_CHARS = 60_000;
// ~100 tokens per rule question; keep batches well inside the request budget
const RULES_PER_CALL = 80;
// exit code 1 severities
const FAIL_SEVERITIES = new Set(['blocker']);

interface Rule {
  rule_id: string;
  question: string;
  applies_if: string;
  severity: string;
}

interface RuleConfig {
  contract: { rules: string[] };
  categories: { name: string; rules: Rule[] }[];
}

interface PrMeta {
  number: number;
  title: string;
  body: string | null;
  url: string;
}

interface RuleResult {
  rule: Rule;
  answer: string;
  probability: number;
  confidence: number;
}

type PrState = {
  pr: { title: string; description: string; part: string; diff: string };
  answer_rules: string[];
};

const ANSWER_CRITERIA = {
  YES: 'Compliant: the PR satisfies the rule.',
  NO: 'Violation: the PR breaks the rule, supported by evidence in the diff.',
  'N/A': 'The rule does not apply to this change given the applicability condition.',
} as const;

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

function batchRules(rules: Rule[]): Map<Rule, number> {
  const batchOf = new Map<Rule, number>();
  rules.forEach((rule, index) => {
    batchOf.set(rule, Math.floor(index / RULES_PER_CALL));
  });
  return batchOf;
}

async function main(): Promise<number> {
  const prRef = process.argv[2];
  if (!prRef) {
    console.error('Usage: npm run review -- <pr-number-or-url>');
    return 2;
  }

  const config = JSON.parse(await readFile('rules.json', 'utf8')) as RuleConfig;
  const rules = config.categories.flatMap((category) => category.rules);
  if (rules.length === 0) {
    console.error('rules.json contains no rules');
    return 2;
  }

  console.error(`Fetching PR ${prRef}...`);
  const meta = JSON.parse(
    await gh(['pr', 'view', prRef, '--json', 'number,title,body,url']),
  ) as PrMeta;
  const diff = await gh(['pr', 'diff', prRef]);

  const chunks = chunkDiff(diff);
  const batchOf = batchRules(rules);
  const batchCount = Math.max(...Array.from(batchOf.values())) + 1;
  console.error(
    `Diff is ${diff.length.toLocaleString()} chars -> ${chunks.length} chunk(s); ` +
      `${rules.length} rules -> ${batchCount} batch(es) of ≤${RULES_PER_CALL}; ` +
      `${chunks.length * batchCount} TypeSafe call(s) in parallel`,
  );
  const states: PrState[] = chunks.map((chunk, i) => ({
    pr: {
      title: meta.title,
      description: meta.body ?? '',
      part: `${i + 1} of ${chunks.length}`,
      diff: chunk,
    },
    answer_rules: config.contract.rules,
  }));

  const client = new TypeSafeClient({ timeout: 60_000 });

  // One batched call per (chunk × rule batch); the answer contract travels in the state
  // once per call instead of being repeated in every question.
  console.error(`Evaluating ${rules.length} rules with TypeSafe...`);
  const makeQuestions = (batch: Rule[]) =>
    Object.fromEntries(
      batch.map((rule) => [
        sanitize(rule.rule_id),
        choice({ question: rule.question, applies_if: rule.applies_if }, ANSWER_CRITERIA),
      ]),
    );
  const responsesByChunk = await Promise.all(
    states.map((state) =>
      Promise.all(
        Array.from({ length: batchCount }, (_, batchIndex) =>
          client.systemOne({
            state,
            questions: makeQuestions(rules.filter((rule) => batchOf.get(rule) === batchIndex)),
          }),
        ),
      ),
    ),
  );

  // Merge across chunks: a rule takes its most severe outcome (NO beats N/A beats YES).
  const rank = { NO: 0, 'N/A': 1, YES: 2 } as const;
  const results: RuleResult[] = rules.map((rule) => {
    const key = sanitize(rule.rule_id);
    const batchIndex = batchOf.get(rule);
    if (batchIndex === undefined) throw new Error(`No batch assigned for rule ${rule.rule_id}`);
    const perChunk = responsesByChunk.map((responses) =>
      need(responses[batchIndex]?.answers ?? {}, key),
    );
    let worst = perChunk[0];
    if (!worst) throw new Error(`Missing answer for rule ${rule.rule_id}`);
    for (const answer of perChunk) {
      if (rank[answer.choice as keyof typeof rank] < rank[worst.choice as keyof typeof rank]) {
        worst = answer;
      }
    }
    return {
      rule,
      answer: worst.choice,
      probability: worst.probabilities[worst.choice] ?? 0,
      confidence: worst.confidence,
    };
  });

  const violations = results.filter((result) => result.answer === 'NO');
  const notApplicable = results.filter((result) => result.answer === 'N/A');

  const lines: string[] = [];
  lines.push(`PR #${meta.number} "${meta.title}" — ${meta.url}`);
  if (chunks.length > 1)
    lines.push(`(${chunks.length} diff chunks evaluated, worst outcome per rule wins)`);
  lines.push('');
  for (const result of results) {
    const mark = result.answer === 'YES' ? '✓' : result.answer === 'NO' ? '✗' : '–';
    lines.push(
      `  ${mark} ${result.rule.rule_id} [${result.rule.severity}] ${result.answer} ` +
        `(p ${result.probability.toFixed(2)}, conf ${result.confidence.toFixed(2)})`,
    );
  }
  for (const severity of ['blocker', 'high', 'medium', 'low', 'info', 'advisory']) {
    const bucket = violations.filter((result) => result.rule.severity === severity);
    if (bucket.length === 0) continue;
    lines.push('');
    lines.push(severity.toUpperCase());
    for (const result of bucket) {
      lines.push(`  - [${result.rule.rule_id}] ${result.rule.question}`);
    }
  }
  if (notApplicable.length > 0) {
    lines.push('');
    lines.push(`N/A: ${notApplicable.map((result) => result.rule.rule_id).join(', ')}`);
  }
  lines.push('');
  lines.push(
    `${results.length} rules checked: ${results.length - violations.length - notApplicable.length} yes, ` +
      `${violations.length} no, ${notApplicable.length} n/a`,
  );
  const inputTokens = responsesByChunk
    .flat()
    .reduce((sum, response) => sum + response.usage.input_tokens, 0);
  const outputTokens = responsesByChunk
    .flat()
    .reduce((sum, response) => sum + response.usage.output_tokens, 0);
  lines.push(`Usage: ${inputTokens} input / ${outputTokens} output tokens`);
  console.log(lines.join('\n'));

  return violations.some((result) => FAIL_SEVERITIES.has(result.rule.severity)) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
