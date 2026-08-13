#!/usr/bin/env node
/**
 * Connect to the real configured MCP servers and report what the harness sees.
 *
 * Evidence script, not a test: it proves the client speaks the protocol to
 * production servers on this machine. Prints server state and tool counts only
 * — never env values.
 *
 * Usage: node scripts/mcp-smoke.mjs [serverName ...]
 *
 * Set OMK_MCP_SMOKE_HANDSHAKE_MS to override each server's configured
 * `startup_timeout_sec` (useful for `npx -y ...@latest` servers whose first run
 * has to download the package).
 */

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadMcpServerConfigs } = await jiti.import("../packages/coding-agent/src/core/mcp/config.ts");
const { McpManager } = await jiti.import("../packages/coding-agent/src/core/mcp/manager.ts");

const only = new Set(process.argv.slice(2));
const all = loadMcpServerConfigs(process.cwd());
const servers = only.size > 0 ? all.filter((server) => only.has(server.name)) : all;

if (servers.length === 0) {
	console.log("No stdio MCP servers configured.");
	process.exit(0);
}

console.log(`Connecting ${servers.length} MCP server(s)...\n`);
const started = Date.now();
const handshakeOverride = Number(process.env.OMK_MCP_SMOKE_HANDSHAKE_MS);
const manager = new McpManager({
	servers: servers.map((server) => ({
		...server,
		handshakeTimeoutMs: Number.isFinite(handshakeOverride) && handshakeOverride > 0
			? handshakeOverride
			: (server.handshakeTimeoutMs ?? 30_000),
	})),
	cwd: process.cwd(),
	clientInfo: { name: "omk-mcp-smoke", version: "1" },
});

const tools = await manager.listToolDefinitions();
const elapsed = Date.now() - started;

let ready = 0;
for (const status of manager.status()) {
	const mark = status.state === "ready" ? "OK  " : "FAIL";
	if (status.state === "ready") ready++;
	const detail = status.state === "ready" ? `${status.toolCount} tools (v${status.serverVersion ?? "?"})` : status.error;
	console.log(`${mark} ${status.name.padEnd(20)} ${detail}`);
}

console.log(`\n${ready}/${servers.length} servers ready, ${tools.length} tools exposed, ${elapsed}ms`);
console.log(`sample: ${tools.slice(0, 8).map((tool) => tool.name).join(", ")}`);
manager.close();
process.exit(0);
