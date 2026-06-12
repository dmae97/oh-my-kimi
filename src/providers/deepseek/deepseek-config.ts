import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, posix } from "path";
import { getUserHome } from "../../util/fs.js";

export type DeepSeekDisabledBy = "user" | "provider-402" | "provider-availability";

export interface DeepSeekProviderConfig {
  enabled?: boolean;
  disabledAt?: string;
  disabledReason?: string;
  disabledBy?: DeepSeekDisabledBy | string;
  updatedAt?: string;
  apiKeyEnv?: string;
  model?: string;
  kind?: "openai-compatible";
  baseUrl?: string;
  defaultModel?: string;
  aliases?: Record<string, string>;
  capabilities?: string[];
  thinkingMode?: "thinking" | "non-thinking";
  variant?: "flash" | "pro";
}

export interface GenericProviderConfig {
  enabled?: boolean;
  kind?: "kimi-native" | "openai-compatible" | "external-cli" | "codex-cli" | "local";
  baseUrl?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  model?: string;
  aliases?: Record<string, string>;
  capabilities?: string[];
  wireApi?: string;
  auth?: { method?: string };
  profileType?: string;
  planKind?: string;
  routing?: string;
  headers?: Record<string, string>;
  disabledAt?: string;
  disabledReason?: string;
  disabledBy?: string;
  updatedAt?: string;
}

export interface OmkProvidersConfig {
  version: 1;
  defaults?: {
    provider?: string;
    model?: string;
    authorityProvider?: string;
  };
  modelAliases?: Record<string, string>;
  providers: Record<string, GenericProviderConfig | undefined> & {
    deepseek?: DeepSeekProviderConfig;
  };
}

export interface DeepSeekConfigPathOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DeepSeekApiKeyResolution {
  apiKey?: string;
  apiKeyEnv: string;
  source?: "env" | "omk-secrets" | "opencode-secrets";
  sourcePath?: string;
}

export interface DeepSeekProviderStatus {
  provider: "deepseek";
  enabled: boolean;
  disabledReason?: string;
  disabledBy?: DeepSeekDisabledBy;
  apiKeySet: boolean;
  apiKeySource?: DeepSeekApiKeyResolution["source"];
  configPath: string;
  secretsPath: string;
  thinkingMode?: "thinking" | "non-thinking";
  variant?: "flash" | "pro";
}

const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";

export function getDeepSeekProviderConfigPath(options: DeepSeekConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  return env.OMK_PROVIDER_CONFIG_PATH ?? joinHomePath(resolveHomeDir(options), ".config", "omk", "providers.json");
}

export function getOmkSecretsEnvPath(options: DeepSeekConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  return env.OMK_SECRETS_ENV_PATH ?? joinHomePath(resolveHomeDir(options), ".config", "omk", "secrets.env");
}

export function getOpenCodeSecretsEnvPath(options: DeepSeekConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  return env.OPENCODE_SECRETS_ENV_PATH ?? joinHomePath(resolveHomeDir(options), ".config", "opencode", "secrets.env");
}

export async function readOmkProvidersConfig(
  options: DeepSeekConfigPathOptions = {}
): Promise<OmkProvidersConfig> {
  const path = getDeepSeekProviderConfigPath(options);
  const raw = await readFile(path, "utf-8").catch(() => null);
  if (!raw) return emptyProvidersConfig();

  try {
    const parsed = JSON.parse(raw) as Partial<OmkProvidersConfig>;
    return {
      version: 1,
      defaults: normalizeProviderDefaults(parsed.defaults),
      modelAliases: normalizeStringMap(parsed.modelAliases),
      providers: normalizeProvidersConfig(parsed.providers),
    };
  } catch {
    return emptyProvidersConfig();
  }
}

