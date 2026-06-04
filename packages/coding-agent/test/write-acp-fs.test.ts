import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

const FILE_CONTENT = "bridge write content\n";

interface SessionOptions {
	bridge?: ClientBridge;
	planMode?: PlanModeState;
}

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		getPlanModeState: options.planMode ? () => options.planMode : undefined,
	};
}

describe("write tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-acp-fs-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("routes plain text writes through the bridge and does not call Bun.write", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};

		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const bunWriteSpy = spyOn(Bun, "write");

		try {
			const session = createSession(tmpDir, { bridge });
			const tool = new WriteTool(session);

			await tool.execute("call-1", { path: filePath, content: FILE_CONTENT });

			// Bridge was called with the exact path and content
			expect(bridgeSpy).toHaveBeenCalledTimes(1);
			expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
			// Disk write must not have been called — bridge is the destination
			expect(bunWriteSpy).not.toHaveBeenCalled();
		} finally {
			bunWriteSpy.mockRestore();
		}
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const planContent = "# Plan\n\nhello world\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				throw new Error("Internal error");
			},
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-plan", { path: planPath, content: planContent });

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(
			await Bun.file(
				resolveLocalUrlToPath(planPath, {
					getArtifactsDir: session.getArtifactsDir,
					getSessionId: session.getSessionId,
				}),
			).text(),
		).toBe(planContent);
	});
});
