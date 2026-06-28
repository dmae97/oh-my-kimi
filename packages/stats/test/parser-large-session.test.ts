import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-large-session-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(tempDir.join("agent"));
});

afterEach(() => {
	vi.restoreAllMocks();
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

async function writeLargeSessionFile(): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--large-session");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const timestamp = new Date().toISOString();
	const payload = "x".repeat(16 * 1024);
	const lines: string[] = [];
	for (let i = 0; i < 256; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `assistant-${i}`,
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: payload }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now() + i,
					duration: 10,
					ttft: 5,
				},
			}),
		);
	}
	await Bun.write(sessionFile, `${lines.join("\n")}\n`);
	return sessionFile;
}

describe("large session parsing", () => {
	it("parses multi-megabyte JSONL without entering Bun.JSONL.parseChunk", async () => {
		const sessionFile = await writeLargeSessionFile();
		vi.spyOn(Bun.JSONL, "parseChunk").mockImplementation(() => {
			throw new Error("native JSONL parser unavailable");
		});

		const result = await parseSessionFile(sessionFile);

		expect(result.stats).toHaveLength(256);
		expect(result.newOffset).toBeGreaterThan(4 * 1024 * 1024);
	});
});
