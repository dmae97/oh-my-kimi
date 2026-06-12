/**
 * RuntimeSidecarBuilder — builds RuntimeSidecar from CapabilityPlan + envelope.
 *
 * Architecture Doc §4: CapabilitySelector → RuntimeSidecar Builder → NLP Prompt Compiler
 * Builds the filtered, per-turn runtime context that replaces monolithic config injection.
 */

import type {
  CapabilityPlan,
  CommandEnvelope,
  OutputProfile,
  RuntimeSidecar,
} from "./types.js";

/**
 * Build a RuntimeSidecar from a CapabilityPlan and CommandEnvelope.
 * This is the main entry point for the sidecar pipeline.
 */
export function buildRuntimeSidecar(
  plan: CapabilityPlan,
  envelope: CommandEnvelope
): RuntimeSidecar {
  const filteredMcpConfig = filterMcpConfig(plan);
  const promptInjection = compilePromptInjection(plan, envelope);
  const envOverrides = buildEnvOverrides(plan, envelope);
  const outputProfile = resolveOutputProfile(plan, envelope);

  return {
    capabilityPlan: plan,
    filteredMcpConfig,
    promptInjection,
    envOverrides,
    outputProfile,
  };
}

/**
 * Filter MCP config to only include servers in the capability plan.
 * Architecture invariant: availableMcp ≠ required activation.
 */
function filterMcpConfig(plan: CapabilityPlan): Record<string, unknown> {
  const activeServers = new Set(plan.mcpServers);
  const filtered: Record<string, unknown> = {};

  for (const server of activeServers) {
    // MCP config is resolved at runtime from project config
    // Here we just mark which servers should be active
    filtered[server] = { enabled: true, required: plan.providerHints.requireMcp === true };
  }

  return filtered;
}

/**
 * Compile NLP prompt injection based on capability plan.
 * This replaces the old monolithic prompt bloat.
 */
function compilePromptInjection(
  plan: CapabilityPlan,
  _envelope: CommandEnvelope
): string {
  const parts: string[] = [];

  // Skills injection (compact form)
  if (plan.skills.length > 0) {
    parts.push(`[skills:${plan.skills.join(",")}]`);
  }

  // Hooks injection
  if (plan.hooks.length > 0) {
    parts.push(`[hooks:${plan.hooks.join(",")}]`);
  }

  // MCP servers
  if (plan.mcpServers.length > 0) {
    parts.push(`[mcp:${plan.mcpServers.join(",")}]`);
  }

  // Tools
  if (plan.tools.length > 0) {
    parts.push(`[tools:${plan.tools.join(",")}]`);
  }

  // Prompt mode directive
  parts.push(`[mode:${plan.promptMode}]`);

  return parts.join(" ");
}

/**
 * Build environment variable overrides for the sidecar.
 */
function buildEnvOverrides(
  plan: CapabilityPlan,
  _envelope: CommandEnvelope
): Record<string, string> {
  const env: Record<string, string> = {};

  env.OMK_CAPABILITY_PLAN = JSON.stringify({
    skills: plan.skills,
    mcpServers: plan.mcpServers,
    hooks: plan.hooks,
    tools: plan.tools,
  });

  env.OMK_PROMPT_MODE = plan.promptMode;

  if (plan.providerHints.preferProvider) {
    env.OMK_PREFER_PROVIDER = plan.providerHints.preferProvider;
  }

  if (plan.providerHints.requireToolCalling) {
    env.OMK_REQUIRE_TOOL_CALLING = "true";
  }

  return env;
}

/**
 * Resolve output profile from plan and envelope.
 * Architecture invariant: provider raw stdout ≠ user output.
 */
function resolveOutputProfile(
  plan: CapabilityPlan,
  envelope: CommandEnvelope
): OutputProfile {
  // Base from envelope
  const base = envelope.output;

  // Adjust based on prompt mode
  switch (plan.promptMode) {
    case "minimal":
      return { ...base, format: "silent", includeMessages: false, includeTrace: false };
    case "compact":
      return { ...base, includeMessages: false };
    case "nlp":
      return { ...base, format: "nlp" };
    case "full":
    default:
      return base;
  }
}

/**
 * Create a minimal sidecar for sub-agent workers.
 * Used by ParallelOrchestrator when dispatching tasks.
 */
export function createSubAgentSidecar(
  plan: CapabilityPlan,
  taskGoal: string
): RuntimeSidecar {
  return {
    capabilityPlan: plan,
    filteredMcpConfig: filterMcpConfig(plan),
    promptInjection: compilePromptInjection(plan, {
      kind: "task",
      input: {
        source: "argv",
        rawArgs: [taskGoal],
        metadata: { cwd: process.cwd(), invokedAt: new Date().toISOString(), isTty: false },
      },
      config: { cwd: process.cwd(), env: process.env },
      output: { format: "nlp", pretty: false, includeMessages: false, includeTrace: false, stream: true, destination: "stdout" },
      theme: { name: "omk", mode: "dark" },
      runtime: {},
    }),
    envOverrides: buildEnvOverrides(plan, {
      kind: "task",
      input: {
        source: "argv",
        rawArgs: [taskGoal],
        metadata: { cwd: process.cwd(), invokedAt: new Date().toISOString(), isTty: false },
      },
      config: { cwd: process.cwd(), env: process.env },
      output: { format: "nlp", pretty: false, includeMessages: false, includeTrace: false, stream: true, destination: "stdout" },
      theme: { name: "omk", mode: "dark" },
      runtime: {},
    }),
    outputProfile: { format: "nlp", pretty: false, includeMessages: false, includeTrace: false, stream: true, destination: "stdout" },
  };
}
