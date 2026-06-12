import { runShell } from "../util/shell.js";
import {
  readOmkProvidersConfig,
  writeOmkProvidersConfig,
  type DeepSeekConfigPathOptions,
  type GenericProviderConfig,
} from "./deepseek/deepseek-config.js";
import { DEFAULT_AUTHORITY_PROVIDER } from "./types.js";
import type {
  KnownProviderId,
  ProviderAuthMethod,
  ProviderId,
  ProviderKind,
  ProviderModelRef,
  ProviderPlanKind,
  ProviderPolicy,
  ProviderProfileType,
  ProviderWireApi,
} from "./types.js";

export const KNOWN_PROVIDER_IDS = ["kimi", "deepseek", "qwen", "codex", "opencode", "commandcode", "openrouter", "mimo", "local-llm"] as const satisfies readonly KnownProviderId[];
export const QWEN_DASHSCOPE_COMPAT_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const OPENROUTER_COMPAT_BASE_URL = "https://openrouter.ai/api/v1";

export interface ProviderRegistryEntry {
  id: ProviderId;
  enabled: boolean;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  defaultModel: string;
  aliases: Record<string, string>;
  capabilities: string[];
  wireApi?: ProviderWireApi;
  auth?: { method: ProviderAuthMethod };
  profileType?: ProviderProfileType;
  planKind?: ProviderPlanKind;
  routing?: "runtime" | "advisory" | "external-cli";
  headers?: Record<string, string>;
  configured: boolean;
  disabledReason?: string;
  updatedAt?: string;
}

export interface ProviderDoctorStatus {
  provider: ProviderId;
  enabled: boolean;
  available: boolean;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeySet?: boolean;
  codexCliAvailable?: boolean;
  authority: ProviderModelRef["authority"];
  capabilities: string[];
  wireApi?: ProviderWireApi;
  authMethod?: ProviderAuthMethod;
  profileType?: ProviderProfileType;
  planKind?: ProviderPlanKind;
  headers?: Record<string, string>;
  fallbackProvider: ProviderId;
  reason?: string;
}

export interface ProviderConfigSetInput {
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  kind?: ProviderKind;
  enabled?: boolean;
  authMethod?: ProviderAuthMethod;
}

export interface ProviderDefaults {
  provider?: ProviderId;
  model?: string;
  authorityProvider?: ProviderId;
}

export interface ModelAliasResolution {
  input: string;
  provider?: ProviderId;
  model: string;
  source: "user-alias" | "provider-alias" | "builtin-normalizer" | "literal";
}

