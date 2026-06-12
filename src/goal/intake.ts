import type { GoalSpec, GoalRisk, RiskLevel, SuccessCriterion } from "../contracts/goal.js";
import type { UserIntent, TaskType } from "../contracts/orchestration.js";
import { buildIntentFrame } from "./intent-frame.js";

function generateGoalId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

function deriveTitle(rawPrompt: string): string {
  const firstSentence = rawPrompt.split(/[.!?]/, 1)[0]?.trim() ?? rawPrompt.trim();
  return firstSentence.slice(0, 120);
}

function deriveObjective(rawPrompt: string): string {
  const firstPara = rawPrompt.split(/\n\n/)[0]?.trim() ?? rawPrompt.trim();
  return firstPara;
}

function inferSuccessCriteria(objective: string): SuccessCriterion[] {
  const criteria: SuccessCriterion[] = [];
  const lowered = objective.toLowerCase();

  // Heuristic patterns for common engineering tasks
  const patterns: Array<{ trigger: string[]; description: string }> = [
    {
      trigger: ["add", "implement", "introduce", "create", "build"],
      description: "The new functionality is implemented and integrated into the codebase",
    },
    {
      trigger: ["test", "verify", "validate", "check"],
      description: "Tests pass and the change is verified against acceptance criteria",
    },
    {
      trigger: ["fix", "bug", "issue", "error", "crash"],
      description: "The reported issue is reproduced, fixed, and verified with a regression test",
    },
    {
      trigger: ["refactor", "clean", "restructure"],
      description: "Code is restructured without changing external behavior and all tests pass",
    },
    {
      trigger: ["doc", "document", "readme", "guide"],
      description: "Documentation is updated and accurately reflects the current state",
    },
  ];

  for (const pattern of patterns) {
    if (pattern.trigger.some((t) => lowered.includes(t))) {
      criteria.push({
        id: `criterion-${criteria.length + 1}`,
        description: pattern.description,
        requirement: criteria.length === 0 ? "required" : "optional",
        weight: criteria.length === 0 ? 1.0 : 0.5,
        inferred: true,
      });
    }
  }

  if (criteria.length === 0) {
    criteria.push({
      id: "criterion-1",
      description: "The objective is completed and the result is demonstrable",
      requirement: "required",
      weight: 1.0,
      inferred: true,
    });
  }

  return criteria;
}

function deriveRiskLevel(objective: string): RiskLevel {
  const lowered = objective.toLowerCase();
  if (
    lowered.includes("production") ||
    lowered.includes("deploy") ||
    lowered.includes("migrate") ||
    lowered.includes("database") ||
    lowered.includes("security")
  ) {
    return "high";
  }
  if (
    lowered.includes("refactor") ||
    lowered.includes("clean") ||
    lowered.includes("style") ||
    lowered.includes("format")
  ) {
    return "low";
  }
  return "medium";
}

export interface NormalizedGoalInput {
  rawPrompt: string;
  title?: string;
  objective?: string;
  successCriteria?: SuccessCriterion[];
  constraints?: string[];
  nonGoals?: string[];
  risks?: GoalRisk[];
  expectedArtifacts?: Array<{ name: string; path?: string }>;
  riskLevel?: RiskLevel;
}

export interface ParsedGoalPrompt {
  rawPrompt: string;
  objective: string;
  successCriteria: string[];
  nonGoals: string[];
  risks: string[];
  expectedArtifacts: Array<{ name: string; path?: string }>;
  constraints: string[];
  intentFrame: import("../contracts/goal.js").IntentFrame;
}

/**
 * Extract structured fields from a raw goal prompt using regex-based heuristics.
 * Supports Markdown-style headers and labelled sections.
 */
