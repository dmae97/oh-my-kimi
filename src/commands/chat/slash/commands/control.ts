import type { RunRouteDecision, UserIntent } from "../../../../contracts/orchestration.js";
import { analyzeUserIntent } from "../../../../goal/intake.js";
import { buildParallelRouteDecision } from "../../../parallel/orchestrator.js";
import { style } from "../../../../util/theme.js";
import { commandLine, formatScopedNames } from "../format.js";
import { okSlashResult } from "../result.js";
import type { SlashCommandContext, SlashCommandSpec } from "../types.js";

interface SlashRouteAgentAssignment {
  agent: string;
  skills: string[];
  mcpServers: string[];
  hooks: string[];
  tools: string[];
  rationale: string;
}

interface SlashRoutePreview {
  schema: "omk.slash.route-preview.v1";
  promptPreview: string;
  intent: {
    taskType: UserIntent["taskType"];
    complexity: UserIntent["complexity"];
    estimatedWorkers: number;
    readOnly: boolean;
    parallelizable: boolean;
    requiredRoles: string[];
  };
  route: RunRouteDecision;
  assignments: SlashRouteAgentAssignment[];
  nextActions: string[];
}

export function buildControlPlaneSlashCommands(): SlashCommandSpec[] {
  return [
    {
      name: "/route",
      aliases: ["/intent", "/next"],
      group: "routing",
      summary: "Preview route policy, evidence gates, and agent lanes",
      usage: "/route <prompt> [--json]",
      examples: ["/route \"크리티컬 이슈좀 찾아줘\" --json"],
      handler: (ctx, args) => {
        const prompt = args.positional.join(" ").trim();
        if (!prompt) {
          return okSlashResult({
            text: [
              style.phosphorDim("\n  Usage: /route <prompt> [--json]"),
              style.phosphorDim("  Preview MIMO route policy without running a provider turn.\n"),
            ].join("\n"),
          });
        }

        const preview = buildSlashRoutePreview(ctx, prompt);
        if (args.flags.json) return okSlashResult({ json: preview });
        return okSlashResult({ text: renderSlashRoutePreview(preview) });
      },
    },
  ];
}

function buildSlashRoutePreview(ctx: SlashCommandContext, prompt: string): SlashRoutePreview {
  const intent = analyzeUserIntent(prompt);
  const route = buildParallelRouteDecision(prompt, intent);
  const assignments = route.selectedAgents.map((agent) => buildAgentAssignment(agent, ctx));
  return {
    schema: "omk.slash.route-preview.v1",
    promptPreview: redactPromptPreview(prompt),
    intent: {
      taskType: intent.taskType,
      complexity: intent.complexity,
      estimatedWorkers: intent.estimatedWorkers,
      readOnly: intent.isReadOnly,
      parallelizable: intent.parallelizable,
      requiredRoles: intent.requiredRoles,
    },
    route,
    assignments,
    nextActions: buildNextActions(route),
  };
}

function buildAgentAssignment(agent: string, ctx: SlashCommandContext): SlashRouteAgentAssignment {
  const recommended = recommendedCapabilitiesForAgent(agent);
  const mcpServers = pickAvailable(recommended.mcpServers, ctx.input.mcpAllowlist);
  const hooks = pickAvailable(recommended.hooks, ctx.input.hookNames);
  return {
    agent,
    skills: recommended.skills,
    mcpServers,
    hooks,
    tools: recommended.tools,
    rationale: recommended.rationale,
  };
}