const DEFAULT_PROVIDER_CONFIGS: Record<KnownProviderId, Omit<ProviderRegistryEntry, "id" | "configured" | "updatedAt">> = {
  kimi: {
    enabled: true,
    kind: "kimi-native",
    defaultModel: "kimi-k2.6",
    aliases: { default: "kimi-k2.6", kimi: "kimi-k2.6", k2: "kimi-k2", "k2.6": "kimi-k2.6", moonshot: "kimi-k2.6", "moonshot-v1": "kimi-k2.6", "kimi-k2": "kimi-k2", "kimi-k2.6": "kimi-k2.6" },
    capabilities: ["authority", "write", "shell", "mcp", "merge", "review"],
    wireApi: "kimi-native",
    auth: { method: "none" },
    profileType: "runtime",
    planKind: "runtime",
    routing: "runtime",
  },
  deepseek: {
    enabled: true,
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash",
    /**
     * DeepSeek model aliases.
     * - `deepseek-chat` and `deepseek-reasoner` are deprecated legacy names.
     * - `deepseek-v4-flash` supports both thinking (default) and non-thinking modes.
     * - `deepseek-v4-pro` is the high-capability tier.
     */
    aliases: {
      default: "deepseek-v4-flash",
      flash: "deepseek-v4-flash",
      pro: "deepseek-v4-pro",
      thinking: "deepseek-v4-flash",
      "non-thinking": "deepseek-v4-flash",
      chat: "deepseek-v4-flash",
      reasoner: "deepseek-v4-flash",
      "deepseek-chat": "deepseek-v4-flash",
      "deepseek-coder": "deepseek-v4-pro",
      "deepseek-reasoner": "deepseek-v4-pro",
      "ds-chat": "deepseek-v4-flash",
      "ds-coder": "deepseek-v4-pro",
      "ds-r1": "deepseek-v4-pro",
      v4: "deepseek-v4-flash",
      "v4-flash": "deepseek-v4-flash",
      "v4-pro": "deepseek-v4-pro",
      "deepseek-v4": "deepseek-v4-flash",
      "deepseek-v4-flash": "deepseek-v4-flash",
      "deepseek-v4-flash-thinking": "deepseek-v4-flash",
      "deepseek-v4-flash-non-thinking": "deepseek-v4-flash",
      "deepseek-v4-pro": "deepseek-v4-pro",
      "deepseek-v4-pro-thinking": "deepseek-v4-pro",
    },
    capabilities: ["read", "review", "qa", "research", "advisory"],
    wireApi: "openai-chat-completions",
    auth: { method: "api-key-env" },
    profileType: "runtime",
    planKind: "runtime",
    routing: "advisory",
  },
  "local-llm": {
    enabled: true,
    kind: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
    apiKeyEnv: "LOCAL_LLM_API_KEY",
    defaultModel: "qwen3-coder-30b-a3b",
    aliases: {
      default: "qwen3-coder-30b-a3b",
      local: "qwen3-coder-30b-a3b",
      llama: "qwen3-coder-30b-a3b",
      qwen3: "qwen3-coder-30b-a3b",
      "qwen3-coder": "qwen3-coder-30b-a3b",
      "local-llm": "qwen3-coder-30b-a3b",
    },
    capabilities: ["read", "write", "shell", "patch", "review"],
    wireApi: "openai-chat-completions",
    auth: { method: "none" },
    profileType: "runtime",
    planKind: "runtime",
    routing: "runtime",
  },
  codex: {
    enabled: true,
    kind: "codex-cli",
    defaultModel: "codex-cli",
    aliases: { default: "codex-cli", codex: "codex-cli", "codex-cli": "codex-cli", "openai-codex": "codex-cli", "gpt-4o-codex": "codex-cli", "codex-latest": "codex-cli", openai: "codex-cli" },
    capabilities: ["read", "plan", "review", "advisory"],
    wireApi: "external-cli",
    auth: { method: "external-cli" },
    profileType: "compatibility",
    planKind: "chatgpt-plan",
    routing: "external-cli",
  },
  opencode: {
    enabled: true,
    kind: "external-cli",
    defaultModel: "opencode-cli",
    aliases: { default: "opencode-cli", opencode: "opencode-cli", "opencode-cli": "opencode-cli" },
    capabilities: ["read", "write", "shell", "patch", "review"],
    wireApi: "external-cli",
    auth: { method: "external-cli" },
    profileType: "runtime",
    planKind: "external-cli",
    routing: "external-cli",
  },
  commandcode: {
    enabled: true,
    kind: "external-cli",
    defaultModel: "commandcode-cli",
    aliases: { default: "commandcode-cli", commandcode: "commandcode-cli", cmd: "commandcode-cli", "commandcode-cli": "commandcode-cli" },
    capabilities: ["read", "write", "shell", "patch", "review"],
    wireApi: "external-cli",
    auth: { method: "external-cli" },
    profileType: "runtime",
    planKind: "external-cli",
    routing: "external-cli",
  },
  qwen: {
    enabled: false,
    kind: "openai-compatible",
    baseUrl: QWEN_DASHSCOPE_COMPAT_BASE_URL,
    apiKeyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen3-max",
    aliases: {
      default: "qwen3-max",
      max: "qwen3-max",
      "qwen-max": "qwen3-max",
      "qwen3-max": "qwen3-max",
      "qwen-3.7-max": "qwen3-max",
      "qwen 3.7 max": "qwen3-max",
      "Qwen 3.7 MAX": "qwen3-max",
      qwen: "qwen3-max",
      "qwen-plus": "qwen3-max",
      "qwen-turbo": "qwen3-max",
      "qwen-coder": "qwen3-max",
      qwen3: "qwen3-max",
      dashscope: "qwen3-max",
    },
    capabilities: ["read", "research", "review", "qa", "advisory"],
    wireApi: "openai-chat-completions",
    auth: { method: "api-key-env" },
    profileType: "runtime",
    planKind: "qwen-coding-plan",
    routing: "advisory",
  },
  openrouter: {
    enabled: false,
    kind: "openai-compatible",
    baseUrl: OPENROUTER_COMPAT_BASE_URL,
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "openrouter/auto",
    aliases: {
      default: "openrouter/auto",
      auto: "openrouter/auto",
      "openrouter-default": "openrouter/auto",
      "openrouter/auto": "openrouter/auto",
      or: "openrouter/auto",
      router: "openrouter/auto",
      "gpt-4": "openai/gpt-4",
      "gpt-4o": "openai/gpt-4o",
      "gpt-4o-mini": "openai/gpt-4o-mini",
      "gpt-5": "openai/gpt-5",
      "gpt-5.1": "openai/gpt-5.1",
      claude: "anthropic/claude-sonnet",
      "claude-sonnet": "anthropic/claude-sonnet",
      "claude-opus": "anthropic/claude-opus",
      "claude-haiku": "anthropic/claude-haiku",
      sonnet: "anthropic/claude-sonnet",
      opus: "anthropic/claude-opus",
      haiku: "anthropic/claude-haiku",
      gemini: "google/gemini-pro",
      "gemini-pro": "google/gemini-pro",
      "gemini-flash": "google/gemini-flash",
      deepseek: "deepseek/deepseek-chat",
      "deepseek-chat": "deepseek/deepseek-chat",
      "deepseek-coder": "deepseek/deepseek-coder",
      qwen: "qwen/qwen-max",
      "qwen-max": "qwen/qwen-max",
      latest: "openrouter/auto",
      best: "openrouter/auto",
      "openai/gpt-latest": "openai/gpt-latest",
      "anthropic/claude-sonnet": "anthropic/claude-sonnet",
      "anthropic/claude-opus": "anthropic/claude-opus",
    },
    capabilities: ["read", "research", "review", "qa", "advisory"],
    wireApi: "openai-chat-completions",
    auth: { method: "api-key-env" },
    profileType: "runtime",
    planKind: "openrouter-credits",
    routing: "advisory",
    headers: {
      "HTTP-Referer": "https://github.com/dmae97/open_multi-agent_kit",
      "X-OpenRouter-Title": "open_multi-agent_kit",
    },
  },
  mimo: {
    enabled: true,
    kind: "openai-compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKeyEnv: "MIMO_API_KEY",
    defaultModel: "mimo-v2.5-pro",
    aliases: {
      default: "mimo-v2.5-pro",
      mimo: "mimo-v2.5-pro",
      "mimo-v2": "mimo-v2.5-pro",
      "mimo-v2.5-pro": "mimo-v2.5-pro",
    },
    capabilities: ["read", "write", "research", "review", "thinking"],
    wireApi: "openai-chat-completions",
    auth: { method: "api-key-env" },
    profileType: "runtime",
    planKind: "runtime",
    routing: "runtime",
  },
};

