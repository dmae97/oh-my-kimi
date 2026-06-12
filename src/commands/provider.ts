import { checkDeepSeekBalance } from "../providers/deepseek/deepseek-balance.js";
import {
  forceDisableDeepSeek,
  getDeepSeekProviderStatus,
  resolveDeepSeekApiKey,
  setDeepSeekApiKey,
  setDeepSeekEnabled,
  setDeepSeekProviderOptions,
} from "../providers/deepseek/deepseek-config.js";
import {
  normalizeProviderId,
  providerDoctorStatus,
  resolveUserModelAlias,
  setProviderDefaults,
  readProviderRegistry,
  setProviderConfig,
  setProviderEnabled,
  type ProviderConfigSetInput,
} from "../providers/model-registry.js";
import type { ProviderAuthMethod, ProviderId, ProviderPlanKind, ProviderProfileType, ProviderWireApi } from "../providers/types.js";
import { maskSensitiveText } from "../util/secret-mask.js";
import { status, label, header, style } from "../util/theme.js";

export interface ProviderDoctorOptions {
  json?: boolean;
  soft?: boolean;
}

export interface ProviderJsonOptions {
  json?: boolean;
}

export interface ProviderDeepSeekSetOptions extends ProviderJsonOptions {
  fromEnv?: string;
}

export interface ProviderSetOptions extends ProviderJsonOptions {
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  kind?: ProviderConfigSetInput["kind"];
  authMethod?: ProviderAuthMethod;
  thinkingMode?: "thinking" | "non-thinking";
  variant?: "flash" | "pro";
}

export interface ProviderAuthOptions extends ProviderJsonOptions {
  method?: ProviderAuthMethod;
  apiKeyEnv?: string;
}

export interface ProviderUseOptions extends ProviderJsonOptions {
  model?: string;
  authority?: boolean;
}

export interface ProviderOAuthOptions extends ProviderJsonOptions {
  apiKeyEnv?: string;
}

export interface ProviderOAuthResult {
  ok: true;
  command: "provider oauth";
  provider: ProviderId;
  authMethod: ProviderAuthMethod | "official-cli-oauth" | "external-provider";
  oauthAvailable: boolean;
  exchangeRequiresBrowser: boolean;
  exchangePerformed: false;
  authBypass: false;
  authJsonRead: false;
  tokenFilesRead: false;
  secretValuesPrinted: false;
  secretsStored: false;
  projectFilesWritten: false;
  tokensRead: false;
  apiKeyEnv?: string;
  checkedAt: string;
  nextActions: string[];
  notes: string[];
}

export type ProviderDeepSeekApiOptions = ProviderDeepSeekSetOptions;

type ApiKeyInputSource = "env" | "stdin" | "prompt";

interface ProviderCompatibilityProfile {
  id: string;
  provider: ProviderId;
  profileType: ProviderProfileType;
  planKind: ProviderPlanKind;
  wireApi: ProviderWireApi;
  authMethod: ProviderAuthMethod;
  routing: "runtime" | "advisory" | "external-cli";
  authority: "authority" | "advisory" | "read-only";
  credentialOwner: "omk-env" | "official-cli" | "provider";
  notes: string[];
}

