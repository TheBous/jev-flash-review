// Step 1: ask Jev every rule for every prepared chunk and merge the answers.
import type {
  ChoiceSpec,
  Judge,
  Outcome,
  PrState,
  RuleConfig,
  RuleOutcome,
  TokenUsage,
} from '../types.js';
import { need, sanitize } from './shared.js';

const RULES_PER_CALL = 80;

// ponytail: fixed pool size limits provider pressure; tune if the provider
// supports more concurrent calls without rate-limit failures.
const JUDGE_CONCURRENCY = 1;

const ANSWER_CRITERIA = {
  YES: 'Compliant: the PR satisfies the rule.',
  NO: 'Violation: the PR breaks the rule, supported by evidence in the diff.',
  'N/A': 'The rule does not apply to this change given the applicability condition.',
} as const;

const ANSWER_RANK = { NO: 0, 'N/A': 1, YES: 2 } as const;
type AnswerLabel = keyof typeof ANSWER_RANK;

function rankOf(choice: string): number {
  return ANSWER_RANK[choice as AnswerLabel] ?? Number.POSITIVE_INFINITY;
}

export async function evaluateRules(
  states: PrState[],
  config: RuleConfig,
  judge: Judge,
): Promise<{ outcomes: Outcome[]; usage: TokenUsage }> {
  const rules = config.categories.flatMap((category) => category.rules);
  const batchCount = Math.ceil(rules.length / RULES_PER_CALL);
  const inBatch = (rule: (typeof rules)[number], batch: number): boolean =>
    Math.floor(rules.indexOf(rule) / RULES_PER_CALL) === batch;

  const questionsFor = (selected: typeof rules): Record<string, ChoiceSpec> =>
    Object.fromEntries(
      selected.map((rule) => [
        sanitize(rule.rule_id),
        {
          input: { question: rule.question, applies_if: rule.applies_if },
          options: ANSWER_CRITERIA,
        } satisfies ChoiceSpec,
      ]),
    );

  const responses = await pooled(states, JUDGE_CONCURRENCY, (state) =>
    Promise.all(
      Array.from({ length: batchCount }, (_, batch) =>
        judge.ask(state, questionsFor(rules.filter((rule) => inBatch(rule, batch)))),
      ),
    ),
  );

  const outcomes: Outcome[] = rules.map((rule, ruleIndex) => {
    const key = sanitize(rule.rule_id);
    const batch = Math.floor(ruleIndex / RULES_PER_CALL);
    const perChunk = responses.map((perBatch) => {
      const response = perBatch[batch];
      if (!response) throw new Error(`Missing batch ${batch} for rule ${rule.rule_id}`);
      return need(response.answers, key);
    });
    const chunkResults = perChunk.map((answer, chunkIndex) => ({
      chunkIndex,
      answer: answer.choice as RuleOutcome['answer'],
      probability: answer.probabilities[answer.choice] ?? 0,
      confidence: answer.confidence,
      evidence: [],
    }));

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
      severity: null,
      severityConfidence: null,
      answer: worst.choice as RuleOutcome['answer'],
      probability: worst.probabilities[worst.choice] ?? 0,
      confidence: worst.confidence,
      evidence: [],
      chunkResults,
      impact: null,
      impactConfidence: null,
      worstChunkIndex: worstIndex,
    };
  });

  const usage = responses
    .flat()
    .map((response) => response.usage)
    .reduce(sumUsage, { inputTokens: 0, outputTokens: 0 });
  return { outcomes, usage };
}

async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        const item = items.at(index);
        if (item === undefined) continue;
        out[index] = await fn(item);
      }
    }),
  );
  return out;
}

function sumUsage(total: TokenUsage, usage: TokenUsage): TokenUsage {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  return total;
}
