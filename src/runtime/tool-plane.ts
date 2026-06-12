import { readFile } from "fs/promises";
import { isAbsolute, relative, resolve, sep } from "path";

import { collectMcpConfigs, getProjectRootAsync, getUserHome, writeBuiltinMcpConfig, writeRuntimeMcpConfig } from "../util/fs.js";
import type { OmkRuntimeScope } from "../util/resource-profile.js";
import { stableValueHash } from "./stable-json.js";
import { type OmkToolPrefixSpec, sortToolPrefixSpecs } from "./tool-registry-contract.js";

export interface OmkToolPlaneDiagnostic {
  readonly level: "warning" | "error";
  readonly code: "mcp_config_parse_failed" | "mcp_config_read_failed" | "runtime_mcp_config_parse_failed" | "runtime_mcp_required_unavailable";
  readonly path?: string;
  readonly message: string;
}

export interface OmkToolPlaneManifest {
  readonly owner: "omk";
  readonly mcpServers: readonly string[];
  readonly mcpConfigFile?: string;
  readonly skills: readonly string[];
  readonly hooks: readonly string[];
  readonly tools: readonly string[];
  readonly toolContracts: readonly OmkToolPrefixSpec[];
  readonly toolSpecsHash: string;
  readonly runtimeOwnsMcp: false;
  readonly requiresRuntimeMcp: boolean;
  readonly diagnostics: readonly OmkToolPlaneDiagnostic[];
}

export interface BuildOmkToolPlaneManifestInput {
  readonly mcpScope: OmkRuntimeScope;
  readonly mcpAllowlist?: readonly string[];
  readonly skills?: readonly string[];
  readonly hooks?: readonly string[];
  readonly tools?: readonly string[];
  readonly toolContracts?: readonly OmkToolPrefixSpec[];
  readonly requiresRuntimeMcp?: boolean;
}

export async function buildOmkToolPlaneManifest(
  input: BuildOmkToolPlaneManifestInput
): Promise<OmkToolPlaneManifest> {
  const requiresRuntimeMcp = input.requiresRuntimeMcp === true;
  const resolved = await resolveRuntimeMcpConfigFile(input.mcpScope, input.mcpAllowlist);
  const runtimeRead = resolved.mcpConfigFile ? await readMcpServerNames(resolved.mcpConfigFile) : { servers: [], diagnostics: [] };
  const diagnostics = [...resolved.diagnostics, ...runtimeRead.diagnostics];
  if (requiresRuntimeMcp && (diagnostics.some((diagnostic) => diagnostic.level === "error") || !resolved.mcpConfigFile || runtimeRead.servers.length === 0)) {
    throw new Error(formatRequiredRuntimeMcpError(diagnostics, resolved.mcpConfigFile, runtimeRead.servers));
  }
  const toolContracts = sortToolPrefixSpecs(input.toolContracts ?? []);
  const manifest = {
    owner: "omk" as const,
    mcpServers: runtimeRead.servers,
    mcpConfigFile: resolved.mcpConfigFile ?? undefined,
    skills: unique(input.skills ?? []),
    hooks: unique(input.hooks ?? []),
    tools: unique(input.tools ?? []),
    toolContracts,
    toolSpecsHash: stableValueHash(toolContracts),
    runtimeOwnsMcp: false as const,
    requiresRuntimeMcp,
    diagnostics,
  };
  return manifest;
}

async function resolveRuntimeMcpConfigFile(
  scope: OmkRuntimeScope,
  allowlist: readonly string[] | undefined
): Promise<{ mcpConfigFile: string | null; diagnostics: OmkToolPlaneDiagnostic[] }> {
  if (scope === "none") return { mcpConfigFile: null, diagnostics: [] };
  const configPaths = await collectMcpConfigs(scope);
  const diagnostics = await readMcpConfigDiagnostics(configPaths);
  const builtinMcp = await writeBuiltinMcpConfig();
  const runtimeAllowlist = allowlist !== undefined
    ? unique([...allowlist, "omk-project"])
    : undefined;
  const mcpConfigFile = await writeRuntimeMcpConfig(
    builtinMcp ? [...configPaths, builtinMcp] : configPaths,
    runtimeAllowlist
  );
  return { mcpConfigFile, diagnostics };
}

async function readMcpServerNames(configFile: string): Promise<{ servers: string[]; diagnostics: OmkToolPlaneDiagnostic[] }> {
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf-8")) as { mcpServers?: unknown };
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { servers: [], diagnostics: [] };
    return { servers: unique(Object.keys(servers)), diagnostics: [] };
  } catch (err) {
    return {
      servers: [],
      diagnostics: [await createMcpDiagnostic("runtime_mcp_config_parse_failed", configFile, err)],
    };
  }
}

async function readMcpConfigDiagnostics(configPaths: readonly string[]): Promise<OmkToolPlaneDiagnostic[]> {
  const diagnostics: OmkToolPlaneDiagnostic[] = [];
  for (const configPath of configPaths) {
    try {
      JSON.parse(await readFile(configPath, "utf-8"));
    } catch (err) {
      diagnostics.push(await createMcpDiagnostic(err instanceof SyntaxError ? "mcp_config_parse_failed" : "mcp_config_read_failed", configPath, err));
    }
  }
  return diagnostics;
}

async function createMcpDiagnostic(
  code: OmkToolPlaneDiagnostic["code"],
  path: string,
  err: unknown
): Promise<OmkToolPlaneDiagnostic> {
  return {
    level: "error",
    code,
    path: await formatDiagnosticPath(path),
    message: mcpDiagnosticMessage(err),
  };
}

async function formatDiagnosticPath(path: string): Promise<string> {
  const root = resolve(await getProjectRootAsync());
  const resolvedPath = resolve(path);
  const rootRelative = relative(root, resolvedPath);
  if (isRelativeChildPath(rootRelative)) return rootRelative.split(sep).join("/");
  const home = resolve(getUserHome());
  const homeRelative = relative(home, resolvedPath);
  if (isRelativeChildPath(homeRelative)) return `~/${homeRelative.split(sep).join("/")}`;
  return resolvedPath;
}

function isRelativeChildPath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith("../") && !isAbsolute(path);
}

function mcpDiagnosticMessage(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid JSON";
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return `unreadable MCP config (${(err as { code: string }).code})`;
  }
  return "invalid MCP config";
}

function formatRequiredRuntimeMcpError(
  diagnostics: readonly OmkToolPlaneDiagnostic[],
  mcpConfigFile: string | null,
  servers: readonly string[]
): string {
  const errors = diagnostics
    .filter((diagnostic) => diagnostic.level === "error")
    .map((diagnostic) => `${diagnostic.path ?? "runtime MCP"}: ${diagnostic.message}`);
  if (!mcpConfigFile) errors.push("runtime MCP config was not generated");
  if (mcpConfigFile && servers.length === 0) errors.push("runtime MCP config contains no servers");
  return `[omk] Runtime MCP is required but unavailable: ${unique(errors).join("; ")}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
