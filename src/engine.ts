// Engine orchestration: prepare, evaluate, locate evidence, rate, serialize.

import { prepareReview } from './engine/prepare.js';
import { evaluateRules } from './engine/step-1.js';
import { locateEvidence } from './engine/step-2.js';
import { adjudicateViolations } from './engine/step-3.js';
import type {
  Judge,
  Outcome,
  Result,
  ReviewError,
  ReviewInput,
  ReviewOutput,
  RuleConfig,
  RuleOutcome,
  TokenUsage,
} from './types.js';

export async function reviewDiff(
  input: ReviewInput,
  config: RuleConfig,
  judge: Judge,
): Promise<Result<ReviewOutput, ReviewError>> {
  const prepared = prepareReview(input, config);
  if (!prepared.ok) return prepared;

  const evaluated = await evaluateRules(prepared.value.states, config, judge);
  const rules = evaluated.outcomes;
  const usage = evaluated.usage;
  const questions = new Map(
    config.categories
      .flatMap((category) => category.rules)
      .map((rule) => [rule.rule_id, rule.question]),
  );
  sumUsage(
    usage,
    await locateEvidence(rules, questions, prepared.value.chunks, prepared.value.states, judge),
  );
  const adjudicated = await adjudicateViolations(rules, prepared.value.states, judge);
  sumUsage(usage, adjudicated.usage);

  const na = rules.filter((outcome) => outcome.answer === 'N/A').length;
  const yes = rules.length - adjudicated.violations.length - adjudicated.dropped - na;
  return {
    ok: true,
    value: {
      results: rules.map(toPublic),
      violations: adjudicated.violations.map(toPublic),
      summary: {
        total: rules.length,
        yes,
        no: adjudicated.violations.length,
        na,
        blockers: adjudicated.violations.filter((outcome) => outcome.severity === 'blocker').length,
        dropped: adjudicated.dropped,
      },
      chunks: prepared.value.chunks.length,
      usage,
    },
  };
}

function sumUsage(total: TokenUsage, usage: TokenUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

function toPublic({ worstChunkIndex, ...outcome }: Outcome): RuleOutcome {
  return outcome;
}
