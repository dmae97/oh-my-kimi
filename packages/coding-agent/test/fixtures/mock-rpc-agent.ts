#!/usr/bin/env bun
/**
 * Test fixture: a stand-in for the coding-agent RPC mode.
 *
 * Emits the `ready` frame immediately, echoes each inbound command with a
 * success response, and stays alive until stdin closes or SIGTERM arrives.
 * Used by rpc-client lifecycle tests that need to exercise start/stop/start
 * without booting the full agent runtime (which requires provider credentials).
 */
import * as readline from "node:readline";

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", raw => {
	if (!raw) return;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (frame && typeof frame === "object" && typeof frame.type === "string") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			process.stdout.write(
				`${JSON.stringify({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {},
				})}\n`,
			);
		}
	} catch {
		// ignore parse errors — the test harness sends well-formed frames.
	}
});
rl.on("close", () => process.exit(0));
