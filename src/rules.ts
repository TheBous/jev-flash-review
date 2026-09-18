// Boundary parser for the rule configuration. rules.json is untrusted input:
// parse it once into the domain type, never cast inside the domain.
import { readFile } from 'node:fs/promises';
import type { Result, Rule, RuleConfig, RulesError } from './types.js';

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
  let raw: string;
  try {
    raw = await readFile(new URL('../rules.json', import.meta.url), 'utf8');
  } catch {
    return { ok: false, error: 'unreadable-rules' };
  }
  try {
    return parseRules(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'invalid-rules' };
  }
}