export function normalizeProviderPolicy(value: string | undefined): ProviderPolicy {
  const normalizedText = value?.trim().toLowerCase();
  if (normalizedText === "authority" || normalizedText === "primary" || normalizedText === "omk") return "authority";
  const normalized = normalizeProviderId(value);
  return normalized === "kimi" || normalized === "deepseek" || normalized === "codex" || normalized === "qwen" || normalized === "openrouter" || normalized === "opencode" || normalized === "commandcode" || normalized === "mimo"
    ? normalized as ProviderPolicy
    : "auto";
}

export function normalizeProviderId(value: string | undefined): ProviderId | "auto" {
  const trimmed = value?.trim();
  if (!trimmed) return "auto";
  const lower = trimmed.toLowerCase();
  if (lower === "auto") return "auto";
  if (lower === "kimi" || lower === "moonshot") return "kimi";
  if (lower === "deepseek" || lower === "deepseek-v4" || lower === "ds") return "deepseek";
  if (lower === "codex" || lower === "openai-codex") return "codex";
  if (lower === "opencode" || lower === "open-code") return "opencode";
  if (lower === "commandcode" || lower === "command-code" || lower === "cmd") return "commandcode";
  if (lower === "qwen" || lower === "dashscope" || lower === "qwen3" || lower === "qwen-max") return "qwen";
  if (lower === "openrouter" || lower === "openrouter-ai") return "openrouter";
  if (lower === "mimo" || lower === "mimo-v2" || lower === "mimo-v2.5-pro") return "mimo";
  if (lower === "claude" || lower === "anthropic") return "openrouter";
  if (lower === "gpt" || lower === "openai") return "openrouter";
  if (lower === "gemini" || lower === "google") return "openrouter";
  return lower;
}

