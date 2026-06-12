export type RequestIntent =
  | "status"
  | "resume"
  | "memory_query"
  | "repo_read"
  | "code_edit"
  | "debug_error"
  | "web_research"
  | "plan"
  | "chat"
  | "unknown";

export type DebloatRisk = "read" | "write" | "network" | "dangerous";
export type DebloatSandbox = "read-only" | "workspace-write" | "full-access";
export type DebloatFailurePolicy = "required-only" | "strict";

export interface RawPromptEnvelope {
  readonly rawText: string;
  readonly provider?: string;
  readonly model?: string;
  readonly userPayload?: string;
  readonly risk?: DebloatRisk;
  readonly sandbox?: DebloatSandbox;
  readonly executionSelection?: string;
  readonly role?: SignalFrame["role"];
  readonly evidenceRequired?: boolean;
  readonly capabilityEnvelope?: {
    readonly mcpEnabled: readonly string[];
    readonly skillsEnabled: readonly string[];
    readonly toolsEnabled: boolean;
    readonly liveRequired: boolean;
  };
  readonly runtimeStatus?: {
    readonly failedMcpServers: readonly string[];
    readonly connectedMcpServers: readonly string[];
  };
}

export interface SignalFrame {
  readonly userRequest: string;
  readonly provider: string;
  readonly model: string;
  readonly risk: DebloatRisk;
  readonly sandbox: DebloatSandbox;
  readonly executionSelection?: string;
  readonly role: "coordinator" | "planner" | "executor" | "reviewer";
  readonly evidenceRequired: boolean;
  readonly availableMcp: readonly string[];
  readonly availableSkills: readonly string[];
  readonly failedMcp: readonly string[];
}

export interface CapabilitySelection {
  readonly requiredMcp: readonly string[];
  readonly optionalMcp: readonly string[];
  readonly selectedSkills: readonly string[];
  readonly disabledMcp: readonly string[];
}

export interface RuntimeSidecar {
  readonly provider: string;
  readonly model: string;
  readonly intent: RequestIntent;
  readonly risk: DebloatRisk;
  readonly sandbox: DebloatSandbox;
  readonly requiredMcp: readonly string[];
  readonly optionalMcp: readonly string[];
  readonly disabledMcp: readonly string[];
  readonly selectedSkills: readonly string[];
  readonly failurePolicy: DebloatFailurePolicy;
}

export interface DebloatDiagnostics {
  readonly originalChars: number;
  readonly finalChars: number;
  readonly compressionRatio: number;
  readonly removedSections: readonly string[];
  readonly warnings: readonly string[];
}

export interface DebloatedNlpCompileResult {
  readonly modelPrompt: string;
  readonly runtimeSidecar: RuntimeSidecar;
  readonly diagnostics: DebloatDiagnostics;
}

