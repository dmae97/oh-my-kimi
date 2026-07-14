import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

/**
 * Regression test for issue #5194: a non-JSON stdin line crashed the whole RPC
 * process with an uncaught `SyntaxError: Failed to parse JSONL` escaping the
 * frame loop. A malformed line must instead be reported as an error frame and
 * the process must keep reading subsequent frames.
 */
describe("RPC mode malformed stdin", () => {
	test("reports a bad line as an error frame and keeps serving subsequent commands", async () => {
		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const child = Bun.spawn(
			["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
			{
				cwd: path.join(import.meta.dir, ".."),
				env: { ...Bun.env, PI_NO_TITLE: "1" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		// A non-JSON line followed by a valid command. Pre-fix the first line
		// crashed the generator before the second was ever read.
		child.stdin.write("this is not json\n");
		child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
		await child.stdin.flush();

		let parseError: Record<string, unknown> | undefined;
		let stateResponse: Record<string, unknown> | undefined;

		for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
			if (!isRecord(frame)) continue;
			if (frame.type === "response" && frame.command === "parse" && frame.success === false) {
				parseError = frame;
			}
			if (frame.type === "response" && frame.id === "probe") {
				stateResponse = frame;
				break;
			}
		}

		child.stdin.end();
		child.kill();
		await child.exited.catch(() => {});

		expect(parseError).toBeDefined();
		expect(String(parseError?.error)).toContain("Failed to parse command");
		expect(stateResponse).toBeDefined();
		expect(stateResponse?.success).toBe(true);
	}, 30000);
});