export function parseProviderModelArg(value: string | undefined): { provider?: ProviderId; model?: string } {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const provider = normalizeProviderId(trimmed.slice(0, slash));
    return {
      provider: provider === "auto" ? undefined : provider,
      model: normalizeModelAlias(trimmed.slice(slash + 1)),
    };
  }
  const model = normalizeModelAlias(trimmed);
  const provider = inferProviderFromModel(model);
  return provider === undefined ? { model } : { provider, model };
}

function inferProviderFromModel(model: string): ProviderId | undefined {
  const lower = model.toLowerCase();
  if (
    lower === "deepseek-v4-flash" ||
    lower === "deepseek-v4-pro" ||
    lower === "flash" ||
    lower === "pro" ||
    lower === "thinking" ||
    lower === "non-thinking" ||
    lower === "reasoner"
  ) return "deepseek";
  if (lower === "codex-cli" || lower === "codex") return "codex";
  if (lower.startsWith("claude-") || lower.startsWith("gpt-") || lower.startsWith("gemini-")) return "openrouter";
  return undefined;
}

export function normalizeModelAlias(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase().replace(/[_\s]+/g, "-");
  if (lower === "qwen-3.7-max" || lower === "qwen3.7-max" || lower === "qwen-3-7-max" || lower === "qwen-max") return "qwen3-max";
  if (lower === "sonnet") return "claude-sonnet";
  if (lower === "opus") return "claude-opus";
  if (lower === "haiku") return "claude-haiku";
  if (lower === "gpt-4") return "gpt-4";
  if (lower === "gpt-4o") return "gpt-4o";
  if (lower === "gpt-4o-mini") return "gpt-4o-mini";
  if (lower === "gemini-pro") return "gemini-pro";
  if (lower === "gemini-flash") return "gemini-flash";
  if (lower === "flash") return "deepseek-v4-flash";
  if (lower === "pro") return "deepseek-v4-pro";
  if (lower === "thinking") return "deepseek-v4-flash";
  if (lower === "non-thinking") return "deepseek-v4-flash";
  if (lower === "reasoner") return "deepseek-v4-flash";
  if (lower === "codex") return "codex-cli";
  return trimmed;
}

export async function readProviderDefaults(options: DeepSeekConfigPathOptions = {}): Promise<ProviderDefaults> {
  const config = await readOmkProvidersConfig(options);
  const provider = normalizeProviderId(config.defaults?.provider);
  const authorityProvider = normalizeProviderId(config.defaults?.authorityProvider);
  return {
    provider: provider === "auto" ? undefined : provider,
    model: config.defaults?.model ? normalizeModelAlias(config.defaults.model) : undefined,
    authorityProvider: authorityProvider === "auto" ? undefined : authorityProvider,
  };
}

export async function setProviderDefaults(
  input: ProviderDefaults,
  options: DeepSeekConfigPathOptions = {}
): Promise<{ defaults: ProviderDefaults; configPath: string }> {
  const config = await readOmkProvidersConfig(options);
  const provider = normalizeProviderId(input.provider);
  const authorityProvider = normalizeProviderId(input.authorityProvider);
  const defaults: ProviderDefaults = {
    ...(config.defaults ?? {}),
    provider: provider === "auto" ? config.defaults?.provider : provider,
    model: input.model ? normalizeModelAlias(input.model) : config.defaults?.model,
    authorityProvider: authorityProvider === "auto" ? config.defaults?.authorityProvider : authorityProvider,
  };
  const configPath = await writeOmkProvidersConfig({ ...config, defaults }, options);
  return { defaults, configPath };
}

export async function listUserModelAliases(options: DeepSeekConfigPathOptions = {}): Promise<Record<string, string>> {
  const config = await readOmkProvidersConfig(options);
  return { ...(config.modelAliases ?? {}) };
}

export async function setUserModelAlias(
  alias: string,
  target: string,
  options: DeepSeekConfigPathOptions = {}
): Promise<{ aliases: Record<string, string>; key: string; value: string; configPath: string }> {
  const key = normalizeUserModelAliasName(alias);
  const parsed = parseProviderModelArg(target);
  if (!parsed.model) throw new Error("Model alias target is required");
  const value = parsed.provider ? `${parsed.provider}/${parsed.model}` : parsed.model;
  const config = await readOmkProvidersConfig(options);
  const aliases = { ...(config.modelAliases ?? {}), [key]: value };
  const configPath = await writeOmkProvidersConfig({ ...config, modelAliases: aliases }, options);
  return { aliases, key, value, configPath };
}

