/**
 * IntentClassifier — rule-based intent classification (no LLM required).
 *
 * Architecture Doc §4: User Input → IntentClassifier → CapabilitySelector
 * Classifies user input into IntentKind for downstream capability selection.
 */

import type { ClassifiedIntent, IntentKind } from "./types.js";

interface IntentRule {
  readonly kind: IntentKind;
  readonly patterns: readonly RegExp[];
  readonly roleHints: readonly string[];
  readonly priority: number;
}

const INTENT_RULES: readonly IntentRule[] = [
  {
    kind: "debugging",
    patterns: [/debug|fix|error|failure|bug|trace|investigate|crash|stack\s*trace|exception/i],
    roleHints: ["debugger"],
    priority: 10,
  },
  {
    kind: "review",
    patterns: [/review|audit|check|validate|verify|pr\s*review|code\s*review|security\s*review/i],
    roleHints: ["reviewer", "security"],
    priority: 10,
  },
  {
    kind: "test-generation",
    patterns: [/test|spec|coverage|assertion|unit\s*test|e2e|integration\s*test|tdd/i],
    roleHints: ["tester", "qa"],
    priority: 8,
  },
  {
    kind: "refactor",
    patterns: [/refactor|optimize|clean|improve|simplify|restructure|modernize/i],
    roleHints: ["refactor"],
    priority: 8,
  },
  {
    kind: "research",
    patterns: [/research|investigate|explore|search|discover|analyze|compare|benchmark/i],
    roleHints: ["researcher", "explorer"],
    priority: 7,
  },
  {
    kind: "planning",
    patterns: [/plan|design|architect|strategy|roadmap|spec|specify|rfc|proposal/i],
    roleHints: ["planner", "architect"],
    priority: 7,
  },
  {
    kind: "documentation",
    patterns: [/doc|readme|changelog|comment|javadoc|jsdoc|wiki|guide|tutorial/i],
    roleHints: ["documenter"],
    priority: 6,
  },
  {
    kind: "shell-operation",
    patterns: [/shell|command|run|exec|script|bash|terminal|cli/i],
    roleHints: ["shell"],
    priority: 5,
  },
  {
    kind: "chat",
    patterns: [/chat|talk|ask|question|explain|how|what|why|help/i],
    roleHints: [],
    priority: 3,
  },
  {
    kind: "coding",
    patterns: [/implement|build|create|develop|add|feature|module|component|function|class/i],
    roleHints: ["coder"],
    priority: 5,
  },
];

/**
 * Classify user input into an IntentKind.
 * Pure rule-based — no LLM call, deterministic, fast.
 */
export function classifyIntent(
  input: string,
  role?: string
): ClassifiedIntent {
  const matchedRules: string[] = [];
  let bestKind: IntentKind = "unknown";
  let bestScore = 0;
  let bestPriority = 0;

  for (const rule of INTENT_RULES) {
    let score = 0;

    // Pattern match
    for (const pattern of rule.patterns) {
      if (pattern.test(input)) {
        score += 5;
        matchedRules.push(`pattern:${rule.kind}`);
      }
    }

    // Role hint match
    if (role && rule.roleHints.includes(role)) {
      score += 3;
      matchedRules.push(`role:${rule.kind}`);
    }

    // Combined score with priority tiebreaker
    if (score > bestScore || (score === bestScore && rule.priority > bestPriority)) {
      bestScore = score;
      bestPriority = rule.priority;
      bestKind = rule.kind;
    }
  }

  // Confidence: 0-1 based on match strength
  const confidence = bestScore > 0 ? Math.min(bestScore / 8, 1.0) : 0.1;

  return {
    kind: bestKind,
    confidence,
    matchedRules,
    rawInput: input,
  };
}

/**
 * Quick intent check — returns just the kind.
 */
export function quickClassify(input: string, role?: string): IntentKind {
  return classifyIntent(input, role).kind;
}
