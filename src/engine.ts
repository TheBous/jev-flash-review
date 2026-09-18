import { readFile } from 'node:fs/promises';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';

// ~20k tokens worst case (code diffs tokenize at ~3 chars/token), leaving headroom
// inside the ~32k TypeSafe request budget shared with the questions
const CHUNK_CHARS = 60_000;
// ~100 tokens per rule question; keep batches well inside the request budget
const RULES_PER_CALL = 80;
// evidence questions carry every hunk of the chunk as options (~25 tokens each);
// 8 × 60 hunks × 25t ≈ 12k on top of the chunk state stays inside the budget
const EVIDENCE_PER_CALL = 8;

export interface Rule {
  rule_id: string;
  question: string;
  applies_if: string;
  severity: string;
}

export interface RuleConfig {
  contract: { rules: string[] };
  categories: { name: string; rules: Rule[] }[];
}

interface Hunk {
  id: string;
  file: string;
  start: string;
  count: string;
}

export interface EvidenceHit {
  location: string;
  probability: number;
}

export interface RuleOutcome {
  rule_id: string;
  question: string;
  severity: string;
  answer: 'YES' | 'NO' | 'N/A';
  probability: number;
  confidence: number;
  evidence: EvidenceHit[];
}

export interface ReviewOutput {
  results: RuleOutcome[];
  summary: { total: number; yes: number; no: number; na: number; blockers: number };
  chunks: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ReviewInput {
  diff: string;
  title?: string;
  description?: string;
}

interface InternalResult extends RuleOutcome {
  worstChunkIndex: number;
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

const ABSENT =
  'The violation is not tied to one hunk: it is an absence (missing tests, docs, config, handling) or a PR-level issue.';

export async function loadRules(): Promise<RuleConfig> {
  const config = JSON.parse(
    await readFile(new URL('../rules.json', import.meta.url), 'utf8'),
  ) as RuleConfig;
  if (config.categories.flatMap((category) => category.rules).length === 0) {
    throw new Error('rules.json contains no rules');
  }
  return config;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function need<T>(map: Record<string, T>, key: string): T {
  const value = map[key];
  if (value === undefined) throw new Error(`Missing answer for question "${key}"`);
  return value;
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

// ponytail: chunks are cut on line boundaries, so a hunk straddling a chunk edge
// loses its marker in one chunk; upgrade to hunk-aware splitting if evidence gaps show up
function annotateHunks(chunk: string): { text: string; hunks: Hunk[] } {
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

function batchRules(rules: Rule[]): Map<Rule, number> {
  const batchOf = new Map<Rule, number>();
  rules.forEach((rule, index) => {
    batchOf.set(rule, Math.floor(index / RULES_PER_CALL));
  });
  return batchOf;
}

export async function reviewDiff(input: ReviewInput, config: RuleConfig): Promise<ReviewOutput> {
  const rules = config.categories.flatMap((category) => category.rules);
  const client = new TypeSafeClient({ timeout: 60_000 });

  const annotated = chunkDiff(input.diff).map((chunk) => annotateHunks(chunk));
  const batchOf = batchRules(rules);
  const batchCount = Math.max(...Array.from(batchOf.values())) + 1;

  const states: PrState[] = annotated.map(({ text }, i) => ({
    pr: {
      title: input.title ?? '',
      description: input.description ?? '',
      part: `${i + 1} of ${annotated.length}`,
      diff: text,
    },
    answer_rules: config.contract.rules,
  }));

  // One batched call per (chunk × rule batch); the answer contract travels in the state
  // once per call instead of being repeated in every question.
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
  const results: InternalResult[] = rules.map((rule) => {
    const key = sanitize(rule.rule_id);
    const batchIndex = batchOf.get(rule);
    if (batchIndex === undefined) throw new Error(`No batch assigned for rule ${rule.rule_id}`);
    const perChunk = responsesByChunk.map((responses) =>
      need(responses[batchIndex]?.answers ?? {}, key),
    );
    let worst = perChunk[0];
    if (!worst) throw new Error(`Missing answer for rule ${rule.rule_id}`);
    let worstIndex = 0;
    for (let i = 1; i < perChunk.length; i++) {
      const answer = perChunk[i];
      if (
        answer &&
        rank[answer.choice as keyof typeof rank] < rank[worst.choice as keyof typeof rank]
      ) {
        worst = answer;
        worstIndex = i;
      }
    }
    return {
      rule_id: rule.rule_id,
      question: rule.question,
      severity: rule.severity,
      answer: worst.choice as RuleOutcome['answer'],
      probability: worst.probabilities[worst.choice] ?? 0,
      confidence: worst.confidence,
      evidence: [],
      worstChunkIndex: worstIndex,
    };
  });

  // Evidence pass: for each violation, one Choice over the hunks of its worst chunk
  // ("select instead of generate" — the model picks the location, code prints file:line).
  let evidenceInputTokens = 0;
  let evidenceOutputTokens = 0;
  const violations = results.filter((result) => result.answer === 'NO');
  const violatedByChunk = new Map<number, InternalResult[]>();
  for (const violation of violations) {
    const list = violatedByChunk.get(violation.worstChunkIndex) ?? [];
    list.push(violation);
    violatedByChunk.set(violation.worstChunkIndex, list);
  }
  const evidenceCalls: Promise<void>[] = [];
  for (const [chunkIndex, list] of violatedByChunk) {
    const { hunks } = annotated[chunkIndex] as { hunks: Hunk[] };
    if (hunks.length === 0) continue;
    const hunkCriteria: Record<string, string> = Object.fromEntries(
      hunks.map((h) => [h.id, `${h.file}:${h.start} (${h.count} changed-line block)`]),
    );
    hunkCriteria.absent = ABSENT;
    for (let i = 0; i < list.length; i += EVIDENCE_PER_CALL) {
      const batch = list.slice(i, i + EVIDENCE_PER_CALL);
      evidenceCalls.push(
        client
          .systemOne({
            state: states[chunkIndex] as PrState,
            questions: Object.fromEntries(
              batch.map((violation) => [
                sanitize(violation.rule_id),
                choice(
                  {
                    violation:
                      rules.find((rule) => rule.rule_id === violation.rule_id)?.question ?? '',
                    instruction:
                      'Which `[hunk_*]` marker in `pr.diff` marks the primary evidence of this violation? Choose `absent` when the violation is not tied to a specific hunk.',
                  },
                  hunkCriteria,
                ),
              ]),
            ),
          })
          .then((response) => {
            evidenceInputTokens += response.usage.input_tokens;
            evidenceOutputTokens += response.usage.output_tokens;
            for (const violation of batch) {
              const answer = need(response.answers, sanitize(violation.rule_id));
              const top = Object.entries(answer.probabilities)
                .sort((a, b) => b[1] - a[1])
                .filter(([, p]) => p >= 0.05)
                .slice(0, 2)
                .map(([label, p]) => {
                  const hunk = hunks.find((h) => h.id === label);
                  return {
                    location: hunk
                      ? `${hunk.file}:${hunk.start} (+${hunk.count} lines)`
                      : 'absence / PR-level (not tied to a hunk)',
                    probability: p,
                  };
                });
              violation.evidence = top;
            }
          }),
      );
    }
  }
  await Promise.all(evidenceCalls);

  const allResponses = [...responsesByChunk.flat()];
  const inputTokens =
    allResponses.reduce((sum, response) => sum + response.usage.input_tokens, 0) +
    evidenceInputTokens;
  const outputTokens =
    allResponses.reduce((sum, response) => sum + response.usage.output_tokens, 0) +
    evidenceOutputTokens;

  const yes = results.filter((r) => r.answer === 'YES').length;
  const no = violations.length;
  const na = results.length - yes - no;
  return {
    results: results.map(({ worstChunkIndex, ...outcome }) => outcome),
    summary: {
      total: results.length,
      yes,
      no,
      na,
      blockers: violations.filter((r) => r.severity === 'blocker').length,
    },
    chunks: annotated.length,
    usage: { inputTokens, outputTokens },
  };
}
