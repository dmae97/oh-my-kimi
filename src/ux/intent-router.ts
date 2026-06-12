import type { OmkUxMode } from "./natural-entrypoint.js";

export type OmkUxIntent =
  | "chat"
  | "explain"
  | "plan"
  | "edit"
  | "fix"
  | "review"
  | "test"
  | "parallel"
  | "diagnose";

export interface RepoSignals {
  hasUncommittedChanges?: boolean;
  largeRepo?: boolean;
}

export interface RoutedPrompt {
  intent: OmkUxIntent;
  mode: OmkUxMode;
  safety: "read-only" | "ask-before-edit" | "workspace-write";
  execution: "plan-only" | "guided" | "auto";
  reason: string;
}

export function routeNaturalPrompt(
  prompt: string,
  repoSignals: RepoSignals = {},
  requestedMode?: OmkUxMode,
): RoutedPrompt {
  const intent = classifyPromptIntent(prompt, repoSignals);
  const mode = requestedMode ?? defaultModeForIntent(intent);
  return {
    intent,
    mode,
    safety: safetyForMode(mode),
    execution: executionForMode(mode),
    reason: reasonForIntent(intent),
  };
}

export function classifyPromptIntent(prompt: string, repoSignals: RepoSignals = {}): OmkUxIntent {
  const lowered = prompt.toLowerCase();
  if (/\b(explain|what is|how does|describe|설명|이거 뭐|어떻게 동작)\b/i.test(prompt)) return "explain";
  if (/\b(review|audit|검토|리뷰|코드리뷰)\b/i.test(prompt)) return "review";
  if (/\b(test|failing|pytest|vitest|jest|테스트|실패)\b/i.test(prompt)) return "fix";
  if (/\b(debug|diagnose|왜|원인|진단)\b/i.test(prompt)) return "diagnose";
  if (/\b(plan|design|architecture|설계|계획)\b/i.test(prompt)) return "plan";
  if (/\b(refactor|fix|change|add|remove|implement|수정|추가|고쳐|구현|리팩터)\b/i.test(prompt)) return "edit";
  if (repoSignals.hasUncommittedChanges && /\b(clean|diff|changes|변경)\b/i.test(lowered)) return "review";
  if (prompt.length > 180 || repoSignals.largeRepo) return "parallel";
  return "chat";
}

function defaultModeForIntent(intent: OmkUxIntent): OmkUxMode {
  if (intent === "explain" || intent === "chat" || intent === "plan") return "plan";
  if (intent === "review" || intent === "diagnose") return "review";
  return "guided";
}

function safetyForMode(mode: OmkUxMode): RoutedPrompt["safety"] {
  if (mode === "plan" || mode === "safe" || mode === "review") return "read-only";
  if (mode === "autopilot") return "workspace-write";
  return "ask-before-edit";
}

function executionForMode(mode: OmkUxMode): RoutedPrompt["execution"] {
  if (mode === "plan" || mode === "safe" || mode === "review") return "plan-only";
  if (mode === "autopilot") return "auto";
  return "guided";
}

function reasonForIntent(intent: OmkUxIntent): string {
  switch (intent) {
    case "fix": return "test or failing-work keywords detected";
    case "review": return "review/audit language detected";
    case "explain": return "explanation request detected";
    case "plan": return "planning/design language detected";
    case "edit": return "code-change language detected";
    case "diagnose": return "debug/diagnosis language detected";
    case "parallel": return "large or complex prompt likely benefits from worker split";
    default: return "default conversational coding task";
  }
}
