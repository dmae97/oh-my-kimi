/**
 * Runtime MCP server configuration loader.
 *
 * `mcp-inventory.ts` deliberately strips env *values* so its output is safe to
 * render; a client that has to spawn the server needs those values, so loading
 * is split rather than weakening the inventory's redaction guarantee. The
 * objects returned here are runtime-only — never log or render them directly.
 *
 * Source precedence matches the inventory exactly (later wins):
 *   1. ~/.kimi/mcp.json
 *   2. ~/.omk/mcp.json
 *   3. <cwd>/.omk/mcp.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerConfig } from "./manager.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		// A missing or malformed config file yields no servers, never a crash.
		return undefined;
	}
}

function extractServers(raw: unknown): Record<string, unknown> {
	if (!isRecord(raw)) return {};
	const candidate = raw.mcpServers ?? raw.servers ?? raw.mcp_servers;
	return isRecord(candidate) ? candidate : {};
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function toServerConfig(name: string, raw: unknown): McpServerConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const command = raw.command;
	// Only stdio servers are supported; an entry with a `url` is a different transport.
	if (typeof command !== "string" || command.length === 0) return undefined;
	const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : undefined;
	const startupTimeoutSec = typeof raw.startup_timeout_sec === "number" ? raw.startup_timeout_sec : undefined;
	return {
		name,
		command,
		args,
		env: toStringRecord(raw.env),
		cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
		disabled: raw.disabled === true || raw.enabled === false,
		handshakeTimeoutMs: startupTimeoutSec !== undefined ? Math.max(1, startupTimeoutSec) * 1000 : undefined,
	};
}

/** Config file paths consulted, in precedence order. */
export function mcpConfigPaths(cwd: string = process.cwd(), home: string = os.homedir()): string[] {
	return [
		path.join(home, ".kimi", "mcp.json"),
		path.join(home, ".omk", "mcp.json"),
		path.join(cwd, ".omk", "mcp.json"),
	];
}

/**
 * Load spawnable stdio server configs. Entries without a `command` (HTTP/SSE
 * servers) are skipped rather than failing the load, so an unsupported
 * transport in the config cannot disable every other server.
 */
export function loadMcpServerConfigs(cwd: string = process.cwd(), home: string = os.homedir()): McpServerConfig[] {
	const merged = new Map<string, McpServerConfig>();
	for (const filePath of mcpConfigPaths(cwd, home)) {
		const servers = extractServers(readJson(filePath));
		for (const name of Object.keys(servers).sort()) {
			const config = toServerConfig(name, servers[name]);
			if (config) merged.set(name, config);
		}
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