const PROVIDER_PROFILES: ProviderCompatibilityProfile[] = [
  {
    id: "openai-api",
    provider: "custom",
    profileType: "runtime",
    planKind: "openai-api",
    wireApi: "openai-chat-completions",
    authMethod: "api-key-env",
    routing: "advisory",
    authority: "read-only",
    credentialOwner: "omk-env",
    notes: ["OpenAI-compatible custom providers are advisory/read-only unless primary provider performs the final action."],
  },
  {
    id: "codex-chatgpt-plan",
    provider: "codex",
    profileType: "compatibility",
    planKind: "chatgpt-plan",
    wireApi: "external-cli",
    authMethod: "external-cli",
    routing: "external-cli",
    authority: "advisory",
    credentialOwner: "official-cli",
    notes: ["Use the official Codex CLI login; OMK does not read ~/.codex auth JSON."],
  },
  {
    id: "claude-code-plan",
    provider: "claude",
    profileType: "compatibility",
    planKind: "claude-code-plan",
    wireApi: "external-cli",
    authMethod: "external-cli",
    routing: "external-cli",
    authority: "advisory",
    credentialOwner: "official-cli",
    notes: ["Use the official Claude Code CLI login; OMK does not copy subscription credentials."],
  },
  {
    id: "gemini-cli-plan",
    provider: "gemini",
    profileType: "compatibility",
    planKind: "gemini-cli-plan",
    wireApi: "external-cli",
    authMethod: "external-cli",
    routing: "external-cli",
    authority: "advisory",
    credentialOwner: "official-cli",
    notes: ["Use Gemini CLI Google login or documented environment variables; OMK does not scrape token files."],
  },
  {
    id: "qwen-coding-plan",
    provider: "qwen",
    profileType: "runtime",
    planKind: "qwen-coding-plan",
    wireApi: "openai-chat-completions",
    authMethod: "api-key-env",
    routing: "advisory",
    authority: "read-only",
    credentialOwner: "omk-env",
    notes: ["Qwen/DashScope runs through OpenAI-compatible advisory lanes by env-var reference only."],
  },
  {
    id: "openrouter-credits",
    provider: "openrouter",
    profileType: "runtime",
    planKind: "openrouter-credits",
    wireApi: "openai-chat-completions",
    authMethod: "api-key-env",
    routing: "advisory",
    authority: "read-only",
    credentialOwner: "provider",
    notes: ["Use OPENROUTER_API_KEY; model costs are controlled on OpenRouter."],
  },
  {
    id: "openrouter-byok",
    provider: "openrouter",
    profileType: "runtime",
    planKind: "openrouter-byok",
    wireApi: "openai-chat-completions",
    authMethod: "api-key-env",
    routing: "advisory",
    authority: "read-only",
    credentialOwner: "provider",
    notes: ["Use OpenRouter provider-side BYOK settings; OMK still only sees the OPENROUTER_API_KEY env reference."],
  },
];

export async function providerDoctorCommand(
  provider: string | undefined,
  options: ProviderDoctorOptions = {}
): Promise<void> {
  const target = provider ?? "deepseek";
  if (target !== "deepseek") {
    const normalized = normalizeProviderId(target);
    const payload = await providerDoctorStatus(normalized === "auto" ? "kimi" : normalized);
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(header("Provider doctor"));
      console.log(label("Provider", payload.provider));
      console.log(label("Kind", payload.kind));
      console.log(label("Model", payload.model));
      if (payload.baseUrl) console.log(label("Base URL", payload.baseUrl));
      if (payload.apiKeyEnv) console.log(label("API key env", payload.apiKeySet ? `${payload.apiKeyEnv} (set)` : `${payload.apiKeyEnv} (missing)`));
      console.log(payload.available ? status.ok("Provider available") : status.warn(payload.reason ?? "Provider unavailable"));
      console.log(style.gray("Fallback: primary provider remains the final authority."));
    }
    if (!payload.available && !options.soft) process.exitCode = 1;
    return;
  }

  const providerStatus = await getDeepSeekProviderStatus();
  const key = await resolveDeepSeekApiKey();
  const result = providerStatus.enabled
    ? await checkDeepSeekBalance({ apiKey: key.apiKey })
    : {
        provider: "deepseek" as const,
        available: false,
        checkedAt: Date.now(),
        reason: providerStatus.disabledReason ?? "DeepSeek is disabled",
        disableForRun: true,
      };
  if (options.json) {
    console.log(JSON.stringify({
      ...result,
      enabled: providerStatus.enabled,
      disabledBy: providerStatus.disabledBy,
      apiKeySet: providerStatus.apiKeySet,
      apiKeySource: providerStatus.apiKeySource,
      thinkingMode: providerStatus.thinkingMode,
      variant: providerStatus.variant,
    }, null, 2));
  } else {
    console.log(header("Provider doctor"));
    console.log(label("Provider", "deepseek"));
    console.log(label("Mode", "opportunistic read-only worker"));
    console.log(label("Enabled", providerStatus.enabled ? "yes" : "no"));
    console.log(label("API key", providerStatus.apiKeySet ? `set (${providerStatus.apiKeySource ?? "unknown"})` : "missing"));
    if (providerStatus.thinkingMode) console.log(label("Thinking mode", providerStatus.thinkingMode));
    if (providerStatus.variant) console.log(label("Variant", providerStatus.variant));
    if (result.available) {
      console.log(status.ok("DeepSeek is available"));
      const balances = result.balance?.balance_infos ?? [];
      for (const balance of balances) {
        console.log(label(`Balance ${balance.currency}`, balance.total_balance));
      }
    } else {
      console.log(status.error(result.reason ?? "DeepSeek unavailable"));
      if (!providerStatus.enabled) {
        console.log(style.gray("Run /deepseek-enable or `omk deepseek enable` after fixing the issue."));
      }
      console.log(style.gray("Fallback: primary provider remains the default for all nodes."));
    }
  }

  if (!result.available && !options.soft) {
    process.exitCode = 1;
  }
}

