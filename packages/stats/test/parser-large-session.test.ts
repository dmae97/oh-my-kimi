import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

describe("large session parsing", () => {
	it("parses a JSONL chunk with more entries than the JavaScript argument limit", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--large-session");
		await fs.mkdir(dir, { recursive: true });
		const sessionFile = path.join(dir, "large.jsonl");
		const entry = `${JSON.stringify({ type: "session", id: "s", timestamp: "2026-06-28T00:00:00.000Z", cwd: "/tmp" })}\n`;
		const entryCount = 700_000;
		await fs.writeFile(sessionFile, entry.repeat(entryCount));

		const result = await parseSessionFile(sessionFile);

		expect(result.newOffset).toBe(entry.length * entryCount - 1);
		expect(result.stats).toEqual([]);
		expect(result.userStats).toEqual([]);
		expect(result.userLinks).toEqual([]);
	});
});
