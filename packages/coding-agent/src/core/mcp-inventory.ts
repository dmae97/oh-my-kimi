/**
 * Read-only MCP inventory reader.
 *
 * Aggregates MCP server configuration from up to three on-disk sources without
 * starting, stopping, or modifying any server. Secret values from `env` are
 * never exposed — only the key names are returned to callers.
 *
 * Source precedence (later wins on name collision):
 *   1. ~/.kimi/mcp.json           (global, legacy/kimi)
 *   2. ~/.omk/mcp.json            (global, omk)
 *   3. <cwd>/.omk/mcp.json        (project, highest priority)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBuiltinMcpPresets, summarizeBuiltinMcpPreset } from "./mcp-presets.ts";

export type McpInventoryNetworkMode = "none" | "loopback" | "domain-allowlist" | "all-explicit";

export interface McpInventoryNetworkDecision {
	allowed: boolean;
	mode: McpInventoryNetworkMode;
	rule: string;
	reason: string;
	allowedDomains: string[];
	deniedDomains: string[];
	allowUnixSockets: string[];
}

export interface McpServerEntry {
	name: string;
	source: string;
	commandSummary: string;
	envKeys: string[];
	argsCount: number;
	autoApproveCount: number;
	networkDecision: McpInventoryNetworkDecision;
	startupTimeoutSec?: number;
	overriddenBy?: string;
}

export interface McpBuiltinPresetEntry {
	name: string;
	label: string;
	description: string;
	homepage: string;
	repository: string;
	license: string;
	exactPackageSpec: string;
	gitTag: string;
	gitCommit: string;
	commandSummary: string;
	envKeys: string[];
	requiredEnvKeys: string[];
	optionalEnvKeys: string[];
	startupTimeoutSec: number;
	autoApproveCount: number;
	networkDecision: McpInventoryNetworkDecision;
	installHint: string;
	notes: string[];
	configured: boolean;
	configuredBy?: string;
}

export interface McpInventory {
	entries: McpServerEntry[];
	presets: McpBuiltinPresetEntry[];
	sources: { path: string; exists: boolean; serverCount: number }[];
	errors: { path: string; message: string }[];
}

interface RawServer {
	command?: unknown;
	args?: unknown;
	env?: unknown;
	autoApprove?: unknown;
	startup_timeout_sec?: unknown;
	network?: unknown;
}

function readJsonSafe(filePath: string): { value: unknown; error?: string } {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return { value: JSON.parse(raw) };
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { value: null };
		}
		return { value: null, error: err instanceof Error ? err.message : String(err) };
	}
}

function summarizeCommand(server: RawServer): string {
	if (typeof server.command !== "string" || !server.command) {
		return "<unknown>";
	}
	const base = path.basename(server.command);
	if (Array.isArray(server.args) && server.args.length > 0) {
		const first = server.args.find((a) => typeof a === "string" && !a.startsWith("-")) as string | undefined;
		if (first) {
			return `${base} ${first}`.trim();
		}
	}
	return base;
}

function isMcpInventoryNetworkMode(value: unknown): value is McpInventoryNetworkMode {
	return value === "none" || value === "loopback" || value === "domain-allowlist" || value === "all-explicit";
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function mcpNetworkDecision(
	allowed: boolean,
	mode: McpInventoryNetworkMode,
	rule: string,
	reason: string,
	metadata: Pick<McpInventoryNetworkDecision, "allowedDomains" | "deniedDomains" | "allowUnixSockets"> = {
		allowedDomains: [],
		deniedDomains: [],
		allowUnixSockets: [],
	},
): McpInventoryNetworkDecision {
	return { allowed, mode, rule, reason, ...metadata };
}

function decideMcpInventoryNetwork(rawNetwork: unknown): McpInventoryNetworkDecision {
	if (!rawNetwork || typeof rawNetwork !== "object" || Array.isArray(rawNetwork)) {
		return mcpNetworkDecision(
			false,
			"none",
			"mcp.network.unspecified",
			"MCP server network access is denied until an explicit network policy is present.",
		);
	}

	const network = rawNetwork as Record<string, unknown>;
	const mode = network.mode;
	const allowedDomains = stringList(network.allowedDomains);
	const deniedDomains = stringList(network.deniedDomains);
	const allowUnixSockets = stringList(network.allowUnixSockets);
	const metadata = { allowedDomains, deniedDomains, allowUnixSockets };

	if (!isMcpInventoryNetworkMode(mode)) {
		return mcpNetworkDecision(false, "none", "mcp.network.invalid_mode", "MCP network mode is invalid.", metadata);
	}
	if (mode === "none") {
		return mcpNetworkDecision(false, mode, "mcp.network.none", "MCP server network access is disabled.", metadata);
	}
	if (mode === "domain-allowlist" && allowedDomains.length === 0) {
		return mcpNetworkDecision(
			false,
			mode,
			"mcp.network.empty_allowlist",
			"MCP domain allowlist mode requires at least one allowed domain.",
			metadata,
		);
	}
	return mcpNetworkDecision(
		true,
		mode,
		`mcp.network.${mode}`,
		"MCP server network access is explicitly configured.",
		metadata,
	);
}

function toEntry(name: string, server: RawServer, source: string): McpServerEntry {
	const envKeys =
		server.env && typeof server.env === "object" && !Array.isArray(server.env)
			? Object.keys(server.env as Record<string, unknown>)
			: [];
	const argsCount = Array.isArray(server.args) ? server.args.length : 0;
	const autoApproveCount = Array.isArray(server.autoApprove) ? server.autoApprove.length : 0;
	const startupTimeoutSec = typeof server.startup_timeout_sec === "number" ? server.startup_timeout_sec : undefined;
	return {
		name,
		source,
		commandSummary: summarizeCommand(server),
		envKeys,
		argsCount,
		autoApproveCount,
		networkDecision: decideMcpInventoryNetwork(server.network),
		startupTimeoutSec,
	};
}

function extractServers(raw: unknown): Record<string, RawServer> {
	if (!raw || typeof raw !== "object") return {};
	const root = raw as Record<string, unknown>;
	const candidate = root.mcpServers ?? root.servers ?? root.mcp_servers;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
	return candidate as Record<string, RawServer>;
}

/**
 * Build the MCP inventory by merging all configured sources.
 * The returned object is safe to render in the UI — env values are never included.
 */