export async function providerListCommand(options: ProviderJsonOptions = {}): Promise<void> {
  const providers = await readProviderRegistry();
  const payload = {
    providers: providers.map((entry) => ({
      provider: entry.id,
      enabled: entry.enabled,
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      apiKeyEnv: entry.apiKeyEnv,
      defaultModel: entry.defaultModel,
      aliases: entry.aliases,
      capabilities: entry.capabilities,
      wireApi: entry.wireApi,
      authMethod: entry.auth?.method,
      profileType: entry.profileType,
      planKind: entry.planKind,
      routing: entry.routing,
      configured: entry.configured,
      disabledReason: entry.disabledReason,
    })),
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(header("Provider registry"));
  for (const provider of payload.providers) {
    console.log(`${provider.enabled ? status.ok("enabled") : status.warn("disabled")} ${provider.provider} ${style.gray(provider.kind)} ${provider.defaultModel}`);
    if (provider.apiKeyEnv) console.log(`  ${label("API key env", provider.apiKeyEnv)}`);
    if (provider.baseUrl) console.log(`  ${label("Base URL", provider.baseUrl)}`);
  }
}

export async function providerSetCommand(
  provider: string,
  options: ProviderSetOptions = {}
): Promise<void> {
  const normalized = normalizeProviderId(provider);
  if (normalized === "auto") throw new Error("Provider id is required");
  const entry = await setProviderConfig(normalized, {
    model: options.model,
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv,
    kind: options.kind,
    authMethod: options.authMethod ? normalizeAuthMethodOption(options.authMethod) : undefined,
    enabled: true,
  });
  if (normalized === "deepseek" && (options.thinkingMode !== undefined || options.variant !== undefined)) {
    await setDeepSeekProviderOptions({
      thinkingMode: options.thinkingMode,
      variant: options.variant,
    });
  }
  const payload = {
    provider: entry.id,
    enabled: entry.enabled,
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    apiKeyEnv: entry.apiKeyEnv,
    defaultModel: entry.defaultModel,
    capabilities: entry.capabilities,
    wireApi: entry.wireApi,
    authMethod: entry.auth?.method,
    profileType: entry.profileType,
    planKind: entry.planKind,
    routing: entry.routing,
  };
  emitProviderMutation("Provider configured", payload, options);
}

export async function providerUseCommand(
  provider: string,
  options: ProviderUseOptions = {}
): Promise<void> {
  const normalized = normalizeProviderId(provider);
  if (normalized === "auto") throw new Error("Provider id is required");
  const entry = await readProviderRegistry().then((providers) => providers.find((candidate) => candidate.id === normalized));
  const resolvedModel = options.model ? await resolveUserModelAlias(options.model) : undefined;
  const model = resolvedModel?.model ?? entry?.defaultModel ?? "default";
  const authorityProvider = options.authority ? normalized : undefined;
  const result = await setProviderDefaults({
    provider: normalized,
    model,
    authorityProvider,
  });
  const payload = {
    ok: true,
    command: "provider use",
    defaultProvider: result.defaults.provider,
    defaultModel: result.defaults.model,
    authorityProvider: result.defaults.authorityProvider,
    modelSource: resolvedModel?.source,
    configPath: result.configPath,
    secretValuesPrinted: false,
    tokenFilesRead: false,
    projectFilesWritten: false,
  };
  emitProviderMutation("Provider default updated", payload, options);
}

export async function providerAuthCommand(
  provider: string,
  options: ProviderAuthOptions = {}
): Promise<void> {
  const normalized = normalizeProviderId(provider);
  if (normalized === "auto") throw new Error("Provider id is required");
  const authMethod = normalizeAuthMethodOption(options.method);
  const apiKeyEnv = authMethod === "api-key-env" || authMethod === "oauth"
    ? normalizeOptionalApiKeyEnv(options.apiKeyEnv ?? defaultApiKeyEnvForProvider(normalized))
    : undefined;
  const entry = await setProviderConfig(normalized, {
    apiKeyEnv,
    authMethod,
    kind: providerKindForAuth(normalized, authMethod),
    enabled: true,
  });
  emitProviderMutation("Provider auth configured", {
    ok: true,
    command: "provider auth",
    provider: entry.id,
    authMethod: entry.auth?.method ?? authMethod,
    apiKeyEnv: authMethod === "api-key-env" || authMethod === "oauth" ? entry.apiKeyEnv : undefined,
    wireApi: entry.wireApi,
    profileType: entry.profileType,
    planKind: entry.planKind,
    routing: entry.routing,
    secretValuesPrinted: false,
    tokenFilesRead: false,
    projectFilesWritten: false,
  }, options);
}

export async function providerProfilesCommand(options: ProviderJsonOptions = {}): Promise<void> {
  const payload = {
    ok: true,
    command: "provider profiles",
    profiles: PROVIDER_PROFILES,
    secretValuesPrinted: false,
    tokenFilesRead: false,
  };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(header("Provider profiles"));
  for (const profile of PROVIDER_PROFILES) {
    console.log(`${status.ok(profile.id)} ${style.gray(profile.provider)} ${profile.planKind}`);
    console.log(`  ${label("Auth", profile.authMethod)}`);
    console.log(`  ${label("Authority", profile.authority)}`);
  }
}

export async function providerEnableCommand(
  provider: string,
  options: ProviderJsonOptions = {}
): Promise<void> {
  const normalized = normalizeProviderId(provider);
  if (normalized === "auto") throw new Error("Provider id is required");
  const entry = await setProviderEnabled(normalized, true);
  emitProviderMutation("Provider enabled", {
    provider: entry.id,
    enabled: entry.enabled,
    kind: entry.kind,
    apiKeyEnv: entry.apiKeyEnv,
    defaultModel: entry.defaultModel,
  }, options);
}

export async function providerDisableCommand(
  provider: string,
  reason = "Disabled by user",
  options: ProviderJsonOptions = {}
): Promise<void> {
  const normalized = normalizeProviderId(provider);
  if (normalized === "auto") throw new Error("Provider id is required");
  const entry = normalized === "deepseek"
    ? await forceDisableDeepSeek(reason, { disabledBy: "user" }).then(() => setProviderEnabled("deepseek", false, reason))
    : await setProviderEnabled(normalized, false, reason);
  emitProviderMutation("Provider disabled", {
    provider: entry.id,
    enabled: entry.enabled,
    disabledReason: entry.disabledReason ?? reason,
  }, options);
}

export async function providerOAuthCommand(
  provider: string | undefined,
  options: ProviderOAuthOptions = {}
): Promise<void> {
  const payload = buildProviderOAuthResult(provider, options);
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(header("Provider OAuth"));
  console.log(label("Provider", payload.provider));
  console.log(label("Auth method", payload.authMethod));
  console.log(label("OAuth exchange", payload.oauthAvailable ? "provider-managed" : "not handled by OMK"));
  console.log(label("Exchange performed", "no"));
  console.log(label("Project files written", "no"));
  console.log(label("Secrets printed", "no"));
  for (const action of payload.nextActions) {
    console.log(`  ${style.gray("•")} ${action}`);
  }
  for (const note of payload.notes) {
    console.log(style.gray(note));
  }
}

export async function providerDeepSeekEnableCommand(options: ProviderJsonOptions = {}): Promise<void> {
  const config = await setDeepSeekEnabled(true);
  const payload = {
    provider: "deepseek",
    enabled: config.enabled !== false,
    message: "DeepSeek opportunistic workers enabled",
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(header("DeepSeek provider"));
    console.log(status.ok(payload.message));
    console.log(style.gray("Primary provider remains the orchestrator; DeepSeek is used only for safe read/review/QA/documentation nodes."));
  }
}

export async function providerDeepSeekDisableCommand(
  reason = "Disabled by user",
  options: ProviderJsonOptions = {}
): Promise<void> {
  const config = await forceDisableDeepSeek(reason, { disabledBy: "user" });
  const payload = {
    provider: "deepseek",
    enabled: config.enabled !== false,
    disabledReason: config.disabledReason,
    disabledBy: config.disabledBy,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(header("DeepSeek provider"));
    console.log(status.warn("DeepSeek forced disabled"));
    console.log(label("Reason", config.disabledReason ?? reason));
    console.log(style.gray("Primary fallback remains active."));
  }
}

export async function providerDeepSeekSetCommand(options: ProviderDeepSeekSetOptions = {}): Promise<void> {
  const input = await resolveApiKeyInput({ ...options, promptWhenTty: true });
  await saveDeepSeekApiKey(input, options);
}

export async function providerDeepSeekApiCommand(
  options: ProviderDeepSeekApiOptions = {}
): Promise<void> {
  const input = await resolveApiKeyInput({
    fromEnv: options.fromEnv,
    promptWhenTty: true,
  });
  await saveDeepSeekApiKey(input, options);
}

async function resolveApiKeyInput(
  options: ProviderDeepSeekSetOptions & { promptWhenTty?: boolean }
): Promise<{ apiKey: string; source: ApiKeyInputSource }> {
  if (options.fromEnv) {
    const value = process.env[options.fromEnv];
    if (!value) throw new Error(`Environment variable is not set: ${options.fromEnv}`);
    return { apiKey: value, source: "env" };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return { apiKey: process.env.DEEPSEEK_API_KEY, source: "env" };
  }

  if (!process.stdin.isTTY) {
    const stdin = await readStdin();
    if (stdin.trim()) return { apiKey: stdin.trim(), source: "stdin" };
  }

  if (options.promptWhenTty && process.stdin.isTTY && process.stdout.isTTY) {
    const { password } = await import("@inquirer/prompts");
    const apiKey = await password({
      message: "DeepSeek API key",
      mask: "*",
      validate: (value) => value.trim().length > 0 || "DeepSeek API key is required",
    });
    return { apiKey, source: "prompt" };
  }

  throw new Error("DeepSeek API key is required. Use `omk deepseek api --from-env DEEPSEEK_API_KEY` or pipe the key via stdin.");
}

async function saveDeepSeekApiKey(
  input: { apiKey: string; source: ApiKeyInputSource },
  options: ProviderJsonOptions = {}
): Promise<void> {
  const result = await setDeepSeekApiKey(input.apiKey);
  const payload = {
    provider: "deepseek",
    enabled: true,
    apiKeySet: true,
    apiKeyEnv: result.apiKeyEnv,
    secretsPath: result.secretsPath,
    source: input.source,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(header("DeepSeek provider"));
    console.log(status.ok("DeepSeek API key saved without printing it"));
    console.log(label("Secret file", result.secretsPath));
    console.log(label("Env", result.apiKeyEnv));
    console.log(style.gray("DeepSeek hybrid routing has been enabled. Run `omk deepseek doctor` to verify balance."));
  }
}

function emitProviderMutation(
  title: string,
  payload: Record<string, unknown>,
  options: ProviderJsonOptions
): void {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(header(title));
  console.log(status.ok(title));
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    console.log(label(key, typeof value === "string" ? value : JSON.stringify(value)));
  }
  console.log(style.gray("Secrets are referenced by env var name only; values are never printed."));
}

