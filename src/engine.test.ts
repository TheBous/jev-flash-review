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
const SUPPORTED: Answer = {
  choice: 'supported',
  probabilities: { supported: 0.9 },
  confidence: 0.8,
};
const UNSUPPORTED: Answer = {
  choice: 'unsupported',
  probabilities: { unsupported: 0.9 },
  confidence: 0.8,
};
const SIGNIFICANT: Answer = {
  choice: 'significant',
  probabilities: { significant: 0.85 },
  confidence: 0.75,
};

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

type QuestionKind = 'rule' | 'evidence' | 'confirm' | 'impact';

function kindOf(spec: ChoiceSpec): QuestionKind {
  if ('question' in spec.input) return 'rule';
  const instruction = spec.input.instruction ?? '';
  if (instruction.includes('directly show') || instruction.includes('PR as a whole'))
    return 'confirm';
  if (instruction.includes('production impact')) return 'impact';
  return 'evidence';
}

const SMALL_DIFF = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1,1 +1,2 @@', '+new line'].join('\n');

test('reviewDiff rejects an empty diff', async () => {
  assert.ok(CONFIG.ok);
  const reviewed = await reviewDiff(
    { diff: '   ' },
    CONFIG.value,
    fakeJudge(() => undefined),
  );
  assert.deepEqual(reviewed, { ok: false, error: 'empty-diff' });
});

test('reviewDiff confirms violations and rates impact', async () => {
  assert.ok(CONFIG.ok);
  let confirmSnippet: string | undefined;
  const judge = fakeJudge((state, key, spec) => {
    switch (kindOf(spec)) {
      case 'rule':
        assert.equal(state.pr.part, '1 of 1');
        assert.equal(state.task_context, 'keep demo self-contained');
        return key === 'R1' ? NO(0.81) : YES(0.9);
      case 'evidence':
        return AT('hunk_001', 0.72);
      case 'confirm':
        confirmSnippet = spec.input.snippet;
        return SUPPORTED;
      case 'impact':
        return SIGNIFICANT;
    }
  });
  const reviewed = await reviewDiff(
    { diff: SMALL_DIFF, taskContext: 'keep demo self-contained' },
    CONFIG.value,
    judge,
  );
  assert.ok(reviewed.ok);
  assert.deepEqual(reviewed.value.summary, {
    total: 2,
    yes: 1,
    no: 1,
    na: 0,
    blockers: 1,
    dropped: 0,
  });
  assert.equal(reviewed.value.violations.length, 1);
  const [v] = reviewed.value.violations;
  assert.equal(v!.rule_id, 'R1');
  assert.equal(v!.impact, 'significant');
  assert.equal(v!.impactConfidence, 0.75);
  assert.deepEqual(v!.evidence, [{ location: 'src/a.ts:1 (+2 lines)', probability: 0.72 }]);
  assert.equal(confirmSnippet, '+new line');
  assert.equal(reviewed.value.results.length, 2);
});

test('reviewDiff drops violations with weak location confidence', async () => {
  assert.ok(CONFIG.ok);
  let confirmAsked = false;
  let impactAsked = false;
  const judge = fakeJudge((state, key, spec) => {
    switch (kindOf(spec)) {
      case 'rule':
        return key === 'R1' ? NO(0.81) : YES(0.9);
      case 'evidence':
        return AT('hunk_001', 0.4);
      case 'confirm':
        confirmAsked = true;
        return SUPPORTED;
      case 'impact':
        impactAsked = true;
        return SIGNIFICANT;
    }
  });
  const reviewed = await reviewDiff({ diff: SMALL_DIFF }, CONFIG.value, judge);
  assert.ok(reviewed.ok);
  assert.deepEqual(reviewed.value.violations, []);
  assert.equal(reviewed.value.summary.dropped, 1);
  assert.equal(reviewed.value.summary.no, 0);
  assert.equal(reviewed.value.summary.blockers, 0);
  assert.equal(confirmAsked, false);
  assert.equal(impactAsked, false);
  // the matrix keeps the raw NO outcome
  assert.equal(reviewed.value.results.find((r) => r.rule_id === 'R1')?.answer, 'NO');
});

test('reviewDiff drops violations the evidence does not support', async () => {
  assert.ok(CONFIG.ok);
  let impactAsked = false;
  const judge = fakeJudge((state, key, spec) => {
    switch (kindOf(spec)) {
      case 'rule':
        return key === 'R1' ? NO(0.81) : YES(0.9);
      case 'evidence':
        return AT('hunk_001', 0.9);
      case 'confirm':
        return UNSUPPORTED;
      case 'impact':
        impactAsked = true;
        return SIGNIFICANT;
    }
  });
  const reviewed = await reviewDiff({ diff: SMALL_DIFF }, CONFIG.value, judge);
  assert.ok(reviewed.ok);
  assert.deepEqual(reviewed.value.violations, []);
  assert.equal(reviewed.value.summary.dropped, 1);
  assert.equal(impactAsked, false);
});

test('reviewDiff merges chunk outcomes keeping the most severe', async () => {
  assert.ok(CONFIG.ok);
  const confirmInstructions: string[] = [];
  const judge = fakeJudge((state, key, spec) => {
    switch (kindOf(spec)) {
      case 'rule':
        return state.pr.part.startsWith('1 of') ? (key === 'R1' ? YES(0.95) : NO(0.66)) : NO(0.5);
      case 'evidence':
        return AT('absent', 1);
      case 'confirm':
        confirmInstructions.push(spec.input.instruction ?? '');
        return SUPPORTED;
      case 'impact':
        return SIGNIFICANT;
    }
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
  assert.equal(reviewed.value.violations.length, 2);
  const [r1, r2] = reviewed.value.violations;
  assert.equal(r1!.answer, 'NO', 'YES in chunk 1, NO in chunk 2 → NO wins');
  assert.equal(r2!.answer, 'NO');
  assert.equal(r2!.impact, 'significant');
  assert.match(r2!.evidence[0]!.location, /absence/);
  // absent evidence has no quote: confirm must ask about the PR, not the code
  assert.ok(confirmInstructions.length > 0);
  assert.ok(confirmInstructions.every((i) => i.includes('PR as a whole')));
});

test('reviewDiff drops violations with an ambiguous pointer', async () => {
  assert.ok(CONFIG.ok);
  let confirmAsked = false;
  const judge = fakeJudge((state, key, spec) => {
    switch (kindOf(spec)) {
      case 'rule':
        return key === 'R1' ? NO(0.81) : YES(0.9);
      case 'evidence':
        // above the confidence gate, below the margin gate
        return {
          choice: 'hunk_001',
          probabilities: { hunk_001: 0.6, absent: 0.56 },
          confidence: 0.5,
        };
      case 'confirm':
        confirmAsked = true;
        return SUPPORTED;
      case 'impact':
        return SIGNIFICANT;
    }
  });
  const reviewed = await reviewDiff({ diff: SMALL_DIFF }, CONFIG.value, judge);
  assert.ok(reviewed.ok);
  assert.deepEqual(reviewed.value.violations, []);
  assert.equal(reviewed.value.summary.dropped, 1);
  assert.equal(confirmAsked, false);
});
