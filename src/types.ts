// Domain contracts. External data enters only through parsers; nothing here
// imports a concrete driver — effects cross the Judge port.
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface Rule {
  rule_id: string;
  question: string;
  applies_if: string;
}

export interface RuleConfig {
  contract: { rules: string[] };
  categories: { name: string; rules: Rule[] }[];
}

export type RulesError = 'invalid-rules' | 'unreadable-rules';

export interface ReviewInput {
  diff: string;
  title?: string;
  description?: string;
  /** Business context: what the task/feature/fix is for, its boundaries and invariants. */
  taskContext?: string;
}

export type ReviewError = 'empty-diff';

export interface EvidenceHit {
  location: string;
  probability: number;
  /** Quoted hunk body for the confirm pass; stripped from public output. */
  snippet?: string;
}

export interface RuleOutcome {
  rule_id: string;
  question: string;
  severity: Severity | null;
  severityConfidence: number | null;
  answer: 'YES' | 'NO' | 'N/A';
  probability: number;
  confidence: number;
  evidence: EvidenceHit[];
  /** Impact rated against the selected evidence; null unless a confirmed violation. */
  impact: ImpactLevel | null;
  impactConfidence: number | null;
}

export type ImpactLevel = 'none' | 'minor' | 'significant' | 'critical';
export type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'info' | 'advisory';

/** Working outcome inside the workflow: carries the worst chunk for evidence. */
export interface Outcome extends RuleOutcome {
  worstChunkIndex: number;
}

export interface ReviewOutput {
  /** Full matrix: every rule outcome, including dropped violations. */
  results: RuleOutcome[];
  /** Confirmed findings only: NO outcomes that survived the evidence gates. */
  violations: RuleOutcome[];
  summary: {
    total: number;
    yes: number;
    no: number;
    na: number;
    blockers: number;
    dropped: number;
  };
  chunks: number;
  usage: { inputTokens: number; outputTokens: number };
}

export type JudgeQuestion = Record<string, unknown>;
export type JudgeAnswers = Record<
  string,
  { choice: string; probabilities: Record<string, number>; confidence: number }
>;
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A decision the judge must make: decision context plus selectable options. */
export interface ChoiceSpec {
  input: Record<string, string>;
  options: Record<string, string>;
}

/** State sent to the judge: the change under review plus the answer contract. */
export interface PrState {
  pr: { title: string; description: string; part: string; diff: string };
  task_context: string;
  answer_rules: string[];
}

/** Port to the decision engine: answers plus the call's token usage. */
export interface Judge {
  ask(
    state: PrState,
    questions: Record<string, ChoiceSpec>,
  ): Promise<{ answers: JudgeAnswers; usage: TokenUsage }>;
}
