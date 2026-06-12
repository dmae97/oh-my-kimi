/**
 * Section 22 P2 — Clack-based interactive prompts
 *
 * Provides:
 * - confirm/select/spinner for interactive workflows
 * - Provider selection, model selection, theme selection
 * - Goal input with validation
 * - Progress feedback during long operations
 */

import * as clack from "@clack/prompts";
import type { RuntimeSidecar } from "../../runtime/debloat-nlp.js";

/**
 * Interactive provider selection.
 * Returns selected provider/model string.
 */
export async function promptProviderSelection(
  currentProvider?: string,
  currentModel?: string,
): Promise<{ provider: string; model: string } | null> {
  const providers = [
    { value: "kimi", label: "Kimi (Moonshot)", hint: "Default" },
    { value: "codex", label: "Codex (OpenAI)", hint: "GPT-4" },
    { value: "claude", label: "Claude (Anthropic)", hint: "Sonnet" },
    { value: "gemini", label: "Gemini (Google)", hint: "Pro" },
    { value: "deepseek", label: "DeepSeek", hint: "Coder" },
    { value: "auto", label: "Auto-select", hint: "OMK picks best" },
  ];

  const provider = await clack.select({
    message: "Select provider:",
    options: providers,
    initialValue: currentProvider ?? "kimi",
  });

  if (clack.isCancel(provider)) {
    clack.cancel("Cancelled.");
    return null;
  }

  const model = await clack.text({
    message: `Model for ${provider}:`,
    placeholder: currentModel ?? getDefaultModel(provider),
    defaultValue: currentModel ?? getDefaultModel(provider),
  });

  if (clack.isCancel(model)) {
    clack.cancel("Cancelled.");
    return null;
  }

  return { provider, model };
}

/**
 * Interactive theme selection with preview.
 */
export async function promptThemeSelection(
  currentTheme?: string,
): Promise<string | null> {
  const themes = [
    { value: "omk", label: "OMK", hint: "Default colorful theme" },
    { value: "minimal", label: "Minimal", hint: "Clean, few colors" },
    { value: "mono", label: "Mono", hint: "Monochrome" },
    { value: "dark", label: "Dark", hint: "Dark terminal optimized" },
    { value: "light", label: "Light", hint: "Light terminal optimized" },
  ];

  const theme = await clack.select({
    message: "Select theme:",
    options: themes,
    initialValue: currentTheme ?? "omk",
  });

  if (clack.isCancel(theme)) {
    clack.cancel("Cancelled.");
    return null;
  }

  return theme;
}

/**
 * Interactive goal input with multiline support.
 */
export async function promptGoalInput(): Promise<string | null> {
  const goal = await clack.text({
    message: "Enter your goal:",
    placeholder: "What do you want to accomplish?",
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return "Goal cannot be empty";
      }
      if (value.length < 5) {
        return "Goal too short — be more specific";
      }
    },
  });

  if (clack.isCancel(goal)) {
    clack.cancel("Cancelled.");
    return null;
  }

  return goal;
}

/**
 * Interactive confirmation with sidecar summary.
 */
export async function promptConfirmExecution(
  sidecar: RuntimeSidecar,
  goal: string,
): Promise<boolean> {
  clack.log.info("Execution plan:");
  clack.log.message(`  Intent: ${sidecar.intent}`);
  clack.log.message(`  Risk: ${sidecar.risk}`);
  clack.log.message(`  Provider: ${sidecar.provider}/${sidecar.model}`);
  clack.log.message(`  Required MCP: ${sidecar.requiredMcp.length} servers`);
  clack.log.message(`  Optional MCP: ${sidecar.optionalMcp.length} servers`);
  clack.log.message(`  Skills: ${sidecar.selectedSkills.length}`);

  const confirm = await clack.confirm({
    message: `Execute goal: "${goal.slice(0, 80)}${goal.length > 80 ? "..." : ""}"?`,
    initialValue: true,
  });

  if (clack.isCancel(confirm)) {
    clack.cancel("Cancelled.");
    return false;
  }

  return confirm;
}

/**
 * Spinner wrapper for long-running operations.
 */
export function createSpinner(_label: string): ReturnType<typeof clack.spinner> {
  return clack.spinner({ indicator: "dots" });
}

/**
 * Interactive MCP server selection from available servers.
 */
export async function promptMcpSelection(
  available: string[],
  required: string[],
  optional: string[],
): Promise<{ required: string[]; optional: string[] } | null> {
  if (available.length === 0) {
    clack.log.info("No MCP servers available.");
    return { required: [], optional: [] };
  }

  const selected = await clack.multiselect({
    message: "Select MCP servers for this session:",
    options: available.map((name) => ({
      value: name,
      label: name,
      hint: required.includes(name)
        ? "required"
        : optional.includes(name)
          ? "optional"
          : undefined,
    })),
    initialValues: [...required, ...optional],
    required: false,
  });

  if (clack.isCancel(selected)) {
    clack.cancel("Cancelled.");
    return null;
  }

  return {
    required: selected.filter((s) => required.includes(s)),
    optional: selected.filter((s) => !required.includes(s)),
  };
}

/**
 * Progress reporter using clack spinner.
 */
export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const s = clack.spinner();
  s.start(message);
  try {
    const result = await fn();
    s.stop("Done.");
    return result;
  } catch (err) {
    s.stop(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Intro/outro for OMK session.
 */
export function omkIntro(version: string): void {
  clack.intro(`OMK v${version}`);
}

export function omkOutro(message: string): void {
  clack.outro(message);
}

// --- Helpers ---

function getDefaultModel(provider: string): string {
  const defaults: Record<string, string> = {
    kimi: "kimi-code",
    codex: "codex-cli",
    claude: "sonnet",
    gemini: "pro",
    deepseek: "coder",
    auto: "auto",
  };
  return defaults[provider] ?? "default";
}
