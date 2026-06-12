/**
 * Markdown report renderer.
 */
import type {
  CliExecutionResult,
  NormalizedRunEvent,
  OutputProfile,
  RenderedOutput,
} from "../runtime/types.js";
import { hashResult } from "./hash.js";

export function renderMarkdown(
  result: CliExecutionResult,
  _profile: OutputProfile
): RenderedOutput {
  const lines: string[] = [];
  const statusIcon = result.success ? "✅" : "❌";

  lines.push(`# OMK Execution Report`);
  lines.push(``);
  lines.push(`| Property | Value |`);
  lines.push(`|----------|-------|`);
  lines.push(`| Command  | \`${result.command}\` |`);
  lines.push(`| Status   | ${statusIcon} ${result.success ? "Success" : "Failed"} |`);
  lines.push(`| Exit Code| ${result.exitCode} |`);
  lines.push(``);

  if (result.tokenUsage) {
    lines.push(`## Token Usage`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Input Tokens | ${result.tokenUsage.inputTokens.toLocaleString()} |`);
    lines.push(`| Output Tokens| ${result.tokenUsage.outputTokens.toLocaleString()} |`);
    lines.push(`| Total Tokens | ${result.tokenUsage.totalTokens.toLocaleString()} |`);
    if (result.tokenUsage.model) {
      lines.push(`| Model | ${result.tokenUsage.model} |`);
    }
    lines.push(``);
  }

  if (result.events.length > 0) {
    lines.push(`## Events`);
    lines.push(``);
    for (const event of result.events) {
      lines.push(renderEventMarkdown(event));
    }
    lines.push(``);
  }

  if (result.error) {
    lines.push(`## Error`);
    lines.push(``);
    lines.push(`- **Kind**: \`${result.error.kind}\``);
    lines.push(`- **Message**: ${result.error.message}`);
    if (result.error.hint) {
      lines.push(`- **Hint**: ${result.error.hint}`);
    }
    if (result.error.docsUrl) {
      lines.push(`- **Docs**: [Documentation](${result.error.docsUrl})`);
    }
    lines.push(``);
  }

  if (result.result !== undefined) {
    lines.push(`## Result`);
    lines.push(``);
    lines.push("```json");
    lines.push(JSON.stringify(result.result, null, 2));
    lines.push("```");
    lines.push(``);
  }

  const content = lines.join("\n");
  return {
    format: "markdown",
    content,
    sourceResultHash: hashResult(result),
    generatedAt: new Date().toISOString(),
  };
}

function renderEventMarkdown(event: NormalizedRunEvent): string {
  switch (event.type) {
    case "agent-started":
      return `- **Agent Started**: \`${event.agentName}\` at ${event.timestamp}`;
    case "agent-completed":
      return `- **Agent Completed**: \`${event.agentName}\` (${event.success ? "success" : "failure"}) at ${event.timestamp}`;
    case "task-started":
      return `- **Task Started**: \`${event.taskTitle}\` (${event.taskId}) at ${event.timestamp}`;
    case "task-completed":
      return `- **Task Completed**: \`${event.taskTitle}\` (${event.taskId}) at ${event.timestamp}`;
    case "task-failed":
      return `- **Task Failed**: \`${event.taskTitle}\` (${event.taskId}) — ${event.error} at ${event.timestamp}`;
    case "tool-called":
      return `- **Tool Called**: \`${event.toolName}\` at ${event.timestamp}`;
    case "token-usage":
      return `- **Token Usage**: ${event.usage.totalTokens.toLocaleString()} total tokens at ${event.timestamp}`;
    case "trace-span":
      return `- **Trace**: \`${event.spanName}\` (${event.durationMs}ms) at ${event.timestamp}`;
    case "approval-requested":
      return `- **Approval Requested**: \`${event.action}\` at ${event.timestamp}`;
    default:
      return `- **Event**: ${(event as NormalizedRunEvent).type}`;
  }
}
