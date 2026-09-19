// Boundary parser for the rule configuration. The split rule files are
// untrusted input: parse them once into the domain type, never cast inside
// the domain.

import agentNativeAndParity from './rules/agent-native-and-parity.json' with { type: 'json' };
import aiGeneratedCodeRules from './rules/ai-generated-code-rules.json' with { type: 'json' };
import apiContractsAndCompatibility from './rules/api-contracts-and-compatibility.json' with {
  type: 'json',
};
import architectureAndMaintainability from './rules/architecture-and-maintainability.json' with {
  type: 'json',
};
import boundaryParsingAndTypes from './rules/boundary-parsing-and-types.json' with { type: 'json' };
import contextAndScopeBoundary from './rules/context-and-scope-boundary.json' with { type: 'json' };
import dependenciesCicdAndSupplyChain from './rules/dependencies-cicd-and-supply-chain.json' with {
  type: 'json',
};
import documentationAndOperations from './rules/documentation-and-operations.json' with {
  type: 'json',
};
import errorsConsistencyAndReliability from './rules/errors-consistency-and-reliability.json' with {
  type: 'json',
};
import frontendEngineering from './rules/frontend-engineering.json' with { type: 'json' };
import functionalCorrectness from './rules/functional-correctness.json' with { type: 'json' };
import intentAndScope from './rules/intent-and-scope.json' with { type: 'json' };
import llmApplicationSecurity from './rules/llm-application-security.json' with { type: 'json' };
import meta from './rules/meta.json' with { type: 'json' };
import multiModelReview from './rules/multi-model-review.json' with { type: 'json' };
import performanceAndResources from './rules/performance-and-resources.json' with { type: 'json' };
import privacyAndCompliance from './rules/privacy-and-compliance.json' with { type: 'json' };
import security from './rules/security.json' with { type: 'json' };
import testingAndVerification from './rules/testing-and-verification.json' with { type: 'json' };
import uiAndAccessibility from './rules/ui-and-accessibility.json' with { type: 'json' };
import type { Result, Rule, RuleConfig, RulesError } from './types.js';

// Merged rule data: one entry per review type, in review-execution order.
export const rawRules = {
  ...meta,
  categories: [
    contextAndScopeBoundary,
    agentNativeAndParity,
    intentAndScope,
    functionalCorrectness,
    boundaryParsingAndTypes,
    architectureAndMaintainability,
    errorsConsistencyAndReliability,
    security,
    apiContractsAndCompatibility,
    performanceAndResources,
    testingAndVerification,
    frontendEngineering,
    uiAndAccessibility,
    dependenciesCicdAndSupplyChain,
    documentationAndOperations,
    privacyAndCompliance,
    aiGeneratedCodeRules,
    llmApplicationSecurity,
    multiModelReview,
  ],
};

function parseRule(raw: unknown): Result<Rule, 'invalid-rules'> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid-rules' };
  const r = raw as Record<string, unknown>;
  for (const key of ['rule_id', 'question', 'applies_if', 'severity']) {
    if (typeof r[key] !== 'string' || (r[key] as string).length === 0) {
      return { ok: false, error: 'invalid-rules' };
    }
  }
  return {
    ok: true,
    value: {
      rule_id: r.rule_id as string,
      question: r.question as string,
      applies_if: r.applies_if as string,
      severity: r.severity as string,
    },
  };
}

export function parseRules(raw: unknown): Result<RuleConfig, RulesError> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid-rules' };
  const c = raw as Record<string, unknown>;
  const contract = c.contract as Record<string, unknown> | undefined;
  const categories = c.categories;
  if (
    !contract ||
    !Array.isArray(contract.rules) ||
    !contract.rules.every((r) => typeof r === 'string') ||
    !Array.isArray(categories)
  ) {
    return { ok: false, error: 'invalid-rules' };
  }
  const parsedCategories = [];
  for (const category of categories) {
    if (typeof category !== 'object' || category === null) {
      return { ok: false, error: 'invalid-rules' };
    }
    const cat = category as Record<string, unknown>;
    if (typeof cat.name !== 'string' || !Array.isArray(cat.rules)) {
      return { ok: false, error: 'invalid-rules' };
    }
    const rules: Rule[] = [];
    for (const raw2 of cat.rules) {
      const rule = parseRule(raw2);
      if (!rule.ok) return rule;
      rules.push(rule.value);
    }
    parsedCategories.push({ name: cat.name, rules });
  }
  const config: RuleConfig = {
    contract: { rules: contract.rules as string[] },
    categories: parsedCategories,
  };
  if (config.categories.flatMap((category) => category.rules).length === 0) {
    return { ok: false, error: 'invalid-rules' };
  }
  return { ok: true, value: config };
}

export async function loadRules(): Promise<Result<RuleConfig, RulesError>> {
  return parseRules(rawRules);
}
