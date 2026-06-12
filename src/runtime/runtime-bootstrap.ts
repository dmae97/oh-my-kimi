import { checkCommand, resolveKimiBin } from "../util/shell.js";

export type RuntimeSessionMode = "interactive-tty" | "one-shot-cli" | "api-turn" | "advisory-only";

export interface RuntimeBootstrap {
  ok: boolean;
  provider: string;
  providerPolicy: string;
  selectedProvider: string;
  selectedRuntimeId?: string;
  selectedModel?: string;
  sessionMode: RuntimeSessionMode;
  authOk: boolean;
  modelOk: boolean;
  runtimeOk: boolean;
  reason?: string;
  setupHints: string[];
}

function detectProvider(
  provider: string,
  env: Record<string, string | undefined>
): { bin?: string; envKey?: string; sessionMode: RuntimeSessionMode; installHint: string; authHint: string; modelHint: string } {
  switch (provider) {
    case "kimi":
      return {
        bin: resolveKimiBin(env),
        sessionMode: "interactive-tty",
        installHint: "npm install -g @anthropic-ai/kimi-code",
        authHint: "kimi login",
        modelHint: "kimi-code default",
      };
    case "mimo":
      return {
        envKey: "MIMO_API_KEY",
        sessionMode: "api-turn",
        installHint: "Set MIMO_API_KEY env var or configure [providers.mimo] in ~/.kimi/config.toml",
        authHint: "Set MIMO_API_KEY env var",
        modelHint: env.MIMO_MODEL ?? "mimo-v2.5-pro",
      };
    case "codex":
      return {
        bin: env.CODEX_BIN ?? "codex",
        sessionMode: "one-shot-cli",
        installHint: "npm install -g @openai/codex",
        authHint: "codex login",
        modelHint: "codex-cli default",
      };
    case "deepseek":
      return {
        envKey: "DEEPSEEK_API_KEY",
        sessionMode: "api-turn",
        installHint: "export DEEPSEEK_API_KEY=sk-...",
        authHint: "Set DEEPSEEK_API_KEY env var",
        modelHint: env.DEEPSEEK_MODEL ?? "deepseek-chat",
      };
    case "local":
    case "llama":
    case "local-llm":
      return {
        sessionMode: "api-turn",
        installHint: "LOCAL_LLM_BASE_URL=http://localhost:8080/v1 LOCAL_LLM_MODEL=qwen3-coder-30b-a3b",
        authHint: "Start llama-server or llama.cpp with --port 8080",
        modelHint: env.LOCAL_LLM_MODEL ?? "qwen3-coder-30b-a3b",
      };
    case "commandcode":
      return {
        bin: env.COMMANDCODE_BIN ?? "commandcode",
        sessionMode: "one-shot-cli",
        installHint: "npm install -g commandcode",
        authHint: "commandcode login",
        modelHint: "commandcode default",
      };
    case "opencode":
      return {
        bin: env.OPENCODE_BIN ?? "opencode",
        sessionMode: "one-shot-cli",
        installHint: "cargo install opencode",
        authHint: "opencode login",
        modelHint: "opencode default",
      };
    default:
      return {
        sessionMode: "advisory-only",
        installHint: "omk auth",
        authHint: "omk auth",
        modelHint: "auto-detect",
      };
  }
}

async function resolveAutoProvider(env: Record<string, string | undefined>): Promise<{ provider: string; runtimeId: string } | undefined> {
  // 1. Check config.toml for explicit default_model (highest priority)
  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const home = env.HOME ?? env.USERPROFILE ?? "";
    const configPath = join(home, ".kimi", "config.toml");
    const configContent = readFileSync(configPath, "utf-8");
    const defaultModelMatch = configContent.match(/default_model\s*=\s*"([^"]+)"/);
    if (defaultModelMatch) {
      const defaultModel = defaultModelMatch[1];
      if (defaultModel.startsWith("mimo")) return { provider: "mimo", runtimeId: "mimo-api" };
      if (defaultModel.startsWith("kimi") || defaultModel.startsWith("moonshot")) return { provider: "kimi", runtimeId: "kimi-api" };
      if (defaultModel.startsWith("deepseek")) return { provider: "deepseek", runtimeId: "deepseek-api" };
    }
    if (/\[providers\.mimo\]/.test(configContent)) return { provider: "mimo", runtimeId: "mimo-api" };
  } catch { /* config not found */ }

  // 2. Check for API keys in env
  if (env.MIMO_API_KEY) return { provider: "mimo", runtimeId: "mimo-api" };
  if (env.DEEPSEEK_API_KEY) return { provider: "deepseek", runtimeId: "deepseek-api" };
  if (env.LOCAL_LLM_BASE_URL) return { provider: "local-llm", runtimeId: "local-llm" };

  // 3. CLI binary detection (lowest priority)
  const codexBin = env.CODEX_BIN ?? "codex";
  if (await checkCommand(codexBin).catch(() => false)) return { provider: "codex", runtimeId: "codex-cli" };

  let commandcodeBin: string | undefined;
  if (env.COMMANDCODE_BIN) {
    commandcodeBin = await checkCommand(env.COMMANDCODE_BIN).catch(() => false) ? env.COMMANDCODE_BIN : undefined;
  } else if (await checkCommand("commandcode").catch(() => false)) {
    commandcodeBin = "commandcode";
  }
  if (commandcodeBin) return { provider: "commandcode", runtimeId: "commandcode-cli" };

  const opencodeBin = env.OPENCODE_BIN ?? "opencode";
  if (await checkCommand(opencodeBin).catch(() => false)) return { provider: "opencode", runtimeId: "opencode-cli" };

  // 4. kimi binary (legacy — lowest priority)
  const kimiBin = resolveKimiBin(env);
  if (await checkCommand(kimiBin).catch(() => false)) return { provider: "kimi", runtimeId: "kimi-print" };

  return undefined;
}