export function buildProviderOAuthResult(
  provider: string | undefined,
  options: Pick<ProviderOAuthOptions, "apiKeyEnv"> = {}
): ProviderOAuthResult {
  const target = safeProviderId(provider);
  const apiKeyEnv = normalizeOptionalApiKeyEnv(options.apiKeyEnv ?? defaultApiKeyEnvForProvider(target));
  const commonNotes = [
    "OMK does not read OAuth token files, print token values, or write provider secrets into project files.",
    "Primary provider remains the final authority for provider-routed work.",
  ];

  if (target === "kimi") {
    return {
      ok: true,
      command: "provider oauth",
      provider: target,
      authMethod: "official-cli-oauth",
      oauthAvailable: true,
      exchangeRequiresBrowser: true,
      exchangePerformed: false,
      authBypass: false,
      authJsonRead: false,
      tokenFilesRead: false,
      secretValuesPrinted: false,
      secretsStored: false,
      projectFilesWritten: false,
      tokensRead: false,
      checkedAt: new Date().toISOString(),
      nextActions: [
        "Run `kimi login` in a local terminal to complete the official browser login flow.",
        "Run `omk doctor --soft` after login to verify Kimi CLI availability without printing credentials.",
      ],
      notes: commonNotes,
    };
  }

  if (target === "codex") {
    return {
      ok: true,
      command: "provider oauth",
      provider: target,
      authMethod: "official-cli-oauth",
      oauthAvailable: true,
      exchangeRequiresBrowser: true,
      exchangePerformed: false,
      authBypass: false,
      authJsonRead: false,
      tokenFilesRead: false,
      secretValuesPrinted: false,
      secretsStored: false,
      projectFilesWritten: false,
      tokensRead: false,
      checkedAt: new Date().toISOString(),
      nextActions: [
        "Run `codex login` or `codex login --device-auth` in a local terminal to complete the official flow.",
        "Run `omk provider doctor codex --soft` to verify CLI availability; OMK still does not read ~/.codex/auth.json tokens.",
        "Do not reuse Codex/ChatGPT OAuth tokens as OpenAI-compatible API keys.",
      ],
      notes: commonNotes,
    };
  }

  if (target === "openrouter") {
    return {
      ok: true,
      command: "provider oauth",
      provider: target,
      authMethod: "oauth",
      oauthAvailable: true,
      exchangeRequiresBrowser: true,
      exchangePerformed: false,
      authBypass: false,
      authJsonRead: false,
      tokenFilesRead: false,
      secretValuesPrinted: false,
      secretsStored: false,
      projectFilesWritten: false,
      tokensRead: false,
      apiKeyEnv,
      checkedAt: new Date().toISOString(),
      nextActions: [
        "Complete OpenRouter's browser PKCE flow in a local trusted environment.",
        "Exchange the authorization code through OpenRouter's documented /api/v1/auth/keys flow without printing the returned key.",
        `Store the resulting key in a user-local secret manager or shell as ${apiKeyEnv}.`,
        `Register only metadata with \`omk provider auth openrouter --method oauth --api-key-env ${apiKeyEnv} --json\`.`,
        "Run `omk provider doctor openrouter --soft` after exporting the environment variable.",
      ],
      notes: [
        ...commonNotes,
        "OpenRouter is OpenAI-compatible at https://openrouter.ai/api/v1; OMK routes it as read-only/advisory.",
      ],
    };
  }

  const providerName = target === "deepseek"
    ? "DeepSeek"
    : target === "qwen"
      ? "Qwen/DashScope"
      : target;
  const setCommand = `omk provider set ${target} --api-key-env ${apiKeyEnv}`;
  const apiKeySetup = target === "deepseek"
    ? `For user-local DeepSeek secret storage, use \`omk deepseek api --from-env ${apiKeyEnv}\`; this command does not do that storage.`
    : `Set ${apiKeyEnv} in your shell or secret manager for the one process that needs it.`;

  return {
    ok: true,
    command: "provider oauth",
    provider: target,
    authMethod: target === "custom" ? "external-provider" : "api-key-env",
    oauthAvailable: false,
    exchangeRequiresBrowser: false,
    exchangePerformed: false,
    authBypass: false,
    authJsonRead: false,
    tokenFilesRead: false,
    secretValuesPrinted: false,
    secretsStored: false,
    projectFilesWritten: false,
    tokensRead: false,
    apiKeyEnv,
    checkedAt: new Date().toISOString(),
    nextActions: [
      `${providerName} does not have an OMK-managed OAuth exchange; use provider docs or API-key environment variables.`,
      `Register only the environment variable name with \`${setCommand}\`.`,
      apiKeySetup,
      `Run \`omk provider doctor ${target} --soft\` after setting the environment variable.`,
    ],
    notes: commonNotes,
  };
}

