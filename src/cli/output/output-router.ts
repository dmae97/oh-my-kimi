/**
 * Output router — selects the correct renderer based on OutputProfile.format.
 */
import type { CliExecutionResult, OutputProfile, RenderedOutput } from "../runtime/types.js";
import { renderJson, renderJsonl } from "./json-renderer.js";
import { renderMarkdown } from "./markdown-renderer.js";
import { renderNlp } from "./nlp-renderer.js";
import { hashResult } from "./hash.js";

export function routeOutput(result: CliExecutionResult, profile: OutputProfile): RenderedOutput {
  switch (profile.format) {
    case "json":
      return renderJson(result, profile);
    case "jsonl":
      return renderJsonl(result, profile);
    case "markdown":
      return renderMarkdown(result, profile);
    case "nlp":
      return renderNlp(result, profile);
    case "silent": {
      return {
        format: "silent",
        content: "",
        sourceResultHash: hashResult(result),
        generatedAt: new Date().toISOString(),
      };
    }
    case "dashboard":
      // Dashboard is a future rich-TUI format; fallback to NLP for now.
      return renderNlp(result, profile);
    default: {
      // Exhaustive fallback — should never hit because TypeScript narrows.
      const _exhaustive: never = profile.format;
      void _exhaustive;
      return renderNlp(result, profile);
    }
  }
}
