import { sanitizeUserVisibleOutput } from "../../util/user-visible-output.js";

const UNSUPPORTED_RUNTIME_NODE_RE = /No runtime supports(?: task)?(?: for)? node\s+([A-Za-z0-9_.:/-]+)/i;

export function isUnsupportedRuntimeError(message: string): boolean {
  return UNSUPPORTED_RUNTIME_NODE_RE.test(message);
}

export function extractUnsupportedRuntimeNode(message: string): string | null {
  const match = message.match(UNSUPPORTED_RUNTIME_NODE_RE);
  return match?.[1] ?? null;
}

export function renderRouteBlockedPanel(message: string, options: { width?: number } = {}): string {
  const width = Math.min(100, Math.max(56, Math.round(options.width ?? 80)));
  const innerWidth = width - 4;
  const node = extractUnsupportedRuntimeNode(message) ?? "unknown";
  const safeMessage = sanitizeUserVisibleOutput(message).replace(/\s+/g, " ").trim();
  const reason = inferSecurityReason(safeMessage);
  const lines = [
    "No runtime supports this task.",
    "",
    `Node        ${node}`,
    "Provider    auto / check configured runtimes",
    "Capability  provider capability mismatch",
    `Security    ${reason.security}`,
    reason.detail ? `Reason      ${reason.detail}` : "",
    safeMessage && safeMessage !== message ? `Detail      ${safeMessage}` : "",
    "",
    `Suggested   ${reason.suggested}`,
    "Inspect     omk runtimes · omk mcp doctor",
  ].filter(Boolean);

  const label = "ROUTE BLOCKED";
  const top = `╭─ ${label} ${"─".repeat(Math.max(0, width - label.length - 5))}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  const body = lines.map((line) => `│ ${truncate(line, innerWidth).padEnd(innerWidth)} │`);
  return [top, ...body, bottom].join("\n");
}

function inferSecurityReason(message: string): { security: string; detail?: string; suggested: string } {
  if (/\bMCP\b|requiresMcp|requires MCP/i.test(message)) {
    return {
      security: "OMK keeps MCP authority behind approved runtimes",
      detail: "Node requires MCP authority; this runtime does not receive OMK MCP authority",
      suggested: "/provider auto · /mode plan · replan without MCP requirement",
    };
  }
  if (/\btool\b|requiresToolCalling|tool calling/i.test(message)) {
    return {
      security: "OMK routes tool calls through its owned tool-plane",
      detail: "Node requires live tool authority; selected runtime cannot own it",
      suggested: "/provider auto · /mode plan · replan with OMK tool authority",
    };
  }
  if (/\bworkspace-write\b|\bshell\b|\bwrite\b|\bpatch\b/i.test(message)) {
    return {
      security: "This runtime is env-hardened but not OS-sandboxed",
      detail: "Requested authority requires write or shell capability",
      suggested: "continue with approval prompts · replan read-only · switch provider-native sandbox · abort",
    };
  }
  return {
    security: "OMK blocks runtimes that cannot satisfy node authority",
    suggested: "omk doctor · /provider auto · /mode plan",
  };
}

function truncate(value: string, width: number): string {
  const chars = [...value];
  if (chars.length <= width) return value;
  return `${chars.slice(0, Math.max(1, width - 1)).join("")}…`;
}
