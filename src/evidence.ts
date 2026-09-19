// Evidence location and validation: one Choice per NO result over the hunks
// of its chunk. `unsupported` replaces a separate confirmation pass.

import type { Hunk } from './diff.js';
import type { ChoiceSpec, EvidenceHit, Judge, Outcome, PrState, TokenUsage } from './types.js';

// evidence questions carry every hunk of the chunk as options (~25 tokens each);
// 8 × 60 hunks × 25t ≈ 12k on top of the chunk state stays inside the budget
export const EVIDENCE_PER_CALL = 8;

const ABSENT =
  'The violation is not tied to one hunk: it is an absence (missing tests, docs, config, handling) or a PR-level issue.';
const UNSUPPORTED =
  'The diff does not support a concrete violation of this rule; discard this result.';

const EVIDENCE_INSTRUCTION =
  'Choose the `[hunk_*]` marker in `pr.diff` that directly shows the violation. Choose `absent` when the violation is real but not tied to a specific hunk. Choose `unsupported` when the diff does not support a concrete violation.';

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
    const chunkIndex = violation.evidence[0]?.chunkIndex ?? violation.worstChunkIndex;
    const list = groups.get(chunkIndex) ?? [];
    list.push(violation);
    groups.set(chunkIndex, list);
  }
  return groups;
}

interface EvidenceTarget {
  violation: Outcome;
  chunkIndex: number;
  chunkResult: Outcome['chunkResults'][number];
}

// Evidence pass: for each NO result, one Choice over the hunks of its chunk
// ("select instead of generate" — the judge picks the location or rejects it).
export async function locateEvidence(
  outcomes: Outcome[],
  questions: Map<string, string>,
  chunks: { hunks: Hunk[] }[],
  states: PrState[],
  judge: Judge,
): Promise<TokenUsage> {
  const targetsByChunk = new Map<number, EvidenceTarget[]>();
  for (const violation of outcomes.filter((outcome) => outcome.answer === 'NO')) {
    for (const chunkResult of violation.chunkResults.filter((chunk) => chunk.answer === 'NO')) {
      const list = targetsByChunk.get(chunkResult.chunkIndex) ?? [];
      list.push({ violation, chunkIndex: chunkResult.chunkIndex, chunkResult });
      targetsByChunk.set(chunkResult.chunkIndex, list);
    }
  }

  const calls: { targets: EvidenceTarget[]; promise: ReturnType<Judge['ask']> }[] = [];
  for (const [chunkIndex, list] of targetsByChunk) {
    const chunk = chunks[chunkIndex];
    const state = states[chunkIndex];
    if (!chunk || chunk.hunks.length === 0 || !state) continue;
    const options: Record<string, string> = Object.fromEntries(
      chunk.hunks.map((h) => [h.id, `${h.file}:${h.start} (${h.count} changed-line block)`]),
    );
    options.absent = ABSENT;
    options.unsupported = UNSUPPORTED;
    for (let i = 0; i < list.length; i += EVIDENCE_PER_CALL) {
      const batch = list.slice(i, i + EVIDENCE_PER_CALL);
      calls.push({
        targets: batch,
        promise: judge.ask(
          state,
          Object.fromEntries(
            batch.map(({ violation }) => [
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
  for (const { targets, promise } of calls) {
    const { answers, usage: callUsage } = await promise;
    usage.inputTokens += callUsage.inputTokens;
    usage.outputTokens += callUsage.outputTokens;
    for (const { violation, chunkIndex, chunkResult } of targets) {
      const answer = need(answers, sanitize(violation.rule_id));
      chunkResult.evidence =
        answer.choice === 'unsupported'
          ? []
          : topEvidence(answer.probabilities, chunkIndex, chunks[chunkIndex]?.hunks ?? []);
    }
  }
  for (const outcome of outcomes) {
    outcome.evidence = outcome.chunkResults
      .flatMap((chunk) => chunk.evidence)
      .sort((a, b) => b.probability - a.probability);
  }
  return usage;
}

function topEvidence(
  probabilities: Record<string, number>,
  chunkIndex: number,
  hunks: Hunk[],
): EvidenceHit[] {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .filter(([label]) => label !== 'unsupported')
    .filter(([, p]) => p >= 0.05)
    .slice(0, 2)
    .map(([label, p]) => {
      const hunk = hunks.find((h) => h.id === label);
      return {
        location: hunk
          ? `${hunk.file}:${hunk.start} (+${hunk.count} lines)`
          : 'absence / PR-level (not tied to a hunk)',
        probability: p,
        chunkIndex,
      };
    });
}
