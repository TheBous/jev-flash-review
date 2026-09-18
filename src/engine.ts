// Review workflow: chunk the diff, ask the Judge port about every rule, merge
// the worst outcome per rule across chunks, then hand violations to findings
// for evidence location and adjudication.
// No driver imports here — effects cross the Judge port.
import { adjudicateViolations } from './adjudicate.js';
import { annotateHunks, chunkDiff } from './diff.js';
import { locateEvidence } from './evidence.js';
import type {
  ChoiceSpec,
  Judge,
  Outcome,
  PrState,
  Result,
  ReviewError,
  ReviewInput,
  ReviewOutput,
  RuleConfig,
  RuleOutcome,
  TokenUsage,
} from './types.js';

// ~100 tokens per rule question; keep batches well inside the request budget
const RULES_PER_CALL = 80;

const ANSWER_CRITERIA = {
  YES: 'Compliant: the PR satisfies the rule.',
  NO: 'Violation: the PR breaks the rule, supported by evidence in the diff.',
  'N/A': 'The rule does not apply to this change given the applicability condition.',
} as const;

const ANSWER_RANK = { NO: 0, 'N/A': 1, YES: 2 } as const;
type AnswerLabel = keyof typeof ANSWER_RANK;

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Missing or malformed judge answers are a broken judge contract, not an expected error. */
function need<T>(map: Record<string, T>, key: string): T {
  const value = map[key];
  if (value === undefined) throw new Error(`Missing answer for question "${key}"`);
  return value;
}

function rankOf(choice: string): number {
  return ANSWER_RANK[choice as AnswerLabel] ?? Number.POSITIVE_INFINITY;
}

function buildStates(
  chunks: { text: string }[],
  input: ReviewInput,
  config: RuleConfig,
): PrState[] {
  return chunks.map(({ text }, i) => ({
    pr: {
      title: input.title ?? '',
      description: input.description ?? '',
      part: `${i + 1} of ${chunks.length}`,
      diff: text,
    },
    task_context: input.taskContext ?? '',
    answer_rules: config.contract.rules,
  }));
}

export async function reviewDiff(
  input: ReviewInput,
  config: RuleConfig,
  judge: Judge,
): Promise<Result<ReviewOutput, ReviewError>> {
  if (input.diff.trim().length === 0) return { ok: false, error: 'empty-diff' };
  const rules = config.categories.flatMap((category) => category.rules);
  const batchCount = Math.ceil(rules.length / RULES_PER_CALL);
  const inBatch = (rule: (typeof rules)[number], batch: number): boolean =>
    Math.floor(rules.indexOf(rule) / RULES_PER_CALL) === batch;

  const chunks = chunkDiff(input.diff).map((chunk) => annotateHunks(chunk));
  const states = buildStates(chunks, input, config);

  // One batched call per (chunk × rule batch); the answer contract travels in the
  // state once per call instead of being repeated in every question.
  const responses = await Promise.all(
    states.map((state) =>
      Promise.all(
        Array.from({ length: batchCount }, (_, batch) =>
          judge.ask(
            state,
            Object.fromEntries(
              rules
                .filter((rule) => inBatch(rule, batch))
                .map((rule) => [
                  sanitize(rule.rule_id),
                  {
                    input: { question: rule.question, applies_if: rule.applies_if },
                    options: ANSWER_CRITERIA,
                  } satisfies ChoiceSpec,
                ]),
            ),
          ),
        ),
      ),
    ),
  );

  // Merge across chunks: a rule takes its most severe outcome (NO beats N/A beats YES).
  const outcomes: Outcome[] = rules.map((rule, ruleIndex) => {
    const key = sanitize(rule.rule_id);
    const batch = Math.floor(ruleIndex / RULES_PER_CALL);
    const perChunk = responses.map((perBatch) => need(perBatch[batch]!.answers, key));
    let worst = perChunk[0];
    let worstIndex = 0;
    for (let i = 1; i < perChunk.length; i++) {
      const answer = perChunk[i];
      if (worst && answer && rankOf(answer.choice) < rankOf(worst.choice)) {
        worst = answer;
        worstIndex = i;
      }
    }
    if (!worst) throw new Error(`Missing answer for rule ${rule.rule_id}`);
    return {
      rule_id: rule.rule_id,
      question: rule.question,
      severity: rule.severity,
      answer: worst.choice as RuleOutcome['answer'],
      probability: worst.probabilities[worst.choice] ?? 0,
      confidence: worst.confidence,
      evidence: [],
      impact: null,
      impactConfidence: null,
      worstChunkIndex: worstIndex,
    };
  });

  const usage = responses
    .flat()
    .map((r) => r.usage)
    .reduce(sumUsage, { inputTokens: 0, outputTokens: 0 });
  const questions = new Map(rules.map((rule) => [rule.rule_id, rule.question]));
  const located = await locateEvidence(outcomes, questions, chunks, states, judge);
  sumUsage(usage, located);
  const adjudicated = await adjudicateViolations(outcomes, states, judge);
  sumUsage(usage, adjudicated.usage);

  const violations = adjudicated.violations;
  const na = outcomes.filter((outcome) => outcome.answer === 'N/A').length;
  const yes = outcomes.length - violations.length - adjudicated.dropped - na;
  return {
    ok: true,
    value: {
      results: outcomes.map(toPublic),
      violations: violations.map(toPublic),
      summary: {
        total: outcomes.length,
        yes,
        no: violations.length,
        na,
        blockers: violations.filter((outcome) => outcome.severity === 'blocker').length,
        dropped: adjudicated.dropped,
      },
      chunks: chunks.length,
      usage,
    },
  };
}

function sumUsage(total: TokenUsage, usage: TokenUsage): TokenUsage {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  return total;
}

function toPublic({ worstChunkIndex, ...outcome }: Outcome): RuleOutcome {
  return outcome;
}