export async function resolveRuntimeBootstrap(options: {
  provider: string;
  model?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<RuntimeBootstrap> {
  const providerPolicy = options.provider.trim().toLowerCase() || "auto";
  const env = options.env ?? process.env;
  const authorityProvider = resolveAuthorityProviderPolicy(providerPolicy, env);
  const effectiveProviderPolicy = authorityProvider ?? providerPolicy;
  const autoSelection = effectiveProviderPolicy === "auto" ? await resolveAutoProvider(env) : undefined;
  const selectedProvider = autoSelection?.provider ?? effectiveProviderPolicy;
  const info = detectProvider(selectedProvider, env);
  const hints: string[] = [];

  let runtimeOk = false;
  let authOk = false;
  let modelOk = false;
  const reasons: string[] = [];

  if (effectiveProviderPolicy === "auto" && !autoSelection) {
    reasons.push("no runnable runtime detected for auto provider policy");
    hints.push("Configure a provider: mimo, deepseek, codex, commandcode, opencode, or local-llm");
    hints.push("Use an explicit provider, e.g. omk chat --provider mimo --mcp-scope none");
  } else if (info.bin) {
    runtimeOk = await checkCommand(info.bin).catch(() => false);
    if (!runtimeOk) {
      reasons.push(`${info.bin} CLI not found`);
      hints.push(info.installHint);
    } else {
      authOk = true;
    }
  } else if (info.envKey) {
    runtimeOk = Boolean(env[info.envKey]);
    if (!runtimeOk && selectedProvider === "mimo") {
      // Also check config.toml for mimo API key
      try {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const home = env.HOME ?? env.USERPROFILE ?? "";
        const configPath = join(home, ".kimi", "config.toml");
        const configContent = readFileSync(configPath, "utf-8");
        runtimeOk = /\[providers\.mimo\][\s\S]*?api_key\s*=\s*"[^"]+"/.test(configContent);
      } catch { /* config not found */ }
    }
    if (!runtimeOk) {
      reasons.push(`${info.envKey} is not set`);
      hints.push(info.installHint);
    } else {
      authOk = true;
    }
  }

  if (runtimeOk) modelOk = true;

  if (!runtimeOk && effectiveProviderPolicy !== "auto") {
    hints.push(info.authHint);
    hints.push(`omk chat --provider ${selectedProvider} --model ${info.modelHint}`);
  }

  const ok = runtimeOk && authOk && modelOk;

  return {
    ok,
    provider: selectedProvider,
    providerPolicy,
    selectedProvider,
    selectedRuntimeId: autoSelection?.runtimeId ?? info.bin ?? info.envKey ?? "auto",
    selectedModel: options.model ?? info.modelHint,
    sessionMode: info.sessionMode,
    authOk,
    modelOk,
    runtimeOk,
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
    setupHints: hints,
  };
}

function resolveAuthorityProviderPolicy(
  providerPolicy: string,
  env: Record<string, string | undefined>
): string | undefined {
  if (providerPolicy !== "authority" && providerPolicy !== "primary" && providerPolicy !== "omk") return undefined;
  const configured = env.OMK_AUTHORITY_PROVIDER?.trim().toLowerCase()
    || env.OMK_DEFAULT_PROVIDER?.trim().toLowerCase()
    || "mimo";
  if (configured === "authority" || configured === "primary" || configured === "omk") return "mimo";
  return configured || "mimo";
}
