import { readProviderDefaults, readProviderRegistry, normalizeProviderId, type ProviderRegistryEntry } from "../providers/model-registry.js";
import type { ProviderId } from "../providers/types.js";
import { checkCommand, resolveKimiBin } from "../util/shell.js";
import { style, box } from "../util/theme.js";

export interface AuthCommandOptions {
  json?: boolean;
  doctor?: boolean;
  setup?: boolean;
  soft?: boolean;
}

export interface AuthCenterProviderStatus {
  provider: ProviderId;
  label: string;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  authMethod: string;
  kind: string;
  runtime: string;
  defaultModel: string;
  apiKeyEnv?: string;
  apiKeyEnvPresent?: boolean | "unknown";
  authority: "authority" | "advisory";
  routing?: string;
  reason: string;
  nextActions: string[];
}

export interface AuthCenterReport {
  schema: "omk.auth-center/status.v1";
  ok: boolean;
  command: "auth";
  checkedAt: string;
  mode: "metadata-only";
  defaultProvider: string;
  authorityProvider: string;
  model?: string;
  providers: AuthCenterProviderStatus[];
  tokenFilesRead: false;
  secretValuesRead: false;
  secretValuesPrinted: false;
  projectFilesWritten: false;
}

export async function authCommand(
  provider?: string,
  options: AuthCommandOptions = {}
): Promise<void> {
  const report = await buildAuthCenterReport(provider, { env: process.env });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderAuthCenter(report, options);
  }
  if (!report.ok && !options.soft) {
    process.exitCode = 1;
  }
}

