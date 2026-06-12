/**
 * Theme-aware error renderer.
 * Converts NormalizedCliError into human-readable messages with hints.
 */
import type { NormalizedCliError, ResolvedTheme } from "../runtime/types.js";
import { style, status } from "../../theme/index.js";

export function renderError(
  error: NormalizedCliError,
  theme?: ResolvedTheme
): string {
  const lines: string[] = [];
  const isMono = theme?.mode === "mono";

  // Header: kind + message
  const kindLabel = `[${error.kind.toUpperCase()}]`;
  if (isMono) {
    lines.push(`✖ ${kindLabel} ${error.message}`);
  } else {
    lines.push(status.fail(kindLabel) + " " + style.redBold(error.message));
  }

  // Hint
  if (error.hint) {
    if (isMono) {
      lines.push(`  Hint: ${error.hint}`);
    } else {
      lines.push(style.orange("  💡 " + error.hint));
    }
  }

  // Docs URL
  if (error.docsUrl) {
    if (isMono) {
      lines.push(`  Docs: ${error.docsUrl}`);
    } else {
      lines.push(style.blue("  📖 " + error.docsUrl));
    }
  }

  // Cause
  if (error.cause) {
    const causeText =
      typeof error.cause === "string"
        ? error.cause
        : error.cause instanceof Error
          ? error.cause.message
          : JSON.stringify(error.cause);
    if (isMono) {
      lines.push(`  Cause: ${causeText}`);
    } else {
      lines.push(style.dim + "  Cause: " + causeText + style.reset);
    }
  }

  return lines.join("\n");
}

/**
 * Plain-text variant for file output or non-TTY environments.
 */
export function renderErrorPlain(error: NormalizedCliError): string {
  const lines: string[] = [];
  lines.push(`[${error.kind.toUpperCase()}] ${error.message}`);
  if (error.hint) {
    lines.push(`  Hint: ${error.hint}`);
  }
  if (error.docsUrl) {
    lines.push(`  Docs: ${error.docsUrl}`);
  }
  if (error.cause) {
    const causeText =
      typeof error.cause === "string"
        ? error.cause
        : error.cause instanceof Error
          ? error.cause.message
          : JSON.stringify(error.cause);
    lines.push(`  Cause: ${causeText}`);
  }
  return lines.join("\n");
}
