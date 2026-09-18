import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewDiff } from './engine.js';
import { parseRules } from './rules.js';
import type { ChoiceSpec, Judge, JudgeAnswers, PrState } from './types.js';

const CONFIG = parseRules({
  contract: { rules: ['R1', 'R2'] },
  categories: [
    {
      name: 'test',
      rules: [
        { rule_id: 'R1', question: 'Is R1 satisfied?', applies_if: 'always', severity: 'blocker' },
        { rule_id: 'R2', question: 'Is R2 satisfied?', applies_if: 'always', severity: 'low' },
      ],
    },
  ],
});

type Answer = { choice: string; probabilities: Record<string, number>; confidence: number };

const NO = (p: number): Answer => ({ choice: 'NO', probabilities: { NO: p }, confidence: 0.7 });
const YES = (p: number): Answer => ({ choice: 'YES', probabilities: { YES: p }, confidence: 0.8 });
const AT = (label: string, p: number): Answer => ({
  choice: label,
  probabilities: { [label]: p },
  confidence: 0.5,
});

function fakeJudge(
  answer: (state: PrState, key: string, spec: ChoiceSpec) => Answer | undefined,
): Judge {
  return {
    ask: async (state, questions) => {
      const answers: JudgeAnswers = {};
      for (const [key, spec] of Object.entries(questions)) {
        const decided = answer(state, key, spec);
        if (decided) answers[key] = decided;
      }
      return {
        answers,
        usage: { inputTokens: 10 * Object.keys(questions).length, outputTokens: 2 },
      };
    },
  };
}

const isRuleQuestion = (spec: ChoiceSpec): boolean => 'question' in spec.input;

test('reviewDiff rejects an empty diff', async () => {
  assert.ok(CONFIG.ok);
  const reviewed = await reviewDiff(
    { diff: '   ' },
    CONFIG.value,
    fakeJudge(() => undefined),
  );
  assert.deepEqual(reviewed, { ok: false, error: 'empty-diff' });
});

test('reviewDiff reports rule outcomes and locates evidence', async () => {
  assert.ok(CONFIG.ok);
  const judge = fakeJudge((state, key, spec) => {
    if (isRuleQuestion(spec)) {
      assert.equal(state.pr.part, '1 of 1');
      assert.equal(state.task_context, 'keep demo self-contained');
      return key === 'R1' ? NO(0.81) : YES(0.9);
    }
    return AT('hunk_001', 0.72);
  });
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1,1 +1,2 @@', '+new line'].join('\n');
  const reviewed = await reviewDiff(
    { diff, taskContext: 'keep demo self-contained' },
    CONFIG.value,
    judge,
  );
  assert.ok(reviewed.ok);
  assert.deepEqual(reviewed.value.summary, { total: 2, yes: 1, no: 1, na: 0, blockers: 1 });
  const [r1, r2] = reviewed.value.results;
  assert.equal(r1!.answer, 'NO');
  assert.deepEqual(r1!.evidence, [{ location: 'src/a.ts:1 (+2 lines)', probability: 0.72 }]);
  assert.equal(r2!.answer, 'YES');
  assert.deepEqual(reviewed.value.usage, { inputTokens: 30, outputTokens: 4 });
});

test('reviewDiff merges chunk outcomes keeping the most severe', async () => {
  assert.ok(CONFIG.ok);
  const judge = fakeJudge((state, key, spec) => {
    if (isRuleQuestion(spec)) {
      return state.pr.part.startsWith('1 of') ? (key === 'R1' ? YES(0.95) : NO(0.66)) : NO(0.5);
    }
    return AT('absent', 1);
  });
  const filler = Array.from({ length: 3_000 }, (_, i) => ` pad ${i} ${'y'.repeat(18)}`).join('\n');
  const diff = [
    'diff --git a/src/big.ts b/src/big.ts',
    '@@ -1,1 +1,2 @@',
    '+first hunk change',
    filler,
    '@@ -900,1 +901,2 @@',
    '+second hunk change',
  ].join('\n');
  const reviewed = await reviewDiff({ diff }, CONFIG.value, judge);
  assert.ok(reviewed.ok);
  assert.equal(reviewed.value.chunks, 2);
  const [r1, r2] = reviewed.value.results;
  assert.equal(r1!.answer, 'NO', 'YES in chunk 1, NO in chunk 2 → NO wins');
  assert.equal(r2!.answer, 'NO');
  assert.match(r2!.evidence[0]!.location, /absence/);
});