function safeProviderId(value: string | undefined): ProviderId {
  const normalized = normalizeProviderId(value ?? "codex");
  if (normalized === "auto") return "codex";
  const masked = maskSensitiveText(normalized);
  if (masked !== normalized || !/^[a-z][a-z0-9._-]{0,63}$/u.test(normalized)) {
    return "custom";
  }
  return normalized;
}

function normalizeOptionalApiKeyEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) return trimmed;
  throw new Error("Provider API key env must be an environment variable name, not a secret value");
}

function defaultApiKeyEnvForProvider(provider: ProviderId): string {
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "qwen") return "DASHSCOPE_API_KEY";
  return "PROVIDER_API_KEY";
}

function normalizeAuthMethodOption(value: string | undefined): ProviderAuthMethod {
  if (!value) return "api-key-env";
  if (value === "api-key-env" || value === "oauth" || value === "external-cli" || value === "none") return value;
  throw new Error("Provider auth method must be api-key-env, oauth, external-cli, or none");
}

function providerKindForAuth(provider: ProviderId, authMethod: ProviderAuthMethod): ProviderConfigSetInput["kind"] {
  if (provider === "kimi") return "kimi-native";
  if (provider === "codex") return "codex-cli";
  if (authMethod === "external-cli") return "external-cli";
  return "openai-compatible";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
