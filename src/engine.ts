// Review workflow: chunk the diff, ask the Judge port about every rule, merge
// the worst outcome per rule across chunks, then hand violations to findings
// for evidence location and adjudication.
// No driver imports here — effects cross the Judge port.
import { adjudicateViolations } from './adjudicate.js';
import { annotateHunks, chunkPerFile, extraContext } from './diff.js';
import { locateEvidence } from './evidence.js';
import type {
  ChoiceSpec,
  Judge,
  JudgeAnswers,
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

// ponytail: fixed pool size; per-file chunking means ~4 calls per file, so a
// 100-file PR is ~400 requests — uncapped Promise.all would trip rate limits.
// Tune if the provider allows more.
const JUDGE_CONCURRENCY = 8;

/** Maps items through fn with at most `limit` calls in flight, preserving order. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        const item = items.at(i);
        if (item === undefined) continue;
        out[i] = await fn(item);
      }
    }),
  );
  return out;
}

// ponytail: judgments in this probability band get one re-ask with the related
// diff files appended (imports both ways, test pairs). Widen the band if
// cross-file findings seem to miss context; narrow it if usage grows.
const UNCERTAIN_LOW = 0.35;
const UNCERTAIN_HIGH = 0.65;

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

  const chunks = chunkPerFile(input.diff).map((chunk) => annotateHunks(chunk));
  const states = buildStates(chunks, input, config);

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

  // One batched call per (chunk × rule batch); the answer contract travels in the
  // state once per call instead of being repeated in every question.
  const responses = await pooled(states, JUDGE_CONCURRENCY, (state) =>
    Promise.all(
      Array.from({ length: batchCount }, (_, batch) =>
        judge.ask(state, questionsFor(rules.filter((rule) => inBatch(rule, batch)))),
      ),
    ),
  );

  // Pull pass: a borderline judgment is re-asked once with the related diff
  // files appended, so coupled rules are re-judged with both sides in view —
  // paid only where the first look was uncertain.
  const ruleIndexOf = new Map(rules.map((rule, i) => [sanitize(rule.rule_id), i]));
  const enrichments = await pooled(
    chunks.map((_, i) => i),
    JUDGE_CONCURRENCY,
    async (i) => {
      const chunk = chunks.at(i);
      if (!chunk) return null;
      const uncertain = rules.filter((rule, r) => {
        const response = responses[i]?.[Math.floor(r / RULES_PER_CALL)];
        const answer = response?.answers[sanitize(rule.rule_id)];
        if (!answer) return false;
        const p = answer.probabilities[answer.choice] ?? 0;
        return p > UNCERTAIN_LOW && p < UNCERTAIN_HIGH;
      });
      if (uncertain.length === 0) return null;
      const extra = extraContext(input.diff, chunk.text);
      if (!extra) return null;
      const base = states[i];
      if (!base) return null;
      const state: PrState = { ...base, pr: { ...base.pr, diff: `${chunk.text}\n${extra}` } };
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      const answers: JudgeAnswers = {};
      for (let off = 0; off < uncertain.length; off += RULES_PER_CALL) {
        const res = await judge.ask(
          state,
          questionsFor(uncertain.slice(off, off + RULES_PER_CALL)),
        );
        Object.assign(answers, res.answers);
        usage = sumUsage(usage, res.usage);
      }
      return { index: i, answers, usage };
    },
  );
  const enrichmentUsage = enrichments.reduce<TokenUsage>(
    (total, e) => (e ? sumUsage(total, e.usage) : total),
    { inputTokens: 0, outputTokens: 0 },
  );
  for (const e of enrichments) {
    if (!e) continue;
    for (const [key, answer] of Object.entries(e.answers)) {
      const ruleIndex = ruleIndexOf.get(key);
      const response =
        ruleIndex === undefined
          ? undefined
          : responses[e.index]?.[Math.floor(ruleIndex / RULES_PER_CALL)];
      if (response) response.answers[key] = answer;
    }
  }

  // ponytail: evidence still locates against the original chunk state, so a
  // violation whose support lives in the pulled context cannot point outside
  // the chunk and may be dropped at confirm (conservative false negative).
  // Upgrade path: rebuild the worst chunk's state with `extra` included, or
  // extend its evidence options with the extra files' hunks.

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
  sumUsage(usage, enrichmentUsage);
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
  // snippets are working material for the confirm pass, not public output
  return { ...outcome, evidence: outcome.evidence.map(({ snippet, ...hit }) => hit) };
}
