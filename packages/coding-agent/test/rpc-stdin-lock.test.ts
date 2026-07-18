import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

async function expectRpcModeOwnsStdin(mode: "rpc" | "rpc-ui"): Promise<void> {
	const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
	const extensionPath = path.join(import.meta.dir, "fixtures", "locked-stdin-reader.ts");
	const child = Bun.spawn(
		[
			"bun",
			cliPath,
			"--extension",
			extensionPath,
			"--mode",
			mode,
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();

	child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
	await child.stdin.flush();

	let stateResponse: Record<string, unknown> | undefined;
	try {
		for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
			if (isRecord(frame) && frame.type === "response" && frame.id === "probe") {
				stateResponse = frame;
				break;
			}
		}
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited.catch(() => {});
	}

	const stderr = await stderrPromise;
	expect(stderr).not.toContain("ReadableStream is locked");
	expect(stateResponse?.success).toBe(true);
}

describe("RPC mode stdin ownership", () => {
	test("rpc claims stdin before extensions can lock its singleton stream", () => expectRpcModeOwnsStdin("rpc"), 30000);
	test(
		"rpc-ui claims stdin before extensions can lock its singleton stream",
		() => expectRpcModeOwnsStdin("rpc-ui"),
		30000,
	);
});
