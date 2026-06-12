import type {
  ExecutionStrategy,
  UserIntent,
  UserIntentAmbiguitySignal,
  UserIntentLanguage,
  UserIntentTargetSurface,
  UserIntentV2,
} from "../contracts/orchestration.js";
import { analyzeUserIntent } from "./intake.js";

interface IntentAnalyzerInput {
  rawPrompt: string;
  root?: string;
  allowRuntimeRefine?: boolean;
}

interface DomainRule {
  id: string;
  terms: string[];
  targetSurface: UserIntentTargetSurface;
  roles: string[];
}

const OMK_DOMAIN_RULES: DomainRule[] = [
  {
    id: "omk-tui",
    terms: ["tui", "terminal", "터미널", "hud", "cockpit", "콕핏", "화면", "렌더", "renderer", "watch"],
    targetSurface: "tui",
    roles: ["ui-architect", "terminal-ui-reviewer"],
  },
  {
    id: "omk-nlp",
    terms: ["nlp", "의도", "인텐트", "intent", "프롬프트", "분류", "라우팅", "routing"],
    targetSurface: "nlp",
    roles: ["nlp-architect", "evaluator"],
  },
  {
    id: "omk-harness",
    terms: ["harness", "하네스", "executor", "runner", "dag", "taskrunner", "dagexecutor", "runstate", "연결"],
    targetSurface: "harness",
    roles: ["runtime-architect", "integration-reviewer"],
  },
  {
    id: "omk-provider",
    terms: ["provider", "runtime", "kimi", "codex", "deepseek", "openrouter", "mimo"],
    targetSurface: "provider",
    roles: ["runtime-architect"],
  },
  {
    id: "omk-mcp",
    terms: ["mcp", "tool", "tools", "server", "서버", "도구"],
    targetSurface: "mcp",
    roles: ["integration-reviewer"],
  },
  {
    id: "omk-tests",
    terms: ["test", "tests", "검증", "테스트", "quality gate", "gate"],
    targetSurface: "tests",
    roles: ["qa"],
  },
  {
    id: "omk-docs",
    terms: ["doc", "docs", "문서", "readme", "guide", "설명"],
    targetSurface: "docs",
    roles: ["docs"],
  },
];

const ADMIN_COMMANDS = new Set([
  "agent",
  "auth",
  "browser",
  "chat",
  "checkpoint",
  "cockpit",
  "consent",
  "doctor",
  "goal",
  "hud",
  "init",
  "mcp",
  "menu",
  "model",
  "parallel",
  "plan",
  "review",
  "run",
  "skill",
  "status",
  "team",
  "verify",
]);

const EXECUTION_VERBS = [
  "run",
  "execute",
  "start",
  "launch",
  "open",
  "watch",
  "실행",
  "켜",
  "열어",
  "돌려",
  "확인해",
  "봐줘",
];

const IMPROVEMENT_TERMS = [
  "improve",
  "implement",
  "refactor",
  "fix",
  "feature",
  "기능",
  "개선",
  "수정",
  "구현",
  "고도화",
];

const FILE_REFERENCE_PATTERN = /(?:^|[\s"'`(])((?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?=$|[\s"'`),:])/g;
const BACKTICK_PATTERN = /`([^`]+)`/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort((a, b) => a.localeCompare(b));
}

function uniquePreserveOrder<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function detectLanguage(rawPrompt: string): UserIntentLanguage {
  const hasKorean = /[\u3131-\u318e\uac00-\ud7a3]/u.test(rawPrompt);
  const hasEnglish = /[A-Za-z]/u.test(rawPrompt);
  if (hasKorean && hasEnglish) return "mixed";
  if (hasKorean) return "ko";
  if (hasEnglish) return "en";
  return "unknown";
}

function matchesPromptTerm(rawPrompt: string, term: string): boolean {
  if (/^[\x00-\x7F]+$/u.test(term)) {
    const boundaryTerm = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(term)}(?=$|[^A-Za-z0-9_])`, "iu");
    return boundaryTerm.test(rawPrompt);
  }
  return rawPrompt.toLowerCase().includes(term.toLowerCase());
}

