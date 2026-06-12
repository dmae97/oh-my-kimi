import type { DagNodeRouting } from "../orchestration/dag.js";

const MAX_CAPABILITY_NAME_LENGTH = 120;

export interface CapabilityInjectionInput {
  readonly mcpAllowlist?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skillNames?: readonly string[];
  readonly skills?: readonly string[];
  readonly hookNames?: readonly string[];
  readonly hooks?: readonly string[];
  readonly tools?: readonly string[];
  readonly requireMcp?: boolean;
  readonly requiresToolCalling?: boolean;
}

export interface CapabilityKindSummary {
  readonly enabled: boolean;
  readonly count: number;
  readonly names: readonly string[];
}

export interface CapabilityInjectionSummary {
  readonly mcp: CapabilityKindSummary;
  readonly skills: CapabilityKindSummary;
  readonly hooks: CapabilityKindSummary;
  readonly tools: CapabilityKindSummary;
  readonly requiresMcp: boolean;
  readonly requiresToolCalling: boolean;
  readonly rationale: string;
}

export interface CapabilityInjection {
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
  readonly hooks: readonly string[];
  readonly tools: readonly string[];
  readonly requiresMcp: boolean;
  readonly requiresToolCalling: boolean;
  readonly summary: CapabilityInjectionSummary;
}

export function normalizeCapabilityNames(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const name = value.trim().slice(0, MAX_CAPABILITY_NAME_LENGTH);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

export function buildCapabilityInjection(input: CapabilityInjectionInput = {}): CapabilityInjection {
  const mcpServers = normalizeCapabilityNames([...(input.mcpAllowlist ?? []), ...(input.mcpServers ?? [])]);
  const skills = normalizeCapabilityNames([...(input.skillNames ?? []), ...(input.skills ?? [])]);
  const hooks = normalizeCapabilityNames([...(input.hookNames ?? []), ...(input.hooks ?? [])]);
  const tools = normalizeCapabilityNames(input.tools);
  const requiresMcp = input.requireMcp ?? false;
  const requiresToolCalling = input.requiresToolCalling ?? tools.length > 0;
  const summary: CapabilityInjectionSummary = {
    mcp: summarizeCapabilityKind(mcpServers),
    skills: summarizeCapabilityKind(skills),
    hooks: summarizeCapabilityKind(hooks),
    tools: summarizeCapabilityKind(tools),
    requiresMcp,
    requiresToolCalling,
    rationale: [
      `mcp=${mcpServers.length}`,
      `skills=${skills.length}`,
      `hooks=${hooks.length}`,
      `tools=${tools.length}`,
      `requiresMcp=${requiresMcp ? "true" : "false"}`,
      `requiresToolCalling=${requiresToolCalling ? "true" : "false"}`,
    ].join("; "),
  };
  return {
    mcpServers,
    skills,
    hooks,
    tools,
    requiresMcp,
    requiresToolCalling,
    summary,
  };
}

export function applyCapabilityInjectionToRouting(
  routing: DagNodeRouting,
  injection: CapabilityInjection,
): DagNodeRouting {
  return {
    ...routing,
    mcpServers: [...injection.mcpServers],
    skills: [...injection.skills],
    tools: [...injection.tools],
    hooks: [...injection.hooks],
    assignedCapabilities: {
      ...(routing.assignedCapabilities ?? {}),
      mcpServers: [...injection.mcpServers],
      skills: [...injection.skills],
      tools: [...injection.tools],
      hooks: [...injection.hooks],
    },
    requiresMcp: injection.requiresMcp,
    requiresToolCalling: routing.requiresToolCalling ?? injection.requiresToolCalling,
    rationale: appendRationale(routing.rationale, `capability envelope: ${injection.summary.rationale}`),
  };
}

export function renderCapabilityInjectionSummary(injection: CapabilityInjection): string {
  return [
    `MCP selected: ${formatCapabilityKind(injection.summary.mcp)}; required=${injection.requiresMcp ? "true" : "false"}; failure-policy=${injection.requiresMcp ? "strict" : "required-only"}`,
    `Skills selected: ${formatCapabilityKind(injection.summary.skills)}`,
    `Hooks active: ${formatCapabilityKind(injection.summary.hooks)}`,
    `Tools available: ${formatCapabilityKind(injection.summary.tools)}; tool-calling-required=${injection.requiresToolCalling ? "true" : "false"}`,
    "Do not activate every available MCP server or skill; use only capabilities needed for this request.",
    "Optional MCP failures are warnings unless MCP is explicitly required for this node.",
  ].join("\n");
}

function summarizeCapabilityKind(names: readonly string[]): CapabilityKindSummary {
  return {
    enabled: names.length > 0,
    count: names.length,
    names: [...names],
  };
}

function formatCapabilityKind(summary: CapabilityKindSummary): string {
  if (!summary.enabled) return "disabled";
  const preview = summary.names.slice(0, 8).join(", ");
  const more = summary.count > 8 ? `, +${summary.count - 8} more` : "";
  return `enabled (${summary.count}) [${preview}${more}]`;
}

function appendRationale(existing: string | undefined, addition: string): string {
  const trimmed = existing?.trim();
  return trimmed ? `${trimmed}; ${addition}` : addition;
}
