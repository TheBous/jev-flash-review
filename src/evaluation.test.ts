import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, parseEvaluationDataset, runEvaluation } from './evaluation.js';

const DATASET = [
  {
    id: 'bug',
    repository: 'demo',
    commitBase: 'base',
    commitHead: 'head',
    labels: { hasBug: true, category: 'nullability' },
  },
  {
    id: 'clean',
    repository: 'demo',
    commitBase: 'base',
    commitHead: 'head',
    labels: { hasBug: false },
  },
];

test('evaluation harness computes precision and abstention without guessing', () => {
  const examples = parseEvaluationDataset(DATASET);
  const metrics = evaluate(examples, [{ exampleId: 'bug', decision: 'published' }]);

  assert.equal(metrics.truePositives, 1);
  assert.equal(metrics.falsePositives, 0);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.publishedFindingPrecision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.abstentionRate, 0.5);
});

test('evaluation dataset rejects malformed examples', () => {
  assert.throws(() => parseEvaluationDataset([{ id: 'broken' }]), /Invalid example/);
  assert.throws(() => parseEvaluationDataset([DATASET[0], DATASET[0]]), /Duplicate example id/);
});

test('measures candidate-level false positives from finding labels', () => {
  const examples = parseEvaluationDataset([
    {
      id: 'dismissed',
      repository: 'demo',
      commitBase: 'base',
      commitHead: 'head',
      finding: {
        ruleId: 'R1',
        location: 'src/api.ts:1',
        accepted: false,
        falsePositive: true,
        fixed: false,
      },
      labels: { hasBug: true },
    },
  ]);

  const metrics = evaluate(examples, [{ exampleId: 'dismissed', decision: 'published' }]);
  assert.equal(metrics.truePositives, 0);
  assert.equal(metrics.falsePositives, 1);
  assert.equal(metrics.publishedFindingPrecision, 0);
});

test('runs an evaluation runner and returns predictions with metrics', async () => {
  const examples = parseEvaluationDataset(DATASET);
  const result = await runEvaluation(examples, (example) => ({
    exampleId: example.id,
    decision: example.id === 'bug' ? 'published' : 'clean',
  }));

  assert.equal(result.predictions.length, 2);
  assert.equal(result.metrics.truePositives, 1);
  assert.equal(result.metrics.trueNegatives, 1);
});