interface FailureResolution {
  readonly failurePolicy: "required-only";
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export function compileBloatToNlp(envelope: RawPromptEnvelope): DebloatedNlpCompileResult {
  const signal = extractSignalFrame(envelope);
  const intent = classifyIntent(signal.userRequest);
  const selection = selectCapabilities({
    intent,
    availableMcp: signal.availableMcp,
    availableSkills: signal.availableSkills,
    failedMcp: signal.failedMcp,
  });
  const failure = resolveFailurePolicy({
    requiredMcp: selection.requiredMcp,
    failedMcp: signal.failedMcp,
  });
  const runtimeSidecar = buildRuntimeSidecar(signal, intent, selection);
  const modelPrompt = failure.blockers.length > 0
    ? renderBlockerPrompt({ signal, intent, blockers: failure.blockers })
    : renderNlpPrompt({ signal, intent, selection, warnings: failure.warnings });
  const diagnostics = validateDebloatedPrompt({
    originalText: envelope.rawText,
    modelPrompt,
    selection,
    signal,
  });

  return {
    modelPrompt,
    runtimeSidecar,
    diagnostics: {
      ...diagnostics,
      warnings: unique([...diagnostics.warnings, ...failure.warnings]),
    },
  };
}

export function extractSignalFrame(envelope: RawPromptEnvelope): SignalFrame {
  const rawText = envelope.rawText;
  return {
    userRequest: normalizePromptText(envelope.userPayload ?? parseUserPayload(rawText)),
    provider: envelope.provider ?? parseLineValue(rawText, "Selected provider") ?? parseLineValue(rawText, "Provider") ?? "auto",
    model: envelope.model ?? parseLineValue(rawText, "Selected model") ?? parseLineValue(rawText, "Model") ?? "auto",
    risk: envelope.risk ?? normalizeRisk(parseLineValue(rawText, "Turn risk")),
    sandbox: envelope.sandbox ?? normalizeSandbox(parseLineValue(rawText, "Sandbox")),
    executionSelection: envelope.executionSelection ?? parseLineValue(rawText, "Execution selection"),
    role: envelope.role ?? normalizeRole(parseLineValue(rawText, "Role")),
    evidenceRequired: envelope.evidenceRequired ?? /Evidence required:\s*true/i.test(rawText),
    availableMcp: unique([
      ...(envelope.capabilityEnvelope?.mcpEnabled ?? []),
      ...parseCapabilityList(rawText, "MCP"),
      ...parseCapabilityList(rawText, "MCP selected"),
    ]),
    availableSkills: unique([
      ...(envelope.capabilityEnvelope?.skillsEnabled ?? []),
      ...parseCapabilityList(rawText, "Skills"),
      ...parseCapabilityList(rawText, "Skills selected"),
    ]),
    failedMcp: unique(envelope.runtimeStatus?.failedMcpServers ?? parseFailedMcp(rawText)),
  };
}

export function classifyIntent(userRequest: string): RequestIntent {
  const text = userRequest.trim().toLowerCase();
  if (/현재\s*상태|상태|status|progress|어때|어디까지|뭐\s*했|진행/.test(text)) return "status";
  if (/이어|resume|계속|이전|마지막|left off|where we left/.test(text)) return "resume";
  if (/기억|memory|remember|잊어|forget|전에/.test(text)) return "memory_query";
  if (/검색|웹|최신|news|github|x에서|찾아봐/.test(text)) return "web_research";
  if (/파일|읽어|구조|repo|repository|코드베이스|찾아/.test(text)) return "repo_read";
  if (/debug|디버그|에러|오류|실패|깨져|터졌/.test(text)) return "debug_error";
  if (/수정|고쳐|구현|패치|edit|fix|implement|refactor/.test(text)) return "code_edit";
  if (/계획|설계|plan|architecture|알고리즘/.test(text)) return "plan";
  return "chat";
}

export function classifyRisk(intent: RequestIntent, userRequest: string): DebloatRisk {
  if (/\brm\s+-rf\b|\bDROP\s+TABLE\b|\bgit\s+push\s+--force\b|\bsudo\b/i.test(userRequest)) return "dangerous";
  if (/\bcurl\b|\bwget\b|\bfetch\b|\bhttp/i.test(userRequest)) return "network";
  if (/\b(edit|fix|implement|refactor|modify|update|create|write|delete|remove)\b/i.test(userRequest)) return "write";
  if (/\b(read|show|list|find|search|grep|cat|ls|status|check)\b/i.test(userRequest)) return "read";
  if (intent === "code_edit" || intent === "debug_error") return "write";
  if (intent === "web_research") return "network";
  if (intent === "repo_read" || intent === "status") return "read";
  return "read";
}

export function selectCapabilities(input: {
  readonly intent: RequestIntent;
  readonly availableMcp: readonly string[];
  readonly availableSkills: readonly string[];
  readonly failedMcp: readonly string[];
}): CapabilitySelection {
  const availableMcp = new Set(input.availableMcp);
  const availableSkills = new Set(input.availableSkills);
  const failedMcp = new Set(input.failedMcp);
  const optionalMcp = (...names: string[]): string[] => names.filter((name) => availableMcp.has(name) && !failedMcp.has(name));
  const selectedSkills = (...names: string[]): string[] => names.filter((name) => availableSkills.has(name));
  const requiredIfAvailable = (...names: string[]): string[] => {
    const found = names.find((name) => availableMcp.has(name) && !failedMcp.has(name));
    return found ? [found] : [];
  };

  switch (input.intent) {
    case "status":
      return {
        requiredMcp: [],
        optionalMcp: optionalMcp("omk-project", "memory"),
        selectedSkills: selectedSkills("omk-context-broker", "omk-project-rules"),
        disabledMcp: input.failedMcp,
      };
    case "resume":
      return {
        requiredMcp: [],
        optionalMcp: optionalMcp("omk-project", "memory", "sqlite"),
        selectedSkills: selectedSkills("agentmemory", "omk-context-broker", "omk-project-rules"),
        disabledMcp: input.failedMcp,
      };
    case "repo_read":
      return {
        requiredMcp: requiredIfAvailable("filesystem-readonly", "filesystem"),
        optionalMcp: optionalMcp("omk-project", "memory"),
        selectedSkills: selectedSkills("omk-repo-explorer", "omk-project-rules"),
        disabledMcp: input.failedMcp,
      };
    case "code_edit":
      return {
        requiredMcp: requiredIfAvailable("filesystem"),
        optionalMcp: optionalMcp("omk-project", "memory", "sqlite"),
        selectedSkills: selectedSkills("omk-flow-feature-dev", "omk-typescript-strict", "omk-quality-gate", "omk-test-debug-loop"),
        disabledMcp: input.failedMcp,
      };
    case "debug_error":
      return {
        requiredMcp: requiredIfAvailable("filesystem"),
        optionalMcp: optionalMcp("omk-project", "memory"),
        selectedSkills: selectedSkills("omk-troubleshooting", "omk-test-debug-loop", "omk-quality-gate"),
        disabledMcp: input.failedMcp,
      };
    case "web_research":
      return {
        requiredMcp: requiredIfAvailable("fetch"),
        optionalMcp: optionalMcp("web-reader", "playwright", "omk-project"),
        selectedSkills: selectedSkills("omk-research-verify"),
        disabledMcp: input.failedMcp,
      };
    case "plan":
      return {
        requiredMcp: [],
        optionalMcp: optionalMcp("omk-project", "memory"),
        selectedSkills: selectedSkills("omk-plan-first", "omk-context-broker", "omk-project-rules"),
        disabledMcp: input.failedMcp,
      };
    default:
      return {
        requiredMcp: [],
        optionalMcp: optionalMcp("omk-project", "memory"),
        selectedSkills: selectedSkills("omk-context-broker"),
        disabledMcp: input.failedMcp,
      };
  }
}

export function resolveFailurePolicy(input: {
  readonly requiredMcp: readonly string[];
  readonly failedMcp: readonly string[];
}): FailureResolution {
  const required = new Set(input.requiredMcp);
  const blockers = input.failedMcp.filter((name) => required.has(name));
  const warnings = input.failedMcp.filter((name) => !required.has(name));
  return { failurePolicy: "required-only", blockers, warnings };
}

export function renderNlpPrompt(input: {
  readonly signal: SignalFrame;
  readonly intent: RequestIntent;
  readonly selection: CapabilitySelection;
  readonly warnings: readonly string[];
}): string {
  const lines = [
    "You are the OMK root coordinator.",
    "",
    `User request: ${JSON.stringify(input.signal.userRequest)}`,
    "",
    `Intent: ${input.intent}`,
    `Provider: ${input.signal.provider}`,
    `Model: ${input.signal.model}`,
    `Risk: ${input.signal.risk}`,
    `Sandbox: ${input.signal.sandbox}`,
    ...(input.signal.executionSelection ? [`Execution selection: ${input.signal.executionSelection}`] : []),
    "",
    `Required capabilities: ${formatList(input.selection.requiredMcp)}`,
  ];
  if (input.selection.optionalMcp.length > 0) lines.push(`Optional capabilities: ${input.selection.optionalMcp.join(", ")}`);
  if (input.selection.selectedSkills.length > 0) lines.push(`Selected skills: ${input.selection.selectedSkills.join(", ")}`);
  if (input.warnings.length > 0) {
    lines.push("", `Warnings: ${input.warnings.join(", ")} unavailable; continue unless required.`);
  }
  lines.push(
    "",
    "Instructions:",
    "- Answer the user request directly.",
    "- Do not activate unrelated capabilities.",
    "- Treat optional capability failures as warnings.",
    "- If project state is unavailable, say so briefly.",
    "- Keep the answer concise and operational.",
  );
  return clampPrompt(lines.join("\n"), getPromptBudget(input.intent));
}

export function renderBlockerPrompt(input: {
  readonly signal: SignalFrame;
  readonly intent: RequestIntent;
  readonly blockers: readonly string[];
}): string {
  return [
    "You are the OMK root coordinator.",
    "",
    `User request: ${JSON.stringify(input.signal.userRequest)}`,
    `Intent: ${input.intent}`,
    "",
    `Required capability unavailable: ${input.blockers.join(", ")}`,
    "Report this blocker briefly and do not claim completion.",
  ].join("\n");
}

export function validateDebloatedPrompt(input: {
  readonly originalText: string;
  readonly modelPrompt: string;
  readonly selection: CapabilitySelection;
  readonly signal: SignalFrame;
}): DebloatDiagnostics {
  const warnings: string[] = [];
  if (/MUST activate/i.test(input.modelPrompt)) warnings.push("Model prompt still contains MUST activate.");
  if (/MUST use/i.test(input.modelPrompt)) warnings.push("Model prompt still contains MUST use.");
  if (/TurnBegin\(/.test(input.modelPrompt)) warnings.push("Model prompt still contains raw TurnBegin telemetry.");
  if (/StatusUpdate\(/.test(input.modelPrompt)) warnings.push("Model prompt still contains raw StatusUpdate telemetry.");
  const allAvailableLeaked = input.signal.availableMcp.length > 8 && input.signal.availableMcp.every((name) => input.modelPrompt.includes(name));
  if (allAvailableLeaked) warnings.push("All available MCP names leaked into model prompt.");
  if (countOccurrences(input.modelPrompt, input.signal.userRequest) > 1) warnings.push("User payload appears more than once.");
  const originalChars = input.originalText.length;
  const finalChars = input.modelPrompt.length;
  return {
    originalChars,
    finalChars,
    compressionRatio: finalChars / Math.max(originalChars, 1),
    removedSections: [
      "raw telemetry",
      "full capability inventory",
      "duplicated TurnBegin",
      "mandatory all capability directives",
    ],
    warnings,
  };
}

export function getPromptBudget(intent: RequestIntent): number {
  switch (intent) {
    case "status": return 900;
    case "resume": return 1_500;
    case "memory_query": return 1_800;
    case "repo_read": return 2_400;
    case "code_edit": return 3_500;
    case "web_research": return 2_800;
    case "debug_error": return 3_000;
    default: return 1_200;
  }
}

export function filterMcpConfigForRuntime(input: {
  readonly allMcpConfig: Record<string, unknown>;
  readonly sidecar: RuntimeSidecar;
}): { mcpServers: Record<string, unknown> } {
  const allowed = new Set([...input.sidecar.requiredMcp, ...input.sidecar.optionalMcp]);
  const disabled = new Set(input.sidecar.disabledMcp);
  return {
    mcpServers: Object.fromEntries(
      Object.entries(input.allMcpConfig).filter(([name]) => allowed.has(name) && !disabled.has(name))
    ),
  };
}

/**
 * Per-Turn MCP Config Filter (Section 10).
 * Merges user + project MCP configs, then filters by sidecar allowed set.
 * allowed = requiredMcp ∪ optionalMcp − disabledMcp
 */
export function filterMcpConfigForTurn(input: {
  readonly userMcpConfig: Record<string, unknown>;
  readonly projectMcpConfig: Record<string, unknown>;
  readonly sidecar: RuntimeSidecar;
}): { mcpServers: Record<string, unknown> } {
  const merged: Record<string, unknown> = { ...input.projectMcpConfig, ...input.userMcpConfig };
  const allowed = new Set([...input.sidecar.requiredMcp, ...input.sidecar.optionalMcp]);
  const disabled = new Set(input.sidecar.disabledMcp);
  return {
    mcpServers: Object.fromEntries(
      Object.entries(merged).filter(([name]) => allowed.has(name) && !disabled.has(name))
    ),
  };
}

/**
 * Provider Runtime Selector (Section 11).
 * Returns the provider runtime mode: kimi-print ONLY when debugRaw=true.
 * Default is kimi-event (structured event stream).
 */
export type ProviderRuntimeMode = "kimi-event" | "kimi-print";

export function selectProviderRuntime(input: {
  readonly provider: string;
  readonly intent: RequestIntent;
  readonly debugRaw?: boolean;
}): ProviderRuntimeMode {
  if (input.debugRaw === true) return "kimi-print";
  return "kimi-event";
}

export function renderUserFacingRoutingNlp(input: {
  readonly intent: RequestIntent;
  readonly selected: CapabilitySelection;
  readonly ignoredMcpCount: number;
}): string {
  const lines = ["OMK routing", "", `Intent: ${input.intent}`, ""];
  lines.push(`Required MCP: ${formatList(input.selected.requiredMcp)}`);
  if (input.selected.optionalMcp.length > 0) lines.push(`Optional MCP: ${input.selected.optionalMcp.join(", ")}`);
  if (input.selected.selectedSkills.length > 0) lines.push(`Selected skills: ${input.selected.selectedSkills.join(", ")}`);
  lines.push(`Ignored MCP servers: ${input.ignoredMcpCount}`);
  if (input.selected.disabledMcp.length > 0) {
    lines.push(`Warning: ${input.selected.disabledMcp.join(", ")} unavailable and ignored unless required.`);
  }
  return lines.join("\n");
}

function buildRuntimeSidecar(signal: SignalFrame, intent: RequestIntent, selection: CapabilitySelection): RuntimeSidecar {
  return {
    provider: signal.provider,
    model: signal.model,
    intent,
    risk: signal.risk,
    sandbox: signal.sandbox,
    requiredMcp: [...selection.requiredMcp],
    optionalMcp: [...selection.optionalMcp],
    disabledMcp: [...selection.disabledMcp],
    selectedSkills: [...selection.selectedSkills],
    failurePolicy: "required-only",
  };
}

function parseUserPayload(rawText: string): string {
  const jsonMatch = rawText.match(/Payload characters:\s*\d+\s*\n([\s\S]*?)(?:\n\n## |\n## |$)/);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim()) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return jsonMatch[1].trim();
    }
  }
  const requestMatch = rawText.match(/User request:\s*("[\s\S]*?")/i);
  if (requestMatch?.[1]) {
    try {
      const parsed = JSON.parse(requestMatch[1]) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return requestMatch[1];
    }
  }
  return rawText.trim();
}

function parseLineValue(rawText: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rawText.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function parseCapabilityList(rawText: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}[^\\[]*\\[([^\\]]*)\\]`, "im");
  const match = rawText.match(regex);
  if (!match?.[1]) return [];
  return match[1].split(",").map((name) => name.replace(/\+\d+\s+more/g, "").trim()).filter(Boolean);
}

function parseFailedMcp(rawText: string): string[] {
  const failed = new Set<string>();
  for (const match of rawText.matchAll(/['"]([a-zA-Z0-9_.-]+)['"]\s*:\s*McpError/g)) failed.add(match[1]);
  for (const match of rawText.matchAll(/\b([a-zA-Z0-9_.-]+)\s+status=failed\b/g)) failed.add(match[1]);
  return [...failed];
}

function normalizeRisk(value: string | undefined): DebloatRisk {
  const normalized = value?.toLowerCase();
  if (normalized === "network") return "network";
  if (normalized === "dangerous" || normalized === "shell" || normalized === "merge") return "dangerous";
  if (normalized === "write") return "write";
  return "read";
}

function normalizeSandbox(value: string | undefined): DebloatSandbox {
  const normalized = value?.toLowerCase();
  if (normalized === "full-access") return "full-access";
  if (normalized === "workspace-write") return "workspace-write";
  return "read-only";
}

function normalizeRole(value: string | undefined): SignalFrame["role"] {
  const normalized = value?.toLowerCase();
  if (normalized === "planner") return "planner";
  if (normalized === "executor" || normalized === "coder") return "executor";
  if (normalized === "reviewer") return "reviewer";
  return "coordinator";
}

function normalizePromptText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.length > 0 ? normalized : "(empty user request)";
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function clampPrompt(prompt: string, budget: number): string {
  if (prompt.length <= budget) return prompt;
  return `${prompt.slice(0, Math.max(0, budget - 32)).trimEnd()}\n- Prompt truncated to budget.`;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
