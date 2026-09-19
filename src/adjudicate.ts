// Adjudication: confidence gate, noIssue-style confirm, impact rating.
// A NO whose best location is weak, or whose location does not support the
// violation on second look, is dropped — never reported as a finding.
import { EVIDENCE_PER_CALL, groupByChunk, need, sanitize } from './evidence.js';
import type {
  ChoiceSpec,
  EvidenceHit,
  ImpactLevel,
  Judge,
  Outcome,
  PrState,
  Severity,
  TokenUsage,
} from './types.js';

// Minimum top-location confidence for a violation to survive. Mirrors
// devagrawal09's MIN_LOCATION_CONFIDENCE; tune from field data, not theory.
const MIN_LOCATION_CONFIDENCE = 0.55;

// Minimum lead of the best location over the runner-up. A 0.56-vs-0.54
// pointer is a shrug, not evidence; tune from field data, not theory.
const MIN_EVIDENCE_MARGIN = 0.1;

function evidenceProb(evidence: EvidenceHit[], index: number): number {
  return evidence[index]?.probability ?? 0;
}

const CONFIRM_INSTRUCTION =
  'Does the quoted code directly show the rule being broken? Choose `unsupported` when the quoted code does not support a concrete violation.';

const CONFIRM_CRITERIA = {
  supported: 'The quoted code directly shows the rule being broken.',
  unsupported: 'The quoted code does not support a concrete violation of this rule.',
} as const;

const CONFIRM_ABSENT_INSTRUCTION =
  'Does the PR as a whole show the rule being broken? Choose `unsupported` when the diff does not support a concrete violation.';

const CONFIRM_ABSENT_CRITERIA = {
  supported: 'The PR as a whole shows the rule being broken.',
  unsupported: 'The diff does not support a concrete violation of this rule.',
} as const;

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
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const flagged = outcomes.filter((outcome) => outcome.answer === 'NO');
  const candidates = flagged.filter(
    (outcome) =>
      evidenceProb(outcome.evidence, 0) >= MIN_LOCATION_CONFIDENCE &&
      evidenceProb(outcome.evidence, 0) - evidenceProb(outcome.evidence, 1) >= MIN_EVIDENCE_MARGIN,
  );

  const confirmations = await batchedAsk(candidates, states, judge, (batch) =>
    Object.fromEntries(
      batch.map((violation) => {
        // Absent evidence has no code to quote: ask about the PR, not the quote.
        const quoted = violation.evidence[0]?.snippet ?? '';
        const quotedConfirm = quoted.length > 0;
        return [
          sanitize(violation.rule_id),
          {
            input: {
              violation: violation.question,
              location: violation.evidence[0]?.location ?? '',
              snippet: quoted,
              instruction: quotedConfirm ? CONFIRM_INSTRUCTION : CONFIRM_ABSENT_INSTRUCTION,
            },
            options: quotedConfirm ? CONFIRM_CRITERIA : CONFIRM_ABSENT_CRITERIA,
          } satisfies ChoiceSpec,
        ];
      }),
    ),
  );
  const confirmed = confirmations
    .filter(({ answer }) => answer.choice === 'supported')
    .map(({ violation }) => violation);
  for (const { usage: callUsage } of confirmations) {
    usage.inputTokens += callUsage.inputTokens;
    usage.outputTokens += callUsage.outputTokens;
  }

  // Impact and severity are requested together to avoid an extra network call
  // per confirmed finding while keeping them as separate model decisions.
  const ratings = await rateConfirmed(confirmed, states, judge);
  for (const { violation, impact, severity, usage: callUsage } of ratings) {
    usage.inputTokens += callUsage.inputTokens;
    usage.outputTokens += callUsage.outputTokens;
    violation.impact = impact.choice as ImpactLevel;
    violation.impactConfidence = impact.confidence;
    violation.severity = severity.choice as Severity;
    violation.severityConfidence = severity.confidence;
  }

  return { violations: confirmed, dropped: flagged.length - confirmed.length, usage };
}

interface AskedAnswer {
  violation: Outcome;
  answer: { choice: string; probabilities: Record<string, number>; confidence: number };
  usage: TokenUsage;
}

interface RatedViolation {
  violation: Outcome;
  impact: AskedAnswer['answer'];
  severity: AskedAnswer['answer'];
  usage: TokenUsage;
}

async function rateConfirmed(
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
                    },
                  ],
                  [
                    `${base}_severity`,
                    {
                      input: { ...input, instruction: SEVERITY_INSTRUCTION },
                      options: SEVERITY_CRITERIA,
                    },
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

async function batchedAsk(
  violations: Outcome[],
  states: PrState[],
  judge: Judge,
  buildQuestions: (batch: Outcome[]) => Record<string, ChoiceSpec>,
): Promise<AskedAnswer[]> {
  const calls: Promise<AskedAnswer[]>[] = [];
  for (const [chunkIndex, list] of groupByChunk(violations)) {
    const state = states[chunkIndex];
    if (!state) continue;
    for (let i = 0; i < list.length; i += EVIDENCE_PER_CALL) {
      const batch = list.slice(i, i + EVIDENCE_PER_CALL);
      calls.push(
        judge.ask(state, buildQuestions(batch)).then(({ answers, usage }) =>
          batch.map((violation) => ({
            violation,
            answer: need(answers, sanitize(violation.rule_id)),
            usage,
          })),
        ),
      );
    }
  }
  return (await Promise.all(calls)).flat();
}
