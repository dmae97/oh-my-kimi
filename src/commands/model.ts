import {
  listUserModelAliases,
  readProviderDefaults,
  readProviderRegistry,
  resolveUserModelAlias,
  setProviderDefaults,
  setUserModelAlias,
  removeUserModelAlias,
} from "../providers/model-registry.js";
import { header, label, status } from "../util/theme.js";

export interface ModelJsonOptions {
  json?: boolean;
}

export async function modelListCommand(options: ModelJsonOptions = {}): Promise<void> {
  const [providers, userAliases] = await Promise.all([readProviderRegistry(), listUserModelAliases()]);
  const payload = {
    ok: true,
    command: "model list",
    providers: providers.map((entry) => ({
      provider: entry.id,
      defaultModel: entry.defaultModel,
      aliases: entry.aliases,
      enabled: entry.enabled,
    })),
    userAliases,
    secretValuesPrinted: false,
    tokenFilesRead: false,
  };
  emitModelPayload("Model registry", payload, options);
}

export async function modelAliasesCommand(options: ModelJsonOptions = {}): Promise<void> {
  const aliases = await listUserModelAliases();
  const payload = {
    ok: true,
    command: "model aliases",
    aliases,
    secretValuesPrinted: false,
    tokenFilesRead: false,
  };
  emitModelPayload("Model aliases", payload, options);
}

export async function modelAliasAddCommand(
  alias: string,
  target: string,
  options: ModelJsonOptions = {}
): Promise<void> {
  const result = await setUserModelAlias(alias, target);
  const payload = {
    ok: true,
    command: "model alias add",
    alias: result.key,
    target: result.value,
    aliases: result.aliases,
    configPath: result.configPath,
    secretValuesPrinted: false,
    tokenFilesRead: false,
  };
  emitModelPayload("Model alias added", payload, options);
}

export async function modelAliasRemoveCommand(alias: string, options: ModelJsonOptions = {}): Promise<void> {
  const result = await removeUserModelAlias(alias);
  const payload = {
    ok: true,
    command: "model alias remove",
    alias: result.key,
    removed: result.removed,
    aliases: result.aliases,
    configPath: result.configPath,
    secretValuesPrinted: false,
    tokenFilesRead: false,
  };
  emitModelPayload("Model alias removed", payload, options);
}

export async function modelResolveCommand(model: string, options: ModelJsonOptions = {}): Promise<void> {
  const resolved = await resolveUserModelAlias(model);
  const payload = {
    ok: true,
    command: "model resolve",
    input: resolved.input,
    provider: resolved.provider,
    model: resolved.model,
    source: resolved.source,
    secretValuesPrinted: false,
    tokenFilesRead: false,
  };
  emitModelPayload("Model resolved", payload, options);
}

export async function modelUseCommand(model: string, options: ModelJsonOptions = {}): Promise<void> {
  const resolved = await resolveUserModelAlias(model);
  const defaults = await readProviderDefaults();
  const result = await setProviderDefaults({
    provider: resolved.provider ?? defaults.provider,
    model: resolved.model,
  });
  const payload = {
    ok: true,
    command: "model use",
    input: resolved.input,
    defaultProvider: result.defaults.provider,
    defaultModel: result.defaults.model,
    modelSource: resolved.source,
    configPath: result.configPath,
    secretValuesPrinted: false,
    tokenFilesRead: false,
  };
  emitModelPayload("Default model updated", payload, options);
}

function emitModelPayload(title: string, payload: Record<string, unknown>, options: ModelJsonOptions): void {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(header(title));
  for (const [key, value] of Object.entries(payload)) {
    if (key === "aliases" || key === "providers") continue;
    console.log(label(key, String(value)));
  }
  console.log(status.ok("secretValuesPrinted=false tokenFilesRead=false"));
}
