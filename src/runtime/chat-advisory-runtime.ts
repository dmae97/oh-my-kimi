import type { AgentRuntime, AgentRunResult } from "./agent-runtime.js";
import type { ContextCapsule } from "./context-capsule.js";
import { execSync } from "child_process";

export function createChatAdvisoryRuntime(): AgentRuntime {
  return {
    id: "omk-advisory",
    priority: 0,
    supports: () => true,
    async runNode(_capsule: ContextCapsule, _signal: AbortSignal): Promise<AgentRunResult> {
      const available: string[] = [];
      try { execSync("which codex", { stdio: "ignore" }); available.push("codex"); } catch { /* unavailable */ }
      try { execSync("which opencode", { stdio: "ignore" }); available.push("opencode"); } catch { /* unavailable */ }
      try { execSync("which commandcode", { stdio: "ignore" }); available.push("commandcode"); } catch { /* unavailable */ }
      if (process.env.DEEPSEEK_API_KEY) available.push("deepseek");

      const sep = "\n" + "─".repeat(60) + "\n";
      const hasNpm = (() => { try { execSync("which npm", { stdio: "ignore" }); return true; } catch { return false; } })();
      const hasCargo = (() => { try { execSync("which cargo", { stdio: "ignore" }); return true; } catch { return false; } })();
      const msg = [
        sep,
        "⚠  No AI runtime adapter detected.",
        "",
        "OMK is running in advisory mode. To enable the interactive agent:",
        "",
        "  1. Run: omk auth",
        "     (shows available providers + guided setup)",
        "",
        "  2. Install a CLI runtime:",
        hasNpm ? "     • npm install -g @openai/codex" : undefined,
        hasNpm ? "     • npm install -g @anthropic-ai/kimi-code  && kimi login" : undefined,
        hasCargo ? "     • cargo install opencode" : undefined,
        "",
        "  3. Or set API keys:",
        "     • export DEEPSEEK_API_KEY=\"sk-...\"",
        "     • export OPENAI_API_KEY=\"sk-...\"",
        "",
        "  4. Then try again: omk chat",
        "",
        available.length > 0
          ? `Detected: ${available.join(", ")}`
          : "No runtimes detected. Install one from step 2.",
        "",
        "Quick start: npm install -g @openai/codex && codex login && omk chat",
        sep,
      ].filter((line): line is string => line !== undefined).join("\n");

      return { success: true, stdout: msg, stderr: "" };
    },
  };
}