export async function removeUserModelAlias(
  alias: string,
  options: DeepSeekConfigPathOptions = {}
): Promise<{ aliases: Record<string, string>; key: string; removed: boolean; configPath: string }> {
  const key = normalizeUserModelAliasName(alias);
  const config = await readOmkProvidersConfig(options);
  const aliases = { ...(config.modelAliases ?? {}) };
  const removed = Object.prototype.hasOwnProperty.call(aliases, key);
  delete aliases[key];
  const configPath = await writeOmkProvidersConfig({ ...config, modelAliases: aliases }, options);
  return { aliases, key, removed, configPath };
}

export async function resolveUserModelAlias(
  value: string,
  options: DeepSeekConfigPathOptions = {}
): Promise<ModelAliasResolution> {
  const input = value.trim();
  if (!input) throw new Error("Model name or alias is required");
  const config = await readOmkProvidersConfig(options);
  const userAlias = config.modelAliases?.[input.toLowerCase()];
  if (userAlias) {
    const parsed = parseProviderModelArg(userAlias);
    if (!parsed.model) throw new Error(`Model alias '${input}' has an invalid target`);
    return {
      input,
      provider: parsed.provider,
      model: parsed.model,
      source: "user-alias",
    };
  }
  const parsed = parseProviderModelArg(input);
  if (!parsed.model) throw new Error("Model name or alias is required");
  return {
    input,
    provider: parsed.provider,
    model: parsed.model,
    source: parsed.provider ? "provider-alias" : parsed.model === input ? "literal" : "builtin-normalizer",
  };
}

export async function readProviderRegistry(options: DeepSeekConfigPathOptions = {}): Promise<ProviderRegistryEntry[]> {
  const config = await readOmkProvidersConfig(options);
  const ids = new Set<string>([...KNOWN_PROVIDER_IDS, ...Object.keys(config.providers)]);
  return [...ids].sort(providerSort).map((id) => mergeProviderConfig(id, config.providers[id]));
}

export async function getProviderRegistryEntry(
  provider: ProviderId,
  options: DeepSeekConfigPathOptions = {}
): Promise<ProviderRegistryEntry> {
  const config = await readOmkProvidersConfig(options);
  return mergeProviderConfig(provider, config.providers[provider]);
}

