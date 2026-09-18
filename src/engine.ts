// Review workflow: chunk the diff, ask the Judge port about every rule, merge
// the worst outcome per rule across chunks, then locate evidence for violations.
// No driver imports here — effects cross the Judge port.
import { annotateHunks, chunkDiff, type Hunk } from './diff.js';
import type {
  ChoiceSpec,
  EvidenceHit,
  Judge,
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
// evidence questions carry every hunk of the chunk as options (~25 tokens each);
// 8 × 60 hunks × 25t ≈ 12k on top of the chunk state stays inside the budget
const EVIDENCE_PER_CALL = 8;

const ANSWER_CRITERIA = {
  YES: 'Compliant: the PR satisfies the rule.',
  NO: 'Violation: the PR breaks the rule, supported by evidence in the diff.',
  'N/A': 'The rule does not apply to this change given the applicability condition.',
} as const;

const ABSENT =
  'The violation is not tied to one hunk: it is an absence (missing tests, docs, config, handling) or a PR-level issue.';

const EVIDENCE_INSTRUCTION =
  'Which `[hunk_*]` marker in `pr.diff` marks the primary evidence of this violation? Choose `absent` when the violation is not tied to a specific hunk.';

const ANSWER_RANK = { NO: 0, 'N/A': 1, YES: 2 } as const;
type AnswerLabel = keyof typeof ANSWER_RANK;

interface Outcome extends RuleOutcome {
  worstChunkIndex: number;
}

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
      worstChunkIndex: worstIndex,
    };
  });

  const usage = responses
    .flat()
    .map((r) => r.usage)
    .reduce(sumUsage, { inputTokens: 0, outputTokens: 0 });
  const evidenceUsage = await locateEvidence(outcomes, rules, chunks, states, judge);
  usage.inputTokens += evidenceUsage.inputTokens;
  usage.outputTokens += evidenceUsage.outputTokens;

  const violations = outcomes.filter((outcome) => outcome.answer === 'NO');
  const na = outcomes.filter((outcome) => outcome.answer === 'N/A').length;
  const yes = outcomes.length - violations.length - na;
  return {
    ok: true,
    value: {
      results: outcomes.map(({ worstChunkIndex, ...outcome }) => outcome),
      summary: {
        total: outcomes.length,
        yes,
        no: violations.length,
        na,
        blockers: violations.filter((outcome) => outcome.severity === 'blocker').length,
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

// Evidence pass: for each violation, one Choice over the hunks of its worst chunk
// ("select instead of generate" — the judge picks the location, code prints file:line).
async function locateEvidence(
  outcomes: Outcome[],
  rules: RuleConfig['categories'][number]['rules'],
  chunks: { hunks: Hunk[] }[],
  states: PrState[],
  judge: Judge,
): Promise<TokenUsage> {
  const violationByChunk = new Map<number, Outcome[]>();
  for (const outcome of outcomes.filter((outcome) => outcome.answer === 'NO')) {
    const list = violationByChunk.get(outcome.worstChunkIndex) ?? [];
    list.push(outcome);
    violationByChunk.set(outcome.worstChunkIndex, list);
  }

  const calls: { violations: Outcome[]; promise: ReturnType<Judge['ask']> }[] = [];
  for (const [chunkIndex, list] of violationByChunk) {
    const chunk = chunks[chunkIndex];
    const state = states[chunkIndex];
    if (!chunk || chunk.hunks.length === 0 || !state) continue;
    const options: Record<string, string> = Object.fromEntries(
      chunk.hunks.map((h) => [h.id, `${h.file}:${h.start} (${h.count} changed-line block)`]),
    );
    options.absent = ABSENT;
    for (let i = 0; i < list.length; i += EVIDENCE_PER_CALL) {
      const batch = list.slice(i, i + EVIDENCE_PER_CALL);
      calls.push({
        violations: batch,
        promise: judge.ask(
          state,
          Object.fromEntries(
            batch.map((violation) => [
              sanitize(violation.rule_id),
              {
                input: {
                  violation:
                    rules.find((rule) => rule.rule_id === violation.rule_id)?.question ?? '',
                  instruction: EVIDENCE_INSTRUCTION,
                },
                options,
              } satisfies ChoiceSpec,
            ]),
          ),
        ),
      });
    }
  }

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const { violations, promise } of calls) {
    const { answers, usage: callUsage } = await promise;
    usage.inputTokens += callUsage.inputTokens;
    usage.outputTokens += callUsage.outputTokens;
    for (const violation of violations) {
      violation.evidence = topEvidence(
        need(answers, sanitize(violation.rule_id)).probabilities,
        chunks[violation.worstChunkIndex]?.hunks ?? [],
      );
    }
  }
  return usage;
}

function topEvidence(probabilities: Record<string, number>, hunks: Hunk[]): EvidenceHit[] {
  return Object.entries(probabilities)
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
}