export async function buildAuthCenterReport(
  provider?: string,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<AuthCenterReport> {
  const env = options.env ?? process.env;
  const defaults = await readProviderDefaults({ env });
  const authorityProvider = normalizeProviderId(
    defaults.authorityProvider ?? env.OMK_AUTHORITY_PROVIDER ?? env.OMK_DEFAULT_PROVIDER ?? "kimi"
  );
  const defaultProvider = normalizeProviderId(defaults.provider ?? env.OMK_DEFAULT_PROVIDER ?? "auto");
  const target = provider ? normalizeProviderId(provider) : undefined;
  const registry = await readProviderRegistry({ env });
  const entries = target && target !== "auto"
    ? registry.filter((entry) => entry.id === target)
    : registry;
  const providers = await Promise.all(entries.map((entry) => buildProviderStatus(entry, authorityProvider, env)));
  return {
    schema: "omk.auth-center/status.v1",
    ok: target === undefined || target === "auto" ? providers.length > 0 : providers.every((entry) => entry.available),
    command: "auth",
    checkedAt: new Date().toISOString(),
    mode: "metadata-only",
    defaultProvider,
    authorityProvider: authorityProvider === "auto" ? "kimi" : authorityProvider,
    model: defaults.model,
    providers,
    tokenFilesRead: false,
    secretValuesRead: false,
    secretValuesPrinted: false,
    projectFilesWritten: false,
  };
}

async function buildProviderStatus(
  entry: ProviderRegistryEntry,
  authorityProvider: ProviderId | "auto",
  env: NodeJS.ProcessEnv
): Promise<AuthCenterProviderStatus> {
  const runtime = runtimeName(entry);
  const authMethod = entry.auth?.method ?? "api-key-env";
  const label = providerLabel(entry.id);
  const nextActions = setupActions(entry);
  let available = entry.enabled;
  let apiKeyEnvPresent: boolean | "unknown" | undefined = "unknown";
  let reason = "metadata only; run provider doctor explicitly for health";

  if (entry.kind === "openai-compatible") {
    apiKeyEnvPresent = entry.apiKeyEnv ? Boolean(env[entry.apiKeyEnv]?.trim()) : false;
    available = entry.enabled && apiKeyEnvPresent === true;
    reason = available ? "API-key env is present" : `Missing ${entry.apiKeyEnv ?? "provider API key"} environment variable`;
  } else if (entry.kind === "codex-cli" || entry.kind === "external-cli" || entry.kind === "kimi-native") {
    const command = commandForProvider(entry.id, env);
    const commandOk = command ? await checkCommand(command).catch(() => false) : entry.enabled;
    available = entry.enabled && commandOk;
    reason = available ? `${command ?? runtime} runtime command is available` : `${command ?? runtime} runtime command is missing or disabled`;
    apiKeyEnvPresent = undefined;
  }

  return {
    provider: entry.id,
    label,
    enabled: entry.enabled,
    configured: entry.configured,
    available,
    authMethod,
    kind: entry.kind,
    runtime,
    defaultModel: entry.defaultModel,
    apiKeyEnv: entry.apiKeyEnv,
    apiKeyEnvPresent,
    authority: entry.id === authorityProvider ? "authority" : "advisory",
    routing: entry.routing,
    reason,
    nextActions: available ? [] : nextActions,
  };
}

function renderAuthCenter(report: AuthCenterReport, options: AuthCommandOptions): void {
  const lines: string[] = [];
  lines.push(style.phosphorBold("OMK Auth Center"));
  lines.push(style.phosphorDim(`Default provider: ${report.defaultProvider}`));
  lines.push(style.phosphorDim(`Authority: ${report.authorityProvider}`));
  if (report.model) lines.push(style.phosphorDim(`Model: ${report.model}`));
  lines.push("");
  for (const provider of report.providers) {
    const mark = provider.available ? style.phosphorBold("✓") : provider.enabled ? style.phosphorDim("○") : style.phosphorDim("×");
    const state = provider.available ? "runtime ready" : provider.enabled ? "needs setup" : "disabled";
    const auth = provider.apiKeyEnv ? `${provider.authMethod} ${provider.apiKeyEnv}` : provider.authMethod;
    lines.push(`  ${mark} ${style.phosphor(provider.provider.padEnd(12))} ${style.phosphorDim(state.padEnd(14))} ${style.phosphorDim(auth)}`);
    if ((options.doctor || options.setup) && provider.nextActions.length > 0) {
      for (const action of provider.nextActions.slice(0, 3)) lines.push(style.phosphorDim(`      - ${action}`));
    }
  }
  lines.push("");
  lines.push(style.phosphorDim("Secret policy: tokenFilesRead=false, secretValuesPrinted=false"));
  if (!options.setup) {
    lines.push(style.phosphorDim("Use `omk auth <provider> --setup` for setup actions."));
  }
  console.log(box(lines, "Auth Center"));
}

function commandForProvider(provider: ProviderId, env: NodeJS.ProcessEnv): string | undefined {
  if (provider === "kimi") return resolveKimiBin(env);
  if (provider === "codex") return env.CODEX_BIN ?? "codex";
  if (provider === "opencode") return env.OPENCODE_BIN ?? "opencode";
  if (provider === "commandcode") return env.COMMANDCODE_BIN ?? "commandcode";
  return undefined;
}

function runtimeName(entry: ProviderRegistryEntry): string {
  if (entry.id === "kimi") return "kimi-print";
  if (entry.id === "codex") return "codex-cli";
  if (entry.id === "deepseek") return "deepseek-api";
  if (entry.id === "openrouter") return "openrouter-api";
  if (entry.id === "qwen") return "qwen-api";
  if (entry.id === "opencode") return "opencode-cli";
  if (entry.id === "commandcode") return "commandcode-cli";
  return `${entry.id}-api`;
}

function providerLabel(provider: ProviderId): string {
  if (provider === "kimi") return "Kimi for Coding";
  if (provider === "codex") return "OpenAI Codex";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "opencode") return "OpenCode";
  if (provider === "commandcode") return "CommandCode";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "qwen") return "Qwen/DashScope";
  return provider;
}

function setupActions(entry: ProviderRegistryEntry): string[] {
  if (entry.kind === "openai-compatible") {
    return [
      `export ${entry.apiKeyEnv ?? "PROVIDER_API_KEY"}=...`,
      `omk provider auth ${entry.id} --method api-key-env --api-key-env ${entry.apiKeyEnv ?? "PROVIDER_API_KEY"}`,
      `omk provider doctor ${entry.id} --soft`,
    ];
  }
  if (entry.id === "kimi") return ["npm install -g @anthropic-ai/kimi-code", "kimi login"];
  if (entry.id === "codex") return ["npm install -g @openai/codex", "codex login"];
  if (entry.id === "opencode") return ["cargo install opencode", "opencode login"];
  if (entry.id === "commandcode") return ["npm install -g commandcode", "commandcode login"];
  return [`omk provider doctor ${entry.id} --soft`];
}