export async function setProviderConfig(
  provider: ProviderId,
  input: ProviderConfigSetInput,
  options: DeepSeekConfigPathOptions = {}
): Promise<ProviderRegistryEntry> {
  const id = normalizeProviderId(provider);
  if (id === "auto") throw new Error("Provider id is required");
  const config = await readOmkProvidersConfig(options);
  const current = mergeProviderConfig(id, config.providers[id]);
  const apiKeyEnv = input.apiKeyEnv === undefined ? current.apiKeyEnv : normalizeApiKeyEnvName(input.apiKeyEnv);
  const updated: GenericProviderConfig = {
    ...(config.providers[id] ?? {}),
    enabled: input.enabled ?? true,
    kind: input.kind && isProviderKind(input.kind) ? input.kind : current.kind,
    baseUrl: input.baseUrl ?? current.baseUrl,
    apiKeyEnv,
    defaultModel: input.model ? normalizeModelAlias(input.model) : current.defaultModel,
    model: input.model ? normalizeModelAlias(input.model) : current.defaultModel,
    aliases: current.aliases,
    capabilities: current.capabilities,
    wireApi: current.wireApi,
    auth: { method: input.authMethod ?? current.auth?.method ?? "api-key-env" },
    profileType: current.profileType,
    planKind: current.planKind,
    routing: current.routing,
    headers: current.headers,
    disabledAt: input.enabled === false ? new Date().toISOString() : undefined,
    disabledReason: input.enabled === false ? "Disabled by user" : undefined,
    disabledBy: input.enabled === false ? "user" : undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeOmkProvidersConfig({
    ...config,
    providers: { ...config.providers, [id]: updated },
  }, options);
  return mergeProviderConfig(id, updated);
}

function normalizeApiKeyEnvName(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  throw new Error("Provider API key env must be an environment variable name, not a secret value");
}

function isProviderKind(value: string): value is ProviderKind {
  return value === "kimi-native" || value === "openai-compatible" || value === "external-cli" || value === "codex-cli" || value === "local";
}

export async function setProviderEnabled(
  provider: ProviderId,
  enabled: boolean,
  reason = "Disabled by user",
  options: DeepSeekConfigPathOptions = {}
): Promise<ProviderRegistryEntry> {
  const id = normalizeProviderId(provider);
  if (id === "auto") throw new Error("Provider id is required");
  const config = await readOmkProvidersConfig(options);
  const current = mergeProviderConfig(id, config.providers[id]);
  const updated: GenericProviderConfig = {
    ...(config.providers[id] ?? {}),
    kind: current.kind,
    baseUrl: current.baseUrl,
    apiKeyEnv: current.apiKeyEnv,
    defaultModel: current.defaultModel,
    model: current.defaultModel,
    aliases: current.aliases,
    capabilities: current.capabilities,
    wireApi: current.wireApi,
    auth: current.auth,
    profileType: current.profileType,
    planKind: current.planKind,
    routing: current.routing,
    headers: current.headers,
    enabled,
    disabledAt: enabled ? undefined : new Date().toISOString(),
    disabledReason: enabled ? undefined : reason,
    disabledBy: enabled ? undefined : "user",
    updatedAt: new Date().toISOString(),
  };
  await writeOmkProvidersConfig({
    ...config,
    providers: { ...config.providers, [id]: updated },
  }, options);
  return mergeProviderConfig(id, updated);
}

export function resolveProviderModelRef(
  entry: ProviderRegistryEntry,
  requestedModel: string | undefined,
  authority: ProviderModelRef["authority"]
): ProviderModelRef {
  const raw = requestedModel ? normalizeModelAlias(requestedModel) : entry.defaultModel;
  const model = entry.aliases[raw] ?? entry.aliases[raw.toLowerCase()] ?? raw;
  return {
    provider: entry.id,
    model,
    authority,
    capabilities: entry.capabilities,
  };
}

export async function providerDoctorStatus(
  provider: ProviderId,
  options: DeepSeekConfigPathOptions & { env?: NodeJS.ProcessEnv; authorityProvider?: ProviderId } = {}
): Promise<ProviderDoctorStatus> {
  const entry = await getProviderRegistryEntry(provider, options);
  const authorityProvider = resolveDoctorAuthorityProvider(options);
  if (entry.id === "codex") {
    const codexCliAvailable = await isCodexCliAvailable();
    const available = entry.enabled && codexCliAvailable;
    return {
      provider: entry.id,
      enabled: entry.enabled,
      available,
      kind: entry.kind,
      model: entry.defaultModel,
      capabilities: entry.capabilities,
      wireApi: entry.wireApi,
      authMethod: entry.auth?.method,
      profileType: entry.profileType,
      planKind: entry.planKind,
      codexCliAvailable,
      authority: entry.id === authorityProvider ? "authority" : "advisory",
      fallbackProvider: authorityProvider,
      reason: available
        ? "Codex CLI available; OMK does not read ~/.codex/auth.json"
        : "Codex CLI missing/disabled or authentication not verified; primary fallback is active",
    };
  }
  const apiKeySet = entry.apiKeyEnv ? Boolean((options.env ?? process.env)[entry.apiKeyEnv]?.trim()) : undefined;
  const needsKey = entry.kind === "openai-compatible";
  const available = entry.enabled && (!needsKey || apiKeySet === true);
  return {
    provider: entry.id,
    enabled: entry.enabled,
    available,
    kind: entry.kind,
    model: entry.defaultModel,
    baseUrl: entry.baseUrl,
    apiKeyEnv: entry.apiKeyEnv,
    apiKeySet,
    capabilities: entry.capabilities,
    wireApi: entry.wireApi,
    authMethod: entry.auth?.method,
    profileType: entry.profileType,
    planKind: entry.planKind,
    headers: entry.headers,
    authority: entry.id === authorityProvider ? "authority" : "advisory",
    fallbackProvider: authorityProvider,
    reason: available
      ? "Provider configured"
      : entry.enabled
        ? `Missing ${entry.apiKeyEnv ?? "provider"} environment variable; primary fallback is active`
        : entry.disabledReason ?? "Provider disabled; primary fallback is active",
  };
}

function resolveDoctorAuthorityProvider(
  options: DeepSeekConfigPathOptions & { env?: NodeJS.ProcessEnv; authorityProvider?: ProviderId }
): ProviderId {
  if (options.authorityProvider) return options.authorityProvider;
  const normalized = normalizeProviderId(options.env?.OMK_AUTHORITY_PROVIDER ?? process.env.OMK_AUTHORITY_PROVIDER);
  return normalized === "auto" ? DEFAULT_AUTHORITY_PROVIDER : normalized;
}

function mergeProviderConfig(id: string, stored: GenericProviderConfig | undefined): ProviderRegistryEntry {
  const known = isKnownProviderId(id) ? DEFAULT_PROVIDER_CONFIGS[id] : undefined;
  const aliases = { ...(known?.aliases ?? {}), ...(stored?.aliases ?? {}) };
  const defaultModel = stored?.defaultModel ?? stored?.model ?? known?.defaultModel ?? "default";
  return {
    id,
    enabled: stored?.enabled ?? known?.enabled ?? false,
    kind: stored?.kind ?? known?.kind ?? "openai-compatible",
    baseUrl: stored?.baseUrl ?? known?.baseUrl,
    apiKeyEnv: stored?.apiKeyEnv ?? known?.apiKeyEnv,
    defaultModel: normalizeModelAlias(defaultModel),
    aliases,
    capabilities: stored?.capabilities ?? known?.capabilities ?? ["read", "advisory"],
    wireApi: normalizeWireApi(stored?.wireApi) ?? known?.wireApi ?? "openai-chat-completions",
    auth: { method: normalizeAuthMethod(stored?.auth?.method) ?? known?.auth?.method ?? "api-key-env" },
    profileType: normalizeProfileType(stored?.profileType) ?? known?.profileType ?? "runtime",
    planKind: normalizePlanKind(stored?.planKind) ?? known?.planKind ?? "runtime",
    routing: normalizeRouting(stored?.routing) ?? known?.routing ?? "advisory",
    headers: { ...(known?.headers ?? {}), ...(stored?.headers ?? {}) },
    configured: Boolean(stored),
    disabledReason: stored?.disabledReason,
    updatedAt: stored?.updatedAt,
  };
}

function providerSort(a: string, b: string): number {
  const ai = KNOWN_PROVIDER_IDS.indexOf(a as KnownProviderId);
  const bi = KNOWN_PROVIDER_IDS.indexOf(b as KnownProviderId);
  if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  return a.localeCompare(b);
}

function isKnownProviderId(value: string): value is KnownProviderId {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(value);
}

function normalizeWireApi(value: string | undefined): ProviderWireApi | undefined {
  if (value === "kimi-native" || value === "openai-chat-completions" || value === "openai-responses" || value === "external-cli") return value;
  return undefined;
}

function normalizeAuthMethod(value: string | undefined): ProviderAuthMethod | undefined {
  if (value === "api-key-env" || value === "oauth" || value === "external-cli" || value === "none") return value;
  return undefined;
}

function normalizeProfileType(value: string | undefined): ProviderProfileType | undefined {
  if (value === "runtime" || value === "compatibility") return value;
  return undefined;
}

function normalizePlanKind(value: string | undefined): ProviderPlanKind | undefined {
  if (
    value === "runtime" ||
    value === "openai-api" ||
    value === "chatgpt-plan" ||
    value === "claude-code-plan" ||
    value === "gemini-cli-plan" ||
    value === "external-cli" ||
    value === "qwen-coding-plan" ||
    value === "openrouter-credits" ||
    value === "openrouter-byok"
  ) return value;
  return undefined;
}

function normalizeRouting(value: string | undefined): "runtime" | "advisory" | "external-cli" | undefined {
  if (value === "runtime" || value === "advisory" || value === "external-cli") return value;
  return undefined;
}

function normalizeUserModelAliasName(value: string): string {
  const key = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(key)) {
    throw new Error("Model alias must match /^[a-z][a-z0-9._-]{0,63}$/");
  }
  return key;
}

async function isCodexCliAvailable(): Promise<boolean> {
  const result = await runShell("codex", ["--version"], { timeout: 5000 });
  return !result.failed;
}