function matchDomainRules(rawPrompt: string): {
  matchedRules: string[];
  domainTerms: string[];
  targetSurfaces: UserIntentTargetSurface[];
  roles: string[];
} {
  const matchedRules: string[] = [];
  const domainTerms: string[] = [];
  const targetSurfaces: UserIntentTargetSurface[] = [];
  const roles: string[] = [];

  for (const rule of OMK_DOMAIN_RULES) {
    const matchedTerms = rule.terms.filter((term) => matchesPromptTerm(rawPrompt, term));
    if (matchedTerms.length === 0) continue;
    matchedRules.push(rule.id);
    domainTerms.push(...matchedTerms);
    targetSurfaces.push(rule.targetSurface);
    roles.push(...rule.roles);
  }

  if (/\bomk\b|open[_-]?multi[_-]?agent[_-]?kit/i.test(rawPrompt)) {
    matchedRules.push("omk-repo");
    domainTerms.push("omk");
    targetSurfaces.push("cli");
  }

  return {
    matchedRules: uniquePreserveOrder(matchedRules),
    domainTerms: uniqueSorted(domainTerms),
    targetSurfaces: uniquePreserveOrder(targetSurfaces),
    roles: uniquePreserveOrder(roles),
  };
}

function extractFiles(rawPrompt: string): string[] {
  const files: string[] = [];
  let match: RegExpExecArray | null;
  FILE_REFERENCE_PATTERN.lastIndex = 0;
  while ((match = FILE_REFERENCE_PATTERN.exec(rawPrompt)) !== null) {
    files.push(match[1]);
  }
  BACKTICK_PATTERN.lastIndex = 0;
  while ((match = BACKTICK_PATTERN.exec(rawPrompt)) !== null) {
    const value = match[1].trim();
    if (/(?:^|\/)[\w.-]+\.[A-Za-z0-9]+$/u.test(value)) {
      files.push(value);
    }
  }
  return uniqueSorted(files);
}

function looksLikeCommand(value: string): boolean {
  return /^(?:omk|open-multi-agent-kit|npm|pnpm|yarn|node|npx|tsx|tsc|git)\b/u.test(value.trim());
}

function maskSensitiveText(value: string): string {
  return value
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*=)([^\s]+)/gu, "$1***REDACTED***")
    .replace(/\b((?:--?)(?:api[-_]?key|token|secret|password|credential)(?:=|\s+))("[^"]+"|'[^']+'|`[^`]+`|[^\s]+)/giu, "$1***REDACTED***")
    .replace(/\b(ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{12,})\b/gu, "***REDACTED***")
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s/]+(@)/gu, "$1***REDACTED***$2");
}

function extractCommands(rawPrompt: string): string[] {
  const commands: string[] = [];
  let match: RegExpExecArray | null;
  BACKTICK_PATTERN.lastIndex = 0;
  while ((match = BACKTICK_PATTERN.exec(rawPrompt)) !== null) {
    const value = match[1].trim();
    if (looksLikeCommand(value)) commands.push(maskSensitiveText(value));
  }
  for (const line of rawPrompt.split(/\r?\n/u)) {
    const trimmed = line.trim().replace(/^(?:[-*]|\d+[.)])\s*/u, "");
    if (looksLikeCommand(trimmed)) commands.push(maskSensitiveText(trimmed));
  }
  return uniquePreserveOrder(commands);
}

function firstCommandToken(rawPrompt: string): { command?: string; explicitOmk: boolean } {
  const tokens = rawPrompt.trim().toLowerCase().split(/\s+/u);
  if (tokens.length === 0) return { explicitOmk: false };
  if (tokens[0] === "omk" || tokens[0] === "open-multi-agent-kit") {
    return { command: tokens[1], explicitOmk: true };
  }
  return { command: tokens[0], explicitOmk: false };
}

function detectAdminCommandAmbiguity(rawPrompt: string, extractedCommands: string[]): UserIntentAmbiguitySignal[] {
  const signals: UserIntentAmbiguitySignal[] = [];
  const lowered = rawPrompt.toLowerCase();
  const { command, explicitOmk } = firstCommandToken(rawPrompt);
  if (!command || !ADMIN_COMMANDS.has(command)) return signals;

  const hasExecutionVerb = EXECUTION_VERBS.some((verb) => lowered.includes(verb.toLowerCase()));
  const hasImprovementTerm = IMPROVEMENT_TERMS.some((term) => lowered.includes(term.toLowerCase()));
  const hasCliShape = explicitOmk || extractedCommands.some((cmd) => cmd.toLowerCase().startsWith("omk "));

  if (hasImprovementTerm) {
    signals.push({
      kind: "admin-command",
      severity: "low",
      message: `Prompt mentions OMK command "${command}" as a feature/code target, not a direct CLI invocation.`,
    });
    return signals;
  }

  if (hasCliShape || hasExecutionVerb) {
    signals.push({
      kind: "admin-command",
      severity: "high",
      message: `Prompt starts with OMK command "${command}" and looks executable; route to CLI command handling unless the user asks for code changes.`,
    });
    return signals;
  }

  signals.push({
    kind: "admin-command",
    severity: "medium",
    message: `Prompt starts with OMK command "${command}" but execution intent is unclear.`,
  });

  return signals;
}

