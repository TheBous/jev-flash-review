// Domain contracts. External data enters only through parsers; nothing here
// imports a concrete driver — effects cross the Judge port.
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface Rule {
  rule_id: string;
  question: string;
  applies_if: string;
  severity: string;
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
}

export type ReviewError = 'empty-diff';

export interface EvidenceHit {
  location: string;
  probability: number;
}

export interface RuleOutcome {
  rule_id: string;
  question: string;
  severity: string;
  answer: 'YES' | 'NO' | 'N/A';
  probability: number;
  confidence: number;
  evidence: EvidenceHit[];
}

export interface ReviewOutput {
  results: RuleOutcome[];
  summary: { total: number; yes: number; no: number; na: number; blockers: number };
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
  answer_rules: string[];
}

/** Port to the decision engine: answers plus the call's token usage. */
export interface Judge {
  ask(
    state: PrState,
    questions: Record<string, ChoiceSpec>,
  ): Promise<{ answers: JudgeAnswers; usage: TokenUsage }>;
}
