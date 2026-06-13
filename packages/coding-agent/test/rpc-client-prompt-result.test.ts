import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

const FAKE_RPC_SERVER = `
function writeFrame(frame: unknown): void {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}

writeFrame({ type: "ready" });
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line.length > 0) {
			const command = JSON.parse(line) as { type?: string; id?: string; message?: string };
			if (command.type === "prompt") {
				if (command.message === "immediate") {
					writeFrame({
						type: "response",
						command: "prompt",
						id: command.id,
						success: true,
						data: { agentInvoked: false },
					});
				} else {
					writeFrame({ type: "response", command: "prompt", id: command.id, success: true });
					setTimeout(() => {
						writeFrame({ type: "prompt_result", id: command.id, agentInvoked: false });
					}, 10);
				}
			}
		}
		newline = buffer.indexOf("\\n");
	}
}
`;

describe("RpcClient prompt completion", () => {
	test("waits for local-only prompt completions without agent_end", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-client-prompt-result-"));
		const serverPath = path.join(dir, "fake-rpc-server.ts");
		await Bun.write(serverPath, FAKE_RPC_SERVER);
		const client = new RpcClient({ cliPath: serverPath, cwd: dir });
		try {
			await client.start();

			await client.prompt("immediate");
			await client.waitForIdle(1000);

			const events = await client.promptAndWait("deferred", undefined, 1000);
			expect(events).toEqual([]);
		} finally {
			client.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
