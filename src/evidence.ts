// Evidence location: one Choice per violation over the hunks of its worst
// chunk. Pure domain logic; effects cross the Judge port.

import type { Hunk } from './diff.js';
import type { ChoiceSpec, EvidenceHit, Judge, Outcome, PrState, TokenUsage } from './types.js';

// evidence questions carry every hunk of the chunk as options (~25 tokens each);
// 8 × 60 hunks × 25t ≈ 12k on top of the chunk state stays inside the budget
export const EVIDENCE_PER_CALL = 8;

const ABSENT =
  'The violation is not tied to one hunk: it is an absence (missing tests, docs, config, handling) or a PR-level issue.';

const EVIDENCE_INSTRUCTION =
  'Which `[hunk_*]` marker in `pr.diff` marks the primary evidence of this violation? Choose `absent` when the violation is not tied to a specific hunk.';

export function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Missing or malformed judge answers are a broken judge contract, not an expected error. */
export function need<T>(map: Record<string, T>, key: string): T {
  const value = map[key];
  if (value === undefined) throw new Error(`Missing answer for question "${key}"`);
  return value;
}

export function groupByChunk(violations: Outcome[]): Map<number, Outcome[]> {
  const groups = new Map<number, Outcome[]>();
  for (const violation of violations) {
    const list = groups.get(violation.worstChunkIndex) ?? [];
    list.push(violation);
    groups.set(violation.worstChunkIndex, list);
  }
  return groups;
}

// Evidence pass: for each violation, one Choice over the hunks of its worst chunk
// ("select instead of generate" — the judge picks the location, code prints file:line).
export async function locateEvidence(
  outcomes: Outcome[],
  questions: Map<string, string>,
  chunks: { hunks: Hunk[] }[],
  states: PrState[],
  judge: Judge,
): Promise<TokenUsage> {
  const calls: { violations: Outcome[]; promise: ReturnType<Judge['ask']> }[] = [];
  for (const [chunkIndex, list] of groupByChunk(
    outcomes.filter((outcome) => outcome.answer === 'NO'),
  )) {
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
                  violation: questions.get(violation.rule_id) ?? '',
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