export function loadMcpInventory(cwd: string = process.cwd(), home: string = os.homedir()): McpInventory {
	const candidatePaths = [
		path.join(home, ".kimi", "mcp.json"),
		path.join(home, ".omk", "mcp.json"),
		path.join(cwd, ".omk", "mcp.json"),
	];

	const sources: McpInventory["sources"] = [];
	const errors: McpInventory["errors"] = [];
	const merged = new Map<string, McpServerEntry>();

	for (const filePath of candidatePaths) {
		const exists = fs.existsSync(filePath);
		const { value, error } = readJsonSafe(filePath);
		if (error) {
			errors.push({ path: filePath, message: error });
		}
		const servers = extractServers(value);
		const names = Object.keys(servers).sort();
		sources.push({ path: filePath, exists, serverCount: names.length });

		for (const name of names) {
			const server = servers[name];
			if (!server || typeof server !== "object") continue;
			const entry = toEntry(name, server as RawServer, filePath);
			const previous = merged.get(name);
			if (previous) {
				previous.overriddenBy = filePath;
			}
			merged.set(name, entry);
		}
	}

	const entries = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
	const presets = listBuiltinMcpPresets()
		.map((preset): McpBuiltinPresetEntry => {
			const configuredEntry = merged.get(preset.name);
			return {
				...summarizeBuiltinMcpPreset(preset),
				networkDecision: configuredEntry?.networkDecision ?? decideMcpInventoryNetwork(undefined),
				configured: configuredEntry !== undefined,
				...(configuredEntry ? { configuredBy: configuredEntry.source } : {}),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	return { entries, presets, sources, errors };
}