function recommendedCapabilitiesForAgent(agent: string): Omit<SlashRouteAgentAssignment, "agent"> {
  const normalized = agent.toLowerCase();
  if (normalized.includes("repo") || normalized.includes("explorer")) {
    return {
      skills: ["omk-repo-explorer"],
      mcpServers: ["omk-project"],
      hooks: [],
      tools: ["ctx_search", "ctx_read", "ctx_shell"],
      rationale: "collect changed files and scoped code evidence",
    };
  }
  if (normalized.includes("risk")) {
    return {
      skills: ["omk-evidence-contract", "omk-research-verify"],
      mcpServers: ["omk-project"],
      hooks: [],
      tools: ["ctx_search", "ctx_read"],
      rationale: "score changed surfaces before execution decisions",
    };
  }
  if (normalized.includes("runtime")) {
    return {
      skills: ["omk-control-loop-debugger", "omk-typescript-strict"],
      mcpServers: ["omk-project"],
      hooks: [],
      tools: ["ctx_search", "ctx_read"],
      rationale: "review runtime, sandbox, and command-routing boundaries",
    };
  }
  if (normalized.includes("security")) {
    return {
      skills: ["omk-security-review", "omk-secret-guard"],
      mcpServers: ["omk-project"],
      hooks: ["protect-secrets.sh"],
      tools: ["ctx_search", "ctx_read"],
      rationale: "check auth, permission, secret, and injection risks",
    };
  }
  if (normalized.includes("test")) {
    return {
      skills: ["omk-test-debug-loop", "omk-quality-gate"],
      mcpServers: ["omk-project"],
      hooks: [],
      tools: ["ctx_search", "ctx_shell"],
      rationale: "map affected files to targeted tests and quality gates",
    };
  }
  if (normalized.includes("evidence") || normalized.includes("verifier")) {
    return {
      skills: ["omk-evidence-contract", "omk-quality-gate"],
      mcpServers: ["omk-project"],
      hooks: [],
      tools: ["ctx_search", "ctx_read", "ctx_shell"],
      rationale: "verify claims against files, lines, diagnostics, and tests",
    };
  }
  if (normalized.includes("review")) {
    return {
      skills: ["omk-code-review"],
      mcpServers: ["omk-project"],
      hooks: [],
      tools: ["ctx_search", "ctx_read"],
      rationale: "review scoped implementation and merge readiness",
    };
  }
  if (normalized.includes("coder") || normalized.includes("implement")) {
    return {
      skills: ["omk-typescript-strict"],
      mcpServers: ["omk-project"],
      hooks: [],
      tools: ["ctx_search", "ctx_read", "ctx_shell"],
      rationale: "implement minimal typed changes after route approval",
    };
  }
  return {
    skills: ["omk-plan-first"],
    mcpServers: ["omk-project"],
    hooks: [],
    tools: ["ctx_search", "ctx_read"],
    rationale: "plan and sequence the next control-loop action",
  };
}

function pickAvailable(recommended: readonly string[], available: readonly string[] | undefined): string[] {
  if (!available || available.length === 0) return [];
  const allowed = new Set(available);
  return recommended.filter((name) => allowed.has(name));
}

function buildNextActions(route: RunRouteDecision): string[] {
  const actions = [
    `Bind goal/intent as ${route.intent}`,
    `Collect required evidence: ${route.requiredEvidence
      .filter((item) => item.required)
      .map((item) => item.kind)
      .join(", ")}`,
  ];
  if (route.mode === "read-only") {
    actions.push("Keep execution read-only until evidence gates are satisfied");
  } else {
    actions.push("Run focused checks before applying write-mode changes");
  }
  actions.push("Use /parallel with the same prompt when ready to execute the route");
  return actions;
}

function redactPromptPreview(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const redacted = compact.replace(/([A-Z_]{2,}(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*=)[^\s]+/gi, "$1[redacted]");
  return redacted.length > 80 ? `${redacted.slice(0, 77)}…` : redacted;
}

function renderSlashRoutePreview(preview: SlashRoutePreview): string {
  const lines = [
    style.phosphorBold("\n  Route Policy Preview"),
    `  Goal: ${style.phosphor(preview.route.intent)}`,
    `  Mode: ${style.phosphorDim(preview.route.mode)} | Workers: ${style.phosphorDim(String(preview.intent.estimatedWorkers))} | Complexity: ${style.phosphorDim(preview.intent.complexity)}`,
    `  Reason: ${style.phosphorDim(preview.route.reason)}`,
    "",
    style.phosphorBold("  Evidence Gates:"),
    ...preview.route.requiredEvidence.map((item) =>
      `    ${item.required ? "!" : "-"} ${item.kind.padEnd(10)} ${style.phosphorDim(item.description)}`,
    ),
    "",
    style.phosphorBold("  Agent Lanes:"),
    ...preview.assignments.map(
      (assignment) =>
        `    ${assignment.agent.padEnd(21)} skills:${formatScopedNames(assignment.skills)} mcp:${formatScopedNames(assignment.mcpServers)} hooks:${formatScopedNames(assignment.hooks)}`,
    ),
    "",
    style.phosphorBold("  Next:"),
    ...preview.nextActions.map((action, index) => `    ${index + 1}. ${action}`),
    "",
    style.phosphorDim(`  ${commandLine("/route", "--json", "emit machine-readable policy preview").trim()}`),
    "",
  ];
  return lines.join("\n");
}
