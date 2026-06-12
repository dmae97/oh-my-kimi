/**
 * JSON / JSONL renderer.
 * Canonical JSON is the source of truth; everything else is a rendering layer.
 */
import type { CliExecutionResult, OutputProfile, RenderedOutput } from "../runtime/types.js";
import { hashResult } from "./hash.js";

export function renderJson(result: CliExecutionResult, profile: OutputProfile): RenderedOutput {
  const space = profile.pretty ? 2 : undefined;
  const content = JSON.stringify(result, null, space);
  return {
    format: "json",
    content,
    sourceResultHash: hashResult(result),
    generatedAt: new Date().toISOString(),
  };
}

export function renderJsonl(result: CliExecutionResult, _profile: OutputProfile): RenderedOutput {
  const lines: string[] = [];

  // Summary record
  lines.push(
    JSON.stringify({
      type: "summary",
      command: result.command,
      success: result.success,
      exitCode: result.exitCode,
      tokenUsage: result.tokenUsage,
      error: result.error,
      result: result.result,
    })
  );

  // One record per event
  for (const event of result.events) {
    lines.push(JSON.stringify(event));
  }

  const content = lines.join("\n");
  return {
    format: "jsonl",
    content,
    sourceResultHash: hashResult(result),
    generatedAt: new Date().toISOString(),
  };
}