export async function writeOmkProvidersConfig(
  config: OmkProvidersConfig,
  options: DeepSeekConfigPathOptions = {}
): Promise<string> {
  const path = getDeepSeekProviderConfigPath(options);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export async function setDeepSeekEnabled(
  enabled: boolean,
  options: DeepSeekConfigPathOptions & { reason?: string; disabledBy?: DeepSeekDisabledBy } = {}
): Promise<DeepSeekProviderConfig> {
  const config = await readOmkProvidersConfig(options);
  const current = normalizeDeepSeekProviderConfig(config.providers.deepseek);
  const updatedAt = new Date().toISOString();
  const next: DeepSeekProviderConfig = enabled
    ? {
        ...current,
        enabled: true,
        disabledAt: undefined,
        disabledReason: undefined,
        disabledBy: undefined,
        updatedAt,
      }
    : {
        ...current,
        enabled: false,
        disabledAt: updatedAt,
        disabledReason: options.reason ?? "Disabled by user",
        disabledBy: options.disabledBy ?? "user",
        updatedAt,
      };

  await writeOmkProvidersConfig({ ...config, providers: { ...config.providers, deepseek: next } }, options);
  return next;
}

export async function forceDisableDeepSeek(
  reason: string,
  options: DeepSeekConfigPathOptions & { disabledBy?: DeepSeekDisabledBy } = {}
): Promise<DeepSeekProviderConfig> {
  const disabledBy = options.disabledBy ?? (reason.includes("402") ? "provider-402" : "provider-availability");
  return setDeepSeekEnabled(false, { ...options, reason, disabledBy });
}

export async function setDeepSeekApiKey(
  apiKey: string,
  options: DeepSeekConfigPathOptions & { apiKeyEnv?: string } = {}
): Promise<{ secretsPath: string; apiKeyEnv: string }> {
  const value = apiKey.trim();
  if (!value) throw new Error("DeepSeek API key is empty");
  if (/[\r\n\0]/.test(value)) throw new Error("DeepSeek API key must be a single line");

  const apiKeyEnv = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const secretsPath = getOmkSecretsEnvPath(options);
  await upsertEnvFileValue(secretsPath, apiKeyEnv, value);

  const config = await readOmkProvidersConfig(options);
  const deepseek = {
    ...normalizeDeepSeekProviderConfig(config.providers.deepseek),
    enabled: true,
    apiKeyEnv,
    disabledAt: undefined,
    disabledReason: undefined,
    disabledBy: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeOmkProvidersConfig({ ...config, providers: { ...config.providers, deepseek } }, options);

  return { secretsPath, apiKeyEnv };
}

export async function resolveDeepSeekApiKey(
  options: DeepSeekConfigPathOptions & { apiKeyEnv?: string } = {}
): Promise<DeepSeekApiKeyResolution> {
  const config = await readOmkProvidersConfig(options);
  const apiKeyEnv = options.apiKeyEnv ?? config.providers.deepseek?.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const env = options.env ?? process.env;
  const envValue = env[apiKeyEnv]?.trim();
  if (envValue) return { apiKey: envValue, apiKeyEnv, source: "env" };

  const omkSecretsPath = getOmkSecretsEnvPath(options);
  const omkValue = await readEnvFileValue(omkSecretsPath, apiKeyEnv);
  if (omkValue) return { apiKey: omkValue, apiKeyEnv, source: "omk-secrets", sourcePath: omkSecretsPath };

  const opencodeSecretsPath = getOpenCodeSecretsEnvPath(options);
  const opencodeValue = await readEnvFileValue(opencodeSecretsPath, apiKeyEnv);
  if (opencodeValue) {
    return { apiKey: opencodeValue, apiKeyEnv, source: "opencode-secrets", sourcePath: opencodeSecretsPath };
  }

  return { apiKeyEnv };
}

export async function getDeepSeekProviderStatus(
  options: DeepSeekConfigPathOptions = {}
): Promise<DeepSeekProviderStatus> {
  const [config, key] = await Promise.all([
    readOmkProvidersConfig(options),
    resolveDeepSeekApiKey(options),
  ]);
  const deepseek = normalizeDeepSeekProviderConfig(config.providers.deepseek);
  const enabled = deepseek.enabled !== false;

  return {
    provider: "deepseek",
    enabled,
    disabledReason: deepseek.disabledReason,
    disabledBy: isDeepSeekDisabledBy(deepseek.disabledBy) ? deepseek.disabledBy : undefined,
    apiKeySet: Boolean(key.apiKey),
    apiKeySource: key.source,
    configPath: getDeepSeekProviderConfigPath(options),
    secretsPath: getOmkSecretsEnvPath(options),
    thinkingMode: deepseek.thinkingMode,
    variant: deepseek.variant,
  };
}

export async function setDeepSeekProviderOptions(
  options: { thinkingMode?: "thinking" | "non-thinking"; variant?: "flash" | "pro" },
  pathOptions: DeepSeekConfigPathOptions = {}
): Promise<DeepSeekProviderConfig> {
  const config = await readOmkProvidersConfig(pathOptions);
  const current = normalizeDeepSeekProviderConfig(config.providers.deepseek);
  const updated: DeepSeekProviderConfig = {
    ...current,
    ...options,
    updatedAt: new Date().toISOString(),
  };
  await writeOmkProvidersConfig({ ...config, providers: { ...config.providers, deepseek: updated } }, pathOptions);
  return updated;
}

function resolveHomeDir(options: DeepSeekConfigPathOptions): string {
  return options.homeDir ?? getUserHome(options.env ?? process.env);
}

function joinHomePath(homeDir: string, ...parts: string[]): string {
  return isPosixStyleHome(homeDir) ? posix.join(homeDir, ...parts) : join(homeDir, ...parts);
}

function isPosixStyleHome(homeDir: string): boolean {
  return homeDir.startsWith("/") && !homeDir.startsWith("//") && !homeDir.includes("\\");
}

function emptyProvidersConfig(): OmkProvidersConfig {
  return {
    version: 1,
    providers: {},
  };
}

function normalizeProviderDefaults(value: unknown): OmkProvidersConfig["defaults"] {
  if (!isRecord(value)) return undefined;
  const defaults = {
    provider: typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : undefined,
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined,
    authorityProvider: typeof value.authorityProvider === "string" && value.authorityProvider.trim() ? value.authorityProvider.trim() : undefined,
  };
  return defaults.provider || defaults.model || defaults.authorityProvider ? defaults : undefined;
}

function normalizeProvidersConfig(value: unknown): OmkProvidersConfig["providers"] {
  if (!isRecord(value)) return {};
  const providers: Record<string, GenericProviderConfig> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (id === "deepseek") {
      providers[id] = normalizeDeepSeekProviderConfig(raw);
    } else {
      providers[id] = normalizeGenericProviderConfig(raw);
    }
  }
  return providers as OmkProvidersConfig["providers"];
}

function normalizeDeepSeekProviderConfig(value: unknown): DeepSeekProviderConfig {
  if (!isRecord(value)) return {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    disabledAt: typeof value.disabledAt === "string" ? value.disabledAt : undefined,
    disabledReason: typeof value.disabledReason === "string" ? value.disabledReason : undefined,
    disabledBy: typeof value.disabledBy === "string" && value.disabledBy.trim() ? value.disabledBy : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    apiKeyEnv: typeof value.apiKeyEnv === "string" && value.apiKeyEnv.trim() ? value.apiKeyEnv : undefined,
    model: typeof value.model === "string" && value.model.trim() ? value.model : undefined,
    kind: value.kind === "openai-compatible" ? value.kind : undefined,
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl : undefined,
    defaultModel: typeof value.defaultModel === "string" && value.defaultModel.trim() ? value.defaultModel : undefined,
    aliases: normalizeStringMap(value.aliases),
    capabilities: normalizeStringList(value.capabilities),
    thinkingMode: value.thinkingMode === "thinking" || value.thinkingMode === "non-thinking" ? value.thinkingMode : undefined,
    variant: value.variant === "flash" || value.variant === "pro" ? value.variant : undefined,
  };
}

function normalizeGenericProviderConfig(value: unknown): GenericProviderConfig {
  if (!isRecord(value)) return {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    kind: isProviderKind(value.kind) ? value.kind : undefined,
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl : undefined,
    apiKeyEnv: typeof value.apiKeyEnv === "string" && value.apiKeyEnv.trim() ? value.apiKeyEnv : undefined,
    defaultModel: typeof value.defaultModel === "string" && value.defaultModel.trim() ? value.defaultModel : undefined,
    model: typeof value.model === "string" && value.model.trim() ? value.model : undefined,
    aliases: normalizeStringMap(value.aliases),
    capabilities: normalizeStringList(value.capabilities),
    disabledAt: typeof value.disabledAt === "string" ? value.disabledAt : undefined,
    disabledReason: typeof value.disabledReason === "string" ? value.disabledReason : undefined,
    disabledBy: typeof value.disabledBy === "string" && value.disabledBy.trim() ? value.disabledBy : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return list.length > 0 ? [...new Set(list)] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDeepSeekDisabledBy(value: unknown): value is DeepSeekDisabledBy {
  return value === "user" || value === "provider-402" || value === "provider-availability";
}

function isProviderKind(value: unknown): value is GenericProviderConfig["kind"] {
  return value === "kimi-native" || value === "openai-compatible" || value === "codex-cli" || value === "local";
}

async function upsertEnvFileValue(path: string, name: string, value: string): Promise<void> {
  const existing = await readFile(path, "utf-8").catch(() => "");
  const linePattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=`);
  const nextLine = `export ${name}=${shellSingleQuote(value)}`;
  let replaced = false;

  const lines = existing.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  const nextLines = lines.map((line) => {
    if (linePattern.test(line)) {
      replaced = true;
      return nextLine;
    }
    return line;
  });
  if (!replaced) nextLines.push(nextLine);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, nextLines.join("\n") + "\n", { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

async function readEnvFileValue(path: string, name: string): Promise<string | undefined> {
  const raw = await readFile(path, "utf-8").catch(() => null);
  if (!raw) return undefined;

  const linePattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=\\s*(.*)\\s*$`);
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) continue;
    const parsed = parseEnvValue(match[1] ?? "");
    if (parsed.trim()) return parsed.trim();
  }
  return undefined;
}

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