function inferRoutingHints(intent: UserIntent, targetSurfaces: UserIntentTargetSurface[], rawPrompt: string): UserIntentV2["routingHints"] {
  const preferredExecutionStrategy: ExecutionStrategy = intent.parallelizable ? "parallel" : "sequential";
  const requireHarness = targetSurfaces.includes("harness");
  const requireEvidence =
    intent.needsTesting ||
    /\bevidence\b|\bgate\b|검증|테스트|증거/u.test(rawPrompt);
  return {
    preferredExecutionStrategy,
    requireEvidence,
    requireHarness,
  };
}

function estimateConfidence(input: {
  intent: UserIntent;
  matchedRules: string[];
  targetSurfaces: UserIntentTargetSurface[];
  extractedFiles: string[];
  extractedCommands: string[];
  ambiguitySignals: UserIntentAmbiguitySignal[];
}): number {
  let confidence = 0.52;
  if (input.intent.taskType !== "general") confidence += 0.12;
  if (input.intent.complexity !== "simple") confidence += 0.08;
  if (input.matchedRules.length > 0) confidence += 0.12;
  if (input.targetSurfaces.length > 0) confidence += 0.08;
  if (input.extractedFiles.length > 0 || input.extractedCommands.length > 0) confidence += 0.05;
  if (input.ambiguitySignals.some((signal) => signal.severity === "high")) confidence -= 0.2;
  if (input.ambiguitySignals.some((signal) => signal.severity === "medium")) confidence -= 0.1;
  return Math.round(Math.max(0.2, Math.min(0.95, confidence)) * 100) / 100;
}

export function analyzeUserIntentFast(rawPrompt: string): UserIntentV2 {
  const baseIntent = analyzeUserIntent(rawPrompt);
  const domain = matchDomainRules(rawPrompt);
  const extractedFiles = extractFiles(rawPrompt);
  const extractedCommands = extractCommands(rawPrompt);
  const ambiguitySignals = detectAdminCommandAmbiguity(rawPrompt, extractedCommands);
  const requiredRoles = uniquePreserveOrder([...baseIntent.requiredRoles, ...domain.roles]);
  const matchedRules = uniquePreserveOrder([`legacy:${baseIntent.taskType}`, ...domain.matchedRules]);
  const targetSurfaces = domain.targetSurfaces;
  const routingHints = inferRoutingHints(baseIntent, targetSurfaces, rawPrompt);
  const confidence = estimateConfidence({
    intent: baseIntent,
    matchedRules,
    targetSurfaces,
    extractedFiles,
    extractedCommands,
    ambiguitySignals,
  });

  return {
    ...baseIntent,
    requiredRoles,
    confidence,
    matchedRules,
    language: detectLanguage(rawPrompt),
    domainTerms: domain.domainTerms,
    targetSurfaces,
    extractedFiles,
    extractedCommands,
    ambiguitySignals,
    routingHints,
    rationale: [
      baseIntent.rationale,
      `confidence=${confidence}`,
      targetSurfaces.length > 0 ? `surfaces=[${targetSurfaces.join(", ")}]` : "",
      ambiguitySignals.length > 0 ? `ambiguity=[${ambiguitySignals.map((signal) => `${signal.kind}:${signal.severity}`).join(", ")}]` : "",
    ].filter(Boolean).join("; "),
  };
}

export async function analyzeUserIntentV2(input: IntentAnalyzerInput): Promise<UserIntentV2> {
  const fast = analyzeUserIntentFast(input.rawPrompt);

  if (!input.allowRuntimeRefine || fast.confidence >= 0.75) {
    return fast;
  }

  // Runtime refinement is intentionally not enabled in the first V2 slice. Keep
  // deterministic analysis as the stable offline path and make the decision
  // visible for callers that want to add provider-backed refinement later.
  return {
    ...fast,
    matchedRules: uniquePreserveOrder([...fast.matchedRules, "runtime-refine:skipped"]),
    rationale: `${fast.rationale}; runtimeRefine=skipped`,
  };
}
