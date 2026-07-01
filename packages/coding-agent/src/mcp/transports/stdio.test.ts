import { describe, expect, it } from "bun:test";

import { resolveStdioSpawnCommand, StdioTransport } from "./stdio";

describe("resolveStdioSpawnCommand", () => {
	it("hides Windows executable MCP servers when the host has no console", async () => {
		// Hidden so a console-app child does not allocate a visible window when
		// OMP is launched without a terminal console (#3536).
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: false },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: true,
			detached: false,
		});
	});

	it("inherits an attached Windows console instead of forcing CREATE_NO_WINDOW", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: true },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: false,
			detached: false,
		});
	});

	it("detaches off-Windows MCP servers so terminal job-control signals cannot stop them", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "linux" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			detached: true,
		});
	});
});

// Regression for #3945: request() awaited stdin.write/flush, so a child that
// stops draining stdin would park the async fn past the timeout timer and past
// `return promise`, orphaning the deferred rejection and hanging the caller
// forever. `sleep` is POSIX-only, so the check is scoped to non-Windows hosts.
describe.skipIf(process.platform === "win32")("StdioTransport request write stall", () => {
	it("rejects with the timeout error when the child never drains stdin", async () => {
		const timeoutMs = 400;
		const orphaned: Error[] = [];
		const captureOrphan = (reason: unknown) => {
			if (reason instanceof Error) orphaned.push(reason);
		};
		process.on("unhandledRejection", captureOrphan);

		// `sleep 60` accepts a stdin pipe but never reads it; a 1 MB payload
		// overruns the OS pipe buffer plus any FileSink JS-side buffering, so
		// Bun's write() returns a Promise that only settles if the child reads.
		const transport = new StdioTransport({
			command: "sleep",
			args: ["60"],
			timeout: timeoutMs,
		});

		try {
			await transport.connect();

			const bigParam = "x".repeat(1024 * 1024);
			const started = performance.now();
			const outcome = await transport.request("tools/call", { name: "noop", arguments: { blob: bigParam } }).then(
				() => ({ kind: "resolved" as const }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			);
			const elapsedMs = performance.now() - started;

			expect(outcome.kind).toBe("rejected");
			if (outcome.kind !== "rejected") return;
			if (!(outcome.error instanceof Error)) {
				throw new Error(`expected Error rejection, got ${String(outcome.error)}`);
			}
			expect(outcome.error.message).toContain(`Request timeout after ${timeoutMs}ms`);
			// Generous ceiling: bare rejection latency plus room for slow CI. The
			// pre-fix behavior was an unbounded hang, not a slightly-late reject.
			expect(elapsedMs).toBeLessThan(timeoutMs + 1500);
			expect(orphaned).toEqual([]);
		} finally {
			process.off("unhandledRejection", captureOrphan);
			await transport.close();
		}
	}, 8000);
});
