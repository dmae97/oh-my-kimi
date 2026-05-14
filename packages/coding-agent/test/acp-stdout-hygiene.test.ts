/**
 * ACP stdout-hygiene smoke: launching `omp acp` must not leak any banner,
 * progress text, or stray non-JSON bytes onto stdout — that channel is owned
 * by the JSON-RPC protocol. We spawn the CLI as a subprocess, send a single
 * `initialize` frame, and assert the first stdout line parses cleanly as a
 * JSON-RPC response.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const cleanupRoots: string[] = [];
let activeProc: ReturnType<typeof Bun.spawn> | undefined;

afterEach(async () => {
	if (activeProc) {
		try {
			activeProc.kill();
			await activeProc.exited;
		} catch {
			// ignore
		}
		activeProc = undefined;
	}
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function readFirstFrame(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const newlineIdx = buffer.indexOf("\n");
		if (newlineIdx >= 0) {
			reader.releaseLock();
			return buffer.slice(0, newlineIdx);
		}
	}
	reader.releaseLock();
	return buffer;
}

describe("ACP stdout hygiene", () => {
	it("emits a JSON-RPC initialize response as the first bytes on stdout", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-stdout-"));
		cleanupRoots.push(root);
		const home = path.join(root, "home");
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.promises.mkdir(home, { recursive: true });
		await fs.promises.mkdir(xdg, { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });

		const proc = Bun.spawn(["bun", cliEntry, "acp"], {
			cwd: repoRoot,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_DATA_HOME: xdg,
				XDG_CONFIG_HOME: xdg,
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
			},
		});
		activeProc = proc;

		const initRequest = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } },
		};
		proc.stdin.write(new TextEncoder().encode(`${JSON.stringify(initRequest)}\n`));
		proc.stdin.flush();

		// Capture stderr in parallel so we can verify it does not carry any
		// JSON-RPC frame. ACP owns stdout; banners, progress text, or stray
		// protocol bytes on stderr indicate a misroute.
		const stderrChunks: Uint8Array[] = [];
		const stderrPump = (async () => {
			const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) stderrChunks.push(value);
					// Stop once the first stdout frame arrives so the pump terminates
					// alongside the test rather than waiting for process exit.
					if (stderrChunks.length > 32) break;
				}
			} finally {
				reader.releaseLock();
			}
		})();

		const firstLine = await readFirstFrame(proc.stdout as ReadableStream<Uint8Array>);
		expect(firstLine.length).toBeGreaterThan(0);
		expect(firstLine[0]).toBe("{");

		const message = JSON.parse(firstLine) as {
			jsonrpc?: string;
			id?: unknown;
			result?: { protocolVersion?: number; authMethods?: Array<{ type?: string; id?: string }> };
			error?: unknown;
		};
		expect(message.jsonrpc).toBe("2.0");
		expect(message.id).toBe(1);
		expect(message.error).toBeUndefined();
		expect(message.result?.protocolVersion).toBe(1);
		expect(message.result?.authMethods).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "agent" }),
				expect.objectContaining({ type: "terminal", id: "terminal" }),
			]),
		);

		// Terminate the process so the stderr pump promise resolves. Race with a
		// short timeout in case stderr is empty (common path).
		try {
			proc.kill();
		} catch {
			// process may already be exiting
		}
		await Promise.race([stderrPump, new Promise(resolve => setTimeout(resolve, 500))]);
		const stderrText = new TextDecoder().decode(new Uint8Array(stderrChunks.flatMap(chunk => Array.from(chunk))));
		// Guard against JSON-RPC frames sneaking onto stderr. We allow normal
		// stderr output (warnings, telemetry, etc.) but reject anything that
		// parses as a JSON-RPC envelope on the wrong channel.
		for (const line of stderrText.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue;
			let parsed: { jsonrpc?: unknown } | undefined;
			try {
				parsed = JSON.parse(trimmed) as { jsonrpc?: unknown };
			} catch {
				continue;
			}
			expect(parsed?.jsonrpc, `JSON-RPC frame leaked to stderr: ${trimmed}`).toBeUndefined();
		}
	}, 60_000);
});
