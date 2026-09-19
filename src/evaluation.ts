export interface ReviewEvaluationExample {
  /** One example represents one candidate finding; use one example per finding. */
  id: string;
  repository: string;
  commitBase: string;
  commitHead: string;
  finding?: {
    ruleId: string;
    location: string;
    accepted: boolean;
    falsePositive: boolean;
    fixed: boolean;
  };
  labels: {
    hasBug: boolean;
    category?: string;
  };
}

export type EvaluationDecision = 'published' | 'abstained' | 'clean';

export interface EvaluationPrediction {
  exampleId: string;
  decision: EvaluationDecision;
}

export interface EvaluationRun {
  predictions: EvaluationPrediction[];
  metrics: EvaluationMetrics;
}

export interface EvaluationMetrics {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  publishedFindingPrecision: number | null;
  abstentionRate: number;
  developerAcceptanceRate: number | null;
  developerDismissalRate: number | null;
  findingFixRate: number | null;
}

export function parseEvaluationDataset(raw: unknown): ReviewEvaluationExample[] {
  if (!Array.isArray(raw)) throw new Error('Evaluation dataset must be an array');
  const examples = raw.map((value, index) => parseExample(value, index));
  const ids = new Set<string>();
  for (const example of examples) {
    if (ids.has(example.id)) throw new Error(`Duplicate example id: ${example.id}`);
    ids.add(example.id);
  }
  return examples;
}

export function evaluate(
  examples: ReviewEvaluationExample[],
  predictions: EvaluationPrediction[],
): EvaluationMetrics {
  const exampleIds = new Set(examples.map((example) => example.id));
  const predictionById = new Map<string, EvaluationPrediction>();
  for (const prediction of predictions) {
    if (!exampleIds.has(prediction.exampleId)) {
      throw new Error(`Prediction references unknown example: ${prediction.exampleId}`);
    }
    if (predictionById.has(prediction.exampleId)) {
      throw new Error(`Duplicate prediction for example: ${prediction.exampleId}`);
    }
    predictionById.set(prediction.exampleId, prediction);
  }
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  let abstentions = 0;
  let accepted = 0;
  let dismissed = 0;
  let fixed = 0;
  let publishedWithFeedback = 0;

  for (const example of examples) {
    const prediction = predictionById.get(example.id);
    const decision = prediction?.decision ?? 'abstained';
    const isTrueFinding = example.finding ? !example.finding.falsePositive : example.labels.hasBug;
    if (decision === 'abstained') abstentions++;

    if (decision === 'published' && isTrueFinding) truePositives++;
    else if (decision === 'published') falsePositives++;
    else if (isTrueFinding) falseNegatives++;
    else trueNegatives++;

    if (decision === 'published' && example.finding) {
      publishedWithFeedback++;
      if (example.finding.accepted) accepted++;
      if (example.finding.falsePositive) dismissed++;
      if (example.finding.fixed) fixed++;
    }
  }

  const published = truePositives + falsePositives;
  const actualBugs = truePositives + falseNegatives;
  const actualClean = falsePositives + trueNegatives;
  return {
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision: ratio(truePositives, published),
    recall: ratio(truePositives, actualBugs),
    falsePositiveRate: ratio(falsePositives, actualClean),
    falseNegativeRate: ratio(falseNegatives, actualBugs),
    publishedFindingPrecision: ratio(truePositives, published),
    abstentionRate: ratio(abstentions, examples.length) ?? 0,
    developerAcceptanceRate: ratio(accepted, publishedWithFeedback),
    developerDismissalRate: ratio(dismissed, publishedWithFeedback),
    findingFixRate: ratio(fixed, publishedWithFeedback),
  };
}

export async function runEvaluation(
  examples: ReviewEvaluationExample[],
  runner: (
    example: ReviewEvaluationExample,
  ) => EvaluationPrediction | Promise<EvaluationPrediction>,
): Promise<EvaluationRun> {
  const predictions: EvaluationPrediction[] = [];
  for (const example of examples) predictions.push(await runner(example));
  return { predictions, metrics: evaluate(examples, predictions) };
}

function parseExample(value: unknown, index: number): ReviewEvaluationExample {
  if (typeof value !== 'object' || value === null)
    throw new Error(`Invalid example at index ${index}`);
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.repository !== 'string' ||
    typeof record.commitBase !== 'string' ||
    typeof record.commitHead !== 'string' ||
    typeof record.labels !== 'object' ||
    record.labels === null
  ) {
    throw new Error(`Invalid example at index ${index}`);
  }
  const labels = record.labels as Record<string, unknown>;
  if (typeof labels.hasBug !== 'boolean') throw new Error(`Invalid labels at index ${index}`);
  const finding = record.finding;
  if (finding === undefined) {
    return {
      id: record.id,
      repository: record.repository,
      commitBase: record.commitBase,
      commitHead: record.commitHead,
      labels: {
        hasBug: labels.hasBug,
        ...(typeof labels.category === 'string' ? { category: labels.category } : {}),
      },
    };
  }
  if (typeof finding !== 'object' || finding === null)
    throw new Error(`Invalid finding at index ${index}`);
  const candidate = finding as Record<string, unknown>;
  if (
    typeof candidate.ruleId !== 'string' ||
    typeof candidate.location !== 'string' ||
    typeof candidate.accepted !== 'boolean' ||
    typeof candidate.falsePositive !== 'boolean' ||
    typeof candidate.fixed !== 'boolean'
  ) {
    throw new Error(`Invalid finding at index ${index}`);
  }
  return {
    id: record.id,
    repository: record.repository,
    commitBase: record.commitBase,
    commitHead: record.commitHead,
    finding: {
      ruleId: candidate.ruleId,
      location: candidate.location,
      accepted: candidate.accepted,
      falsePositive: candidate.falsePositive,
      fixed: candidate.fixed,
    },
    labels: {
      hasBug: labels.hasBug,
      ...(typeof labels.category === 'string' ? { category: labels.category } : {}),
    },
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