export function normalizeGoalPrompt(rawPrompt: string): ParsedGoalPrompt {
  const objective = deriveObjective(rawPrompt);

  // Extract sections by common headers or labels
  const successCriteria = extractListSection(rawPrompt, [
    /(?:^|\n)(?:#{1,3}\s*)?(?:success\s*criteria|acceptance\s*criteria|criteria|성공\s*기준|완료\s*기준|수용\s*기준)(?:\s*[:-])?\s*\n?/i,
    /(?:^|\n)(?:success\s*criteria|acceptance\s*criteria|성공\s*기준|완료\s*기준|수용\s*기준):\s*/i,
  ]);

  const nonGoals = extractListSection(rawPrompt, [
    /(?:^|\n)(?:#{1,3}\s*)?(?:non[-\s]?goals|out of scope|exclusions|비목표|범위\s*제외|제외\s*사항)(?:\s*[:-])?\s*\n?/i,
  ]);

  const risks = extractListSection(rawPrompt, [
    /(?:^|\n)(?:#{1,3}\s*)?(?:risks|risk factors|concerns|위험|리스크|우려\s*사항)(?:\s*[:-])?\s*\n?/i,
  ]);

  const constraints = extractListSection(rawPrompt, [
    /(?:^|\n)(?:#{1,3}\s*)?(?:constraints|limitations|restrictions|제약|제한|필수\s*조건)(?:\s*[:-])?\s*\n?/i,
  ]);

  const expectedArtifacts = extractArtifactSection(rawPrompt);

  const intentFrame = buildIntentFrame(rawPrompt, {
    constraints,
    successCriteria,
    expectedArtifacts,
  });

  return {
    rawPrompt,
    objective,
    successCriteria,
    nonGoals,
    risks,
    expectedArtifacts,
    constraints,
    intentFrame,
  };
}

function extractListSection(text: string, headerPatterns: RegExp[]): string[] {
  for (const pattern of headerPatterns) {
    const match = pattern.exec(text);
    if (match) {
      const start = match.index + match[0].length;
      const remainder = text.slice(start);
      // Capture until next blank line followed by a non-list line, or next header, or end
      const lines: string[] = [];
      const lineRe = /.*(?:\n|$)/g;
      lineRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = lineRe.exec(remainder)) !== null) {
        const line = m[0];
        if (/^#{1,3}\s/.test(line) || (lines.length > 0 && /^\s*$/.test(line) && !/^\s*(?:[-*]|\d+[.)])/.test(remainder.slice(lineRe.lastIndex)))) {
          break;
        }
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        // Stop if we hit a line that looks like a new header or non-list after we've started
        if (lines.length > 0 && /^[A-Z][a-zA-Z\s]+[:-]\s*$/.test(trimmed)) {
          break;
        }
        const listItem = trimmed.replace(/^(?:[-*]|\d+[.)])\s*/, "").trim();
        if (listItem.length > 0) {
          lines.push(listItem);
        }
        if (lineRe.lastIndex >= remainder.length) break;
      }
      if (lines.length > 0) return lines;
    }
  }
  return [];
}

function extractArtifactSection(text: string): Array<{ name: string; path?: string }> {
  const artifacts: Array<{ name: string; path?: string }> = [];
  const headerPatterns = [
    /(?:^|\n)(?:#{1,3}\s*)?(?:artifacts|expected artifacts|deliverables|outputs|산출물|결과물|출력)(?:\s*[:-])?\s*\n?/i,
  ];
  for (const pattern of headerPatterns) {
    const match = pattern.exec(text);
    if (match) {
      const start = match.index + match[0].length;
      const remainder = text.slice(start);
      const lineRe = /.*(?:\n|$)/g;
      lineRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = lineRe.exec(remainder)) !== null) {
        const line = m[0];
        if (/^#{1,3}\s/.test(line)) break;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (/^[A-Z][a-zA-Z\s]+[:-]\s*$/.test(trimmed)) break;
        const cleaned = trimmed.replace(/^(?:[-*]|\d+[.)])\s*/, "").trim();
        // Try to extract a file path like `src/foo.ts` or `path/to/file.md`
        const pathMatch = cleaned.match(/`([^`]+\.[a-zA-Z0-9]+)`/);
        const name = cleaned.split(/[:-]/)[0].trim();
        if (name.length > 0) {
          artifacts.push({
            name,
            path: pathMatch ? pathMatch[1] : undefined,
          });
        }
        if (lineRe.lastIndex >= remainder.length) break;
      }
      if (artifacts.length > 0) return artifacts;
    }
  }
  return artifacts;
}

export function normalizeGoal(input: NormalizedGoalInput): GoalSpec {
  const now = new Date().toISOString();
  const title = input.title ?? deriveTitle(input.rawPrompt);
  const objective = input.objective ?? deriveObjective(input.rawPrompt);
  const criteria = input.successCriteria ?? inferSuccessCriteria(objective);
  const riskLevel = input.riskLevel ?? deriveRiskLevel(objective);
  const goalId = `${slugifyTitle(title)}-${generateGoalId()}`;
  const constraints = input.constraints ?? [];
  const expectedArtifacts = input.expectedArtifacts ?? [];
  const intentFrame = buildIntentFrame(input.rawPrompt, {
    constraints,
    successCriteria: criteria.map((criterion) => criterion.description),
    expectedArtifacts,
  });

  return {
    schemaVersion: 1,
    goalId,
    title,
    rawPrompt: input.rawPrompt,
    objective,
    successCriteria: criteria.map((c) => ({ ...c, inferred: c.inferred ?? false })),
    constraints: constraints.map((c, i) => ({ id: `constraint-${i + 1}`, description: c })),
    nonGoals: input.nonGoals ?? [],
    risks: input.risks ?? [],
    expectedArtifacts: expectedArtifacts.map((a) => ({ name: a.name, path: a.path })),
    status: "draft",
    riskLevel,
    planRevision: 0,
    createdAt: now,
    updatedAt: now,
    runIds: [],
    intentFrame,
    actionAtoms: intentFrame.actionAtoms,
  };
}

/**
 * Codex-style entrypoint: create a GoalSpec from a raw prompt with structured parsing.
 */
export function createGoalSpec(rawPrompt: string, overrides?: Partial<Omit<NormalizedGoalInput, "rawPrompt">>): GoalSpec {
  const parsed = normalizeGoalPrompt(rawPrompt);
  const parsedSuccessCriteria = parsed.successCriteria.length > 0
    ? parsed.successCriteria.map((desc, i) => ({
      id: `criterion-${i + 1}`,
      description: desc,
      requirement: i === 0 ? "required" as const : "optional" as const,
      weight: i === 0 ? 1.0 : 0.5,
      inferred: false,
    }))
    : undefined;
  return normalizeGoal({
    rawPrompt,
    title: overrides?.title ?? deriveTitle(rawPrompt),
    objective: overrides?.objective ?? parsed.objective,
    successCriteria: overrides?.successCriteria ?? parsedSuccessCriteria,
    constraints: overrides?.constraints ?? parsed.constraints,
    nonGoals: overrides?.nonGoals ?? parsed.nonGoals,
    risks: overrides?.risks ?? parsed.risks.map((desc, i) => ({
      id: `risk-${i + 1}`,
      description: desc,
      level: deriveRiskLevel(desc),
    })),
    expectedArtifacts: overrides?.expectedArtifacts ?? parsed.expectedArtifacts,
    riskLevel: overrides?.riskLevel,
  });
}

export function updateGoalStatus(
  spec: GoalSpec,
  status: GoalSpec["status"],
  options?: { planRevision?: number; runId?: string }
): GoalSpec {
  const updated: GoalSpec = {
    ...spec,
    status,
    updatedAt: new Date().toISOString(),
  };
  if (options?.planRevision !== undefined) {
    updated.planRevision = options.planRevision;
  }
  if (options?.runId && !updated.runIds.includes(options.runId)) {
    updated.runIds = [...updated.runIds, options.runId];
  }
  return updated;
}

/* ── Intent Analysis ─────────────────────────────────────────────────────── */

interface TaskTypeRule {
  type: TaskType;
  keywords: string[];
  weight: number;
}

const TASK_TYPE_RULES: TaskTypeRule[] = [
  { type: "explore", keywords: ["find", "search", "where", "how does", "what is", "explain", "understand", "map", "discover", "trace", "locate", "browser", "current page", "web page", "active tab", "dom", "chrome", "탐색", "찾기", "어디", "뭔지", "설명"], weight: 1 },
  { type: "implement", keywords: ["add", "implement", "create", "build", "introduce", "support", "feature", "develop", "write", "구현", "추가", "만들기", "작성", "개발"], weight: 1 },
  { type: "bugfix", keywords: ["fix", "bug", "error", "crash", "broken", "issue", "regression", "fails", "not working", "버그", "오류", "수정", "고장", "실패"], weight: 1 },
  { type: "refactor", keywords: ["refactor", "clean", "restructure", "rename", "extract", "simplify", "organize", "move", "리팩토링", "정리", "단순화"], weight: 1 },
  { type: "research", keywords: ["research", "investigate", "compare", "evaluate", "survey", "study", "analyze", "benchmark", "조사", "비교", "분석", "연구"], weight: 1 },
  { type: "review", keywords: ["review", "audit", "check", "look at", "inspect", "assess", "critical", "risk", "issue", "리뷰", "검토", "점검", "크리티컬", "심각", "위험", "리스크", "이슈"], weight: 1 },
  { type: "plan", keywords: ["plan", "design", "architecture", "strategy", "roadmap", "structure", "blueprint", "설계", "계획", "구조"], weight: 1 },
  { type: "test", keywords: ["test", "verify", "validate", "coverage", "unit test", "e2e", "integration test", "regression", "테스트", "검증", "커버리지"], weight: 1 },
  { type: "document", keywords: ["doc", "readme", "guide", "document", "changelog", "comment", "wiki", "문서", "가이드", "주석"], weight: 1 },
  { type: "migrate", keywords: ["migrate", "upgrade", "update version", "migration", "bump", "deprecate", "switch to", "move to", "마이그레이션", "업그레이드", "버전업"], weight: 1 },
  { type: "security", keywords: ["security", "secret", "auth", "permission", "vulnerability", "credential", "token", "encrypt", "sanitize", "xss", "csrf", "injection", "보안", "인증", "권한", "취약점"], weight: 1 },
];

const ROLE_TEMPLATES: Record<TaskType, string[]> = {
  explore: ["explorer", "researcher"],
  implement: ["planner", "coder", "reviewer", "qa"],
  bugfix: ["explorer", "debugger", "coder", "tester", "reviewer"],
  refactor: ["explorer", "planner", "coder", "qa", "reviewer"],
  research: ["researcher", "explorer", "architect"],
  review: ["reviewer", "architect"],
  plan: ["architect", "planner", "router"],
  test: ["tester", "debugger", "qa"],
  document: ["explorer", "researcher"],
  migrate: ["architect", "planner", "coder", "qa"],
  security: ["security", "reviewer", "architect"],
  general: ["planner", "coder", "reviewer"],
};

const WRITE_KEYWORDS = ["write", "edit", "implement", "fix", "create", "delete", "modify", "add", "build", "change", "update", "patch", "migrate", "refactor", "rename", "move", "extract", "코드작성", "수정", "구현", "추가", "삭제", "변경"];

const READ_ONLY_DIRECTIVES = [
  "read-only",
  "read only",
  "readonly",
  "no edits",
  "no edit",
  "do not edit",
  "don't edit",
  "do not modify",
  "don't modify",
  "no file changes",
  "without changing files",
  "without edits",
  "읽기 전용",
  "수정하지 마",
  "수정 없이",
  "편집하지 마",
  "변경하지 마",
  "파일 변경 없이",
];

const RESEARCH_KEYWORDS = ["docs", "official", "paper", "api", "reference", "current", "latest", "version", "release notes", "changelog", "specification", "rfc", "documentation", "browser", "current page", "web page", "active tab", "dom", "chrome", "문서", "공식", "최신", "버전", "스펙"];

const SECURITY_KEYWORDS = ["security", "secret", "auth", "permission", "vulnerability", "credential", "token", "encrypt", "sanitize", "xss", "csrf", "injection", "password", "api key", "critical", "risk", "보안", "인증", "권한", "취약점", "토큰", "크리티컬", "심각", "위험", "리스크"];

const TEST_KEYWORDS = ["test", "verify", "validate", "coverage", "unit test", "e2e", "integration", "regression", "jest", "mocha", "pytest", "테스트", "검증", "커버리지"];

const DESIGN_KEYWORDS = ["ui", "ux", "design", "component", "frontend", "react", "vue", "angular", "css", "tailwind", "styled", "screen", "page", "layout", "visual", "brand", "디자인", "컴포넌트", "화면", "프론트"];

const LANGUAGE_FRAMEWORK_KEYWORDS: Array<{ id: string; keywords: string[]; roles: string[] }> = [
  { id: "typescript", keywords: ["typescript", "ts", ".ts", "tsx", "type"], roles: ["coder"] },
  { id: "python", keywords: ["python", "py", ".py", "django", "flask", "fastapi"], roles: ["coder"] },
  { id: "react", keywords: ["react", "jsx", "tsx", "hook", "component"], roles: ["coder", "designer"] },
  { id: "vue", keywords: ["vue", "nuxt", ".vue"], roles: ["coder", "designer"] },
  { id: "angular", keywords: ["angular", ".component.ts", "ng-"], roles: ["coder", "designer"] },
  { id: "nextjs", keywords: ["next.js", "nextjs", "app router", "pages router"], roles: ["coder"] },
  { id: "nodejs", keywords: ["node.js", "nodejs", "express", "nest"], roles: ["coder"] },
  { id: "go", keywords: ["golang", "go.mod", ".go"], roles: ["coder"] },
  { id: "rust", keywords: ["rust", "cargo", ".rs"], roles: ["coder"] },
];

const TEST_FRAMEWORK_KEYWORDS: Array<{ id: string; keywords: string[] }> = [
  { id: "jest", keywords: ["jest", "describe", "it(", "test("] },
  { id: "mocha", keywords: ["mocha", "chai"] },
  { id: "vitest", keywords: ["vitest"] },
  { id: "pytest", keywords: ["pytest", "def test_"] },
  { id: "playwright", keywords: ["playwright", "e2e"] },
  { id: "cypress", keywords: ["cypress"] },
];

function detectLanguageFrameworks(text: string): Array<{ id: string; roles: string[] }> {
  const lowered = text.toLowerCase();
  const detected: Array<{ id: string; roles: string[] }> = [];
  for (const fw of LANGUAGE_FRAMEWORK_KEYWORDS) {
    if (fw.keywords.some((kw) => lowered.includes(kw.toLowerCase()))) {
      detected.push({ id: fw.id, roles: fw.roles });
    }
  }
  return detected;
}

function detectTestFrameworks(text: string): string[] {
  const lowered = text.toLowerCase();
  const detected: string[] = [];
  for (const tf of TEST_FRAMEWORK_KEYWORDS) {
    if (tf.keywords.some((kw) => lowered.includes(kw.toLowerCase()))) {
      detected.push(tf.id);
    }
  }
  return detected;
}

function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) return true;
  const questionStarters = [
    "how", "what", "why", "when", "where", "who", "which", "can you", "could you",
    "is there", "are there", "does", "do", "will", "would", "should",
    "어떻게", "뭐", "무엇", "왜", "언제", "어디", "누구", "which", "can you",
  ];
  const firstWords = trimmed.toLowerCase().split(/[\s,]+/).slice(0, 3).join(" ");
  return questionStarters.some((q) => firstWords.startsWith(q.toLowerCase()));
}

function detectDependencyChains(text: string): string[] {
  const chains: string[] = [];
  const patterns = [
    /(\w+)\s+(?:depends? on|requires?|needs?)\s+(\w+)/gi,
    /(?:modify|change|update|fix)\s+(\w+).*?(?:and|as well as)\s+(\w+)/gi,
    /(\w+)\s+(?:and|&)\s+(\w+)\s+(?:should|need|must)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      chains.push(`${match[1]} -> ${match[2]}`);
    }
  }
  return chains;
}

function scoreTaskTypes(text: string): Array<{ type: TaskType; score: number }> {
  const lowered = text.toLowerCase();
  const scores: Array<{ type: TaskType; score: number }> = [];
  for (const rule of TASK_TYPE_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (lowered.includes(kw.toLowerCase())) {
        score += rule.weight;
      }
    }
    if (score > 0) scores.push({ type: rule.type, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function countFileReferences(text: string): number {
  const patterns = [
    // File paths: src/foo.ts, ./bar.js, path/to/file.md
    /(?:[\w-]+\/)+[\w-]+\.[a-zA-Z0-9]+/g,
    // Quoted file names: `src/foo.ts`, "config.json"
    /[`"']([\w./-]+\.[a-zA-Z0-9]+)[`"']/g,
    // Directory references: src/, lib/, components/
    /\b(?:src|lib|app|components|pages|tests?|specs?|docs?)\/[\w/]+/g,
  ];
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

function countConcepts(text: string): number {
  const lowered = text.toLowerCase();
  const conceptMarkers = ["and", "also", "additionally", "furthermore", "plus", "besides", "moreover", "또한", "그리고", "추가로"];
  let count = 1;
  for (const marker of conceptMarkers) {
    const regex = new RegExp(`\\b${marker}\\b`, "gi");
    const matches = lowered.match(regex);
    if (matches) count += matches.length;
  }
  return count;
}

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  const lowered = text.toLowerCase();
  return keywords.some((kw) => lowered.includes(kw.toLowerCase()));
}

function hasReadOnlyDirective(text: string): boolean {
  return hasAnyKeyword(text, READ_ONLY_DIRECTIVES);
}

function inferComplexity(text: string): "simple" | "moderate" | "complex" {
  const fileRefs = countFileReferences(text);
  const concepts = countConcepts(text);
  const length = text.length;

  if (
    text.toLowerCase().includes("architecture") ||
    text.toLowerCase().includes("migrate") ||
    text.toLowerCase().includes("security") ||
    text.toLowerCase().includes("refactor entire") ||
    text.toLowerCase().includes("redesign") ||
    fileRefs >= 6 ||
    (concepts >= 4 && length > 300)
  ) {
    return "complex";
  }
  if (fileRefs >= 3 || concepts >= 3 || length > 150) {
    return "moderate";
  }
  return "simple";
}

function estimateWorkers(intent: UserIntent): number {
  if (!intent.parallelizable) return 1;

  const base =
    intent.complexity === "simple" ? 1 :
    intent.complexity === "moderate" ? 2 :
    3;

  // Boost for implementation / refactor / migration with many file references
  if (["implement", "refactor", "migrate", "bugfix"].includes(intent.taskType)) {
    return Math.min(6, base + 1);
  }

  // Research and review tasks can fan out more
  if (["research", "review", "explore"].includes(intent.taskType)) {
    return Math.min(6, base + 2);
  }

  return Math.min(6, base);
}

function isParallelizable(taskType: TaskType, complexity: string, text: string): boolean {
  if (taskType === "explore" || taskType === "research" || taskType === "review") return true;
  if (taskType === "implement" && complexity !== "simple") return true;
  if (taskType === "refactor" && complexity !== "simple") return true;
  if (taskType === "bugfix" && text.toLowerCase().includes("multiple")) return true;
  if (taskType === "test" && text.toLowerCase().includes("coverage")) return true;
  return false;
}

/**
 * Analyze a raw user prompt to determine intent, complexity, required roles,
 * and optimal parallel distribution strategy.
 */
export function analyzeUserIntent(rawPrompt: string): UserIntent {
  const scores = scoreTaskTypes(rawPrompt);
  let taskType = scores[0]?.type ?? "general";
  const complexity = inferComplexity(rawPrompt);
  const readOnly = hasReadOnlyDirective(rawPrompt) || !hasAnyKeyword(rawPrompt, WRITE_KEYWORDS);
  const needsResearch = hasAnyKeyword(rawPrompt, RESEARCH_KEYWORDS);
  const needsSecurityReview = hasAnyKeyword(rawPrompt, SECURITY_KEYWORDS);
  const needsTesting = hasAnyKeyword(rawPrompt, TEST_KEYWORDS);
  const needsDesignReview = hasAnyKeyword(rawPrompt, DESIGN_KEYWORDS);
  const parallelizable = isParallelizable(taskType, complexity, rawPrompt);

  // Override to explore/research if the prompt is clearly a question
  if (isQuestion(rawPrompt) && (taskType === "general" || taskType === "implement")) {
    taskType = needsResearch ? "research" : "explore";
  }

  const baseRoles = [...(ROLE_TEMPLATES[taskType] ?? ROLE_TEMPLATES.general)];

  if (needsResearch && !baseRoles.includes("researcher")) {
    baseRoles.push("researcher");
  }
  if (needsSecurityReview && !baseRoles.includes("security")) {
    baseRoles.unshift("security");
  }
  if (needsTesting && !baseRoles.includes("tester")) {
    baseRoles.push("tester");
  }
  if (needsDesignReview && !baseRoles.includes("designer")) {
    baseRoles.push("designer");
  }

  // Add language/framework specific roles
  const detectedFrameworks = detectLanguageFrameworks(rawPrompt);
  for (const fw of detectedFrameworks) {
    for (const role of fw.roles) {
      if (!baseRoles.includes(role)) baseRoles.push(role);
    }
  }

  // Deduplicate while preserving order
  const requiredRoles = baseRoles.filter((r, i) => baseRoles.indexOf(r) === i);

  const detectedTests = detectTestFrameworks(rawPrompt);
  const depChains = detectDependencyChains(rawPrompt);

  const rationaleParts: string[] = [
    `taskType=${taskType} (score=${scores[0]?.score ?? 0})`,
    `complexity=${complexity}`,
    `readOnly=${readOnly}`,
    `parallelizable=${parallelizable}`,
    `roles=[${requiredRoles.join(", ")}]`,
  ];
  if (needsResearch) rationaleParts.push("needsResearch");
  if (needsSecurityReview) rationaleParts.push("needsSecurityReview");
  if (needsTesting) rationaleParts.push("needsTesting");
  if (needsDesignReview) rationaleParts.push("needsDesignReview");
  if (detectedFrameworks.length > 0) rationaleParts.push(`frameworks=[${detectedFrameworks.map((f) => f.id).join(", ")}]`);
  if (detectedTests.length > 0) rationaleParts.push(`testFrameworks=[${detectedTests.join(", ")}]`);
  if (depChains.length > 0) rationaleParts.push(`deps=${depChains.length}`);
  if (isQuestion(rawPrompt)) rationaleParts.push("isQuestion");

  const intent: UserIntent = {
    taskType,
    complexity,
    estimatedWorkers: 0, // filled below
    requiredRoles,
    isReadOnly: readOnly,
    needsResearch,
    needsSecurityReview,
    needsTesting,
    needsDesignReview,
    parallelizable,
    rationale: rationaleParts.join("; "),
  };

  intent.estimatedWorkers = estimateWorkers(intent);
  return intent;
}
