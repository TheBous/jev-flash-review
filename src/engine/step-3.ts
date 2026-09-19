// Step 3: discard weak evidence and rate surviving findings.

import type {
  ChoiceSpec,
  EvidenceHit,
  ImpactLevel,
  Judge,
  Outcome,
  PrState,
  Severity,
  TokenUsage,
} from '../types.js';
import { need, sanitize } from './shared.js';
import { EVIDENCE_PER_CALL, groupByChunk } from './step-2.js';

const MIN_LOCATION_CONFIDENCE = 0.55;
const MIN_EVIDENCE_MARGIN = 0.1;

function hasStrongEvidence(evidence: EvidenceHit[]): boolean {
  const byChunk = new Map<number, EvidenceHit[]>();
  for (const hit of evidence) {
    const list = byChunk.get(hit.chunkIndex) ?? [];
    list.push(hit);
    byChunk.set(hit.chunkIndex, list);
  }
  return [...byChunk.values()].some((hits) => {
    hits.sort((a, b) => b.probability - a.probability);
    return (
      (hits[0]?.probability ?? 0) >= MIN_LOCATION_CONFIDENCE &&
      (hits[0]?.probability ?? 0) - (hits[1]?.probability ?? 0) >= MIN_EVIDENCE_MARGIN
    );
  });
}

const IMPACT_INSTRUCTION =
  'Assuming the location exhibits the violation, rate the likely production impact.';
const IMPACT_CRITERIA = {
  none: 'No meaningful impact even if the violation is real.',
  minor: 'Minor or narrowly limited impact.',
  significant: 'Significant correctness, reliability, compatibility, or security impact.',
  critical: 'Critical security, data-loss, or widespread outage impact.',
} as const;

const SEVERITY_INSTRUCTION =
  'Rate the confirmed violation by likely production severity, considering the evidence, impact, ' +
  'task context, blast radius, reversibility, and available workarounds.';
const SEVERITY_CRITERIA = {
  blocker:
    'Critical security issue, data loss/corruption, widespread outage, or unrecoverable contract break.',
  high: 'Major user-facing failure, significant security/reliability risk, or no safe workaround.',
  medium:
    'Bounded correctness, reliability, or compatibility impact with a workaround or limited blast radius.',
  low: 'Localized non-critical defect with limited operational or user impact.',
  info: 'Informational issue without a concrete production risk.',
  advisory: 'Optional improvement or maintainability concern, not a required fix.',
} as const;

export async function adjudicateViolations(
  outcomes: Outcome[],
  states: PrState[],
  judge: Judge,
): Promise<{ violations: Outcome[]; dropped: number; usage: TokenUsage }> {
  const flagged = outcomes.filter((outcome) => outcome.answer === 'NO');
  const candidates = flagged.filter((outcome) => hasStrongEvidence(outcome.evidence));
  const rated = await rateFindings(candidates, states, judge);
  const usage = rated.reduce(sumRatingUsage, { inputTokens: 0, outputTokens: 0 });
  for (const { violation, impact, severity } of rated) {
    violation.impact = impact.choice as ImpactLevel;
    violation.impactConfidence = impact.confidence;
    violation.severity = severity.choice as Severity;
    violation.severityConfidence = severity.confidence;
  }
  return { violations: candidates, dropped: flagged.length - candidates.length, usage };
}

type JudgeAnswer = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

interface RatedViolation {
  violation: Outcome;
  impact: JudgeAnswer;
  severity: JudgeAnswer;
  usage: TokenUsage;
}

async function rateFindings(
  violations: Outcome[],
  states: PrState[],
  judge: Judge,
): Promise<RatedViolation[]> {
  const calls: Promise<RatedViolation[]>[] = [];
  for (const [chunkIndex, list] of groupByChunk(violations)) {
    const state = states[chunkIndex];
    if (!state) continue;
    for (let i = 0; i < list.length; i += EVIDENCE_PER_CALL) {
      const batch = list.slice(i, i + EVIDENCE_PER_CALL);
      calls.push(
        judge
          .ask(
            state,
            Object.fromEntries(
              batch.flatMap((violation) => {
                const base = sanitize(violation.rule_id);
                const input = {
                  violation: violation.question,
                  location: violation.evidence[0]?.location ?? '',
                };
                return [
                  [
                    `${base}_impact`,
                    {
                      input: { ...input, instruction: IMPACT_INSTRUCTION },
                      options: IMPACT_CRITERIA,
                    } satisfies ChoiceSpec,
                  ],
                  [
                    `${base}_severity`,
                    {
                      input: { ...input, instruction: SEVERITY_INSTRUCTION },
                      options: SEVERITY_CRITERIA,
                    } satisfies ChoiceSpec,
                  ],
                ];
              }),
            ),
          )
          .then(({ answers, usage }) =>
            batch.map((violation) => {
              const base = sanitize(violation.rule_id);
              return {
                violation,
                impact: need(answers, `${base}_impact`),
                severity: need(answers, `${base}_severity`),
                usage,
              };
            }),
          ),
      );
    }
  }
  return (await Promise.all(calls)).flat();
}

function sumRatingUsage(total: TokenUsage, rating: RatedViolation): TokenUsage {
  total.inputTokens += rating.usage.inputTokens;
  total.outputTokens += rating.usage.outputTokens;
  return total;
}
